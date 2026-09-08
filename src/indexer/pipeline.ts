/**
 * @module indexer/pipeline
 *
 * `IndexPipeline` decomposes the monolithic `IndexBuilder.build()` /
 * `IndexBuilder.update()` into ordered, testable stages.
 *
 * ## Stage ordering (data-dependency chain)
 *
 * ```
 * ScipIndexerStage → FileDiscoveryStage → LspExtractionStage
 *   → ImportResolutionStage
 *   → [LspEnrichmentStage + git-history]
 *   → symbol-resolution → ReverseDepsStage
 *   → EmbeddingStage → FtsRefreshStage
 * ```
 *
 * `ScipIndexerStage` runs only for baseline layers and writes compiler-derived
 * symbols, references, relationships, imports, and metadata. File discovery
 * then stores every remaining recognized source snapshot. LSP extraction
 * supplements eligible baseline files and provides changed-file overlay
 * structure.
 *
 * LSP enrichment is optional and precedes resolution of every still-unresolved
 * effective edge. Baseline validation and atomic generation promotion are
 * performed by `IndexBuilder` only after all pipeline stages succeed.
 */

import type { Database } from '../db/schema.js';
import type { WalkerConfig } from '../discovery/walker.js';
import type { EmbeddingProvider } from '../embeddings/embedder.js';
import type { EffectiveLspSettings } from '../lsp/config.js';
import type { EffectiveScipSettings } from '../scip/config.js';
import type { CompdbDiscoveryResult } from '../scip/compdb.js';
import type { ResponseFileLimits } from '../scip/compdb.js';
import type { LoreLogger } from '../logger.js';
import { getLogger } from '../logger.js';
import { deleteLoreMeta, setLoreMeta } from '../db/meta.js';

// ─── Stage interface ──────────────────────────────────────────────────────────

/**
 * Shared context bag that flows through every stage.
 * Stages read from and write to this object.
 */
export interface PipelineContext {
  /** Read-write database handle. */
  db: Database.Database;
  /** Persistent index_runs identifier for provenance emitted by stages. */
  runId?: string;
  /** Path to the SQLite file (needed for stages that re-open connections). */
  dbPath: string;
  /** Walker configuration (root dir, globs, etc.). */
  walkerConfig: WalkerConfig;
  /** Resolved branch name. */
  branch: string;
  /** Effective LSP settings (null = disabled). */
  lsp: EffectiveLspSettings | null;
  /** Effective SCIP settings (null = disabled). */
  scip: EffectiveScipSettings | null;
  /** Host-approved out-of-tree compilation/build roots. */
  approvedExternalBuildRoots?: readonly string[];
  /** Per-compilation-entry response-file budgets. */
  responseFileLimits?: Partial<ResponseFileLimits>;
  /** Optional embedding provider. */
  embedder: EmbeddingProvider | null;
  /** Logger instance. */
  log: LoreLogger;

  /**
   * Run-scoped, parsed compilation-database snapshot. `undefined` means it
   * has not been requested yet; a result with `database: null` is a cached
   * negative lookup. SCIP setup populates this when it already loaded the
   * database so later include resolution does not parse it again.
   */
  compilationDatabase?: CompdbDiscoveryResult;

  /** Optional cooperative cancellation signal for long-running stages. */
  signal?: AbortSignal;

  /** Optional absolute wall-clock deadline (milliseconds since epoch). */
  deadlineAt?: number;

  /** Assert that this process still owns the database-backed writer fence. */
  assertWriterLease?: () => void;

  /** Monotonic database-backed writer generation used by promotion helpers. */
  writerGeneration?: number;

  /**
   * Metadata changes produced by a hidden baseline generation. They are
   * applied only in the promotion transaction; failed generations discard
   * them without altering metadata for the previously promoted baseline.
   */
  stagedMetadata?: Map<string, string | null>;

  /** Name of the stage that most recently failed, retained for provenance. */
  failedStage?: string;

  /**
   * File list populated by FileDiscoveryStage.
   * In build mode: all walked files.
   * In update mode: only the changed files that were (re-)indexed.
   * Later stages (enrichment, resolution, embedding) iterate over this.
   */
  files: Array<{ path: string; language: string }>;

  /** Legacy hint that also adds TypeScript to active LSP-enrichment server selection. */
  indexDependencies: boolean;
  /** History ingestion policy. */
  history: boolean | { depth?: number; all?: boolean };

  // ── Update-mode fields (populated by stages during incremental updates) ──

  /**
   * Absolute paths of changed files supplied by the caller for incremental
   * updates.  Undefined in build mode.
   */
  changedFiles?: string[];

  /**
   * Symbol IDs whose embeddings should be removed (stale from deleted /
   * re-processed files).  Accumulated by FileDiscoveryStage in update mode.
   */
  staleSymbolIds: number[];

  /**
   * Paths of changed source files — used to look up new file IDs for
   * scoped embedding.  Accumulated by FileDiscoveryStage in update mode.
   */
  changedSourcePaths: string[];

  /**
   * Canonical paths whose effective row changed or was deleted. Unlike
   * `changedSourcePaths`, this also includes deleted/out-of-scope files.
   */
  affectedFilePaths?: string[];


  /**
   * Languages for which SCIP enrichment already provided data.
   * Set by `ScipIndexerStage`; read by `LspEnrichmentStage` to skip
   * languages that don't need LSP fallback.
   */
  scipCoveredLanguages?: ReadonlySet<string>;

  /**
   * Languages fully sourced from SCIP (symbols + refs).
   * Set by `ScipIndexerStage`; read by `FileDiscoveryStage` to skip
   * those languages, and by `LspEnrichmentStage`.
   */
  scipSourcedLanguages?: ReadonlySet<string>;

  /**
   * Absolute file paths sourced from SCIP.
   * Set by `ScipIndexerStage`; read by `FileDiscoveryStage` to skip files.
   */
  scipSourcedFiles?: ReadonlySet<string>;

  /**
   * In-memory cache of source file contents (path → source text).
    * Populated while FileDiscoveryStage / ScipIndexerStage load snapshots.
   * Later stages (LSP enrichment) read from here to
   * avoid redundant `readFileSync` calls.
   */
  sourceCache: Map<string, string>;

  /** Files already enriched by `LspExtractionStage` with its shared coordinator. */
  lspEnrichedFiles?: Set<string>;

  // ── Incremental (baseline + overlay) fields ───────────────────────────────

  /**
   * The layer that stages should write to:
   *  - `'baseline'` for full SCIP builds.
   *  - `'overlay'` for LSP incremental updates.
   */
  layer: 'baseline' | 'overlay';

  /**
   * Baseline generation counter produced by SCIP.
   * Baseline rows are written with this value.
   * Overlay rows always use `generation = 0`.
   */
  generation: number;

  /** Legacy parse-worker limit retained in context; no active stage consumes it. */
  maxWorkers?: number;
}

/**
 * A composable pipeline stage.
 *
 * Each stage receives the shared `PipelineContext`, performs its work, and
 * may mutate the context (e.g. populating `context.files`).
 */
export interface PipelineStage {
  /** Human-readable stage name (used in logging). */
  readonly name: string;

  /**
   * Execute this stage.
   *
   * @param context  Shared pipeline context.
   * @param mode     `'build'` for full builds, `'update'` for incremental.
   */
  execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void>;

  /**
   * Optional cleanup hook called after the pipeline finishes (success or
   * failure).  Stages can release resources here.
   */
  dispose?(): Promise<void>;
}

/** Throw between bounded units of work when a pipeline run was cancelled. */
export function throwIfPipelineCancelled(
  context: Pick<PipelineContext, 'signal' | 'deadlineAt' | 'assertWriterLease'>,
): void {
  context.assertWriterLease?.();
  if (context.signal?.aborted) {
    const reason = context.signal.reason;
    throw reason instanceof Error ? reason : new Error('Indexing cancelled');
  }
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    throw new Error('Indexing deadline exceeded');
  }
}

/** Write metadata immediately for overlays, or defer it for a hidden baseline. */
export function setPipelineLoreMeta(
  context: PipelineContext,
  key: string,
  value: string,
): void {
  if (context.stagedMetadata) context.stagedMetadata.set(key, value);
  else setLoreMeta(context.db, key, value);
}

/** Delete metadata immediately for overlays, or defer it for a hidden baseline. */
export function deletePipelineLoreMeta(context: PipelineContext, key: string): void {
  if (context.stagedMetadata) context.stagedMetadata.set(key, null);
  else deleteLoreMeta(context.db, key);
}

// ─── Pipeline entry ───────────────────────────────────────────────────────────

/**
 * A pipeline entry is either a single stage or an array of stages to run
 * concurrently.  Parallel stages must be independent (write to disjoint
 * tables, read disjoint inputs).
 */
export type PipelineEntry = PipelineStage | PipelineStage[];

// ─── IndexPipeline ────────────────────────────────────────────────────────────

/**
 * Orchestrates a sequence of `PipelineEntry` instances through a shared
 * `PipelineContext`.
 *
 * Each entry is either a single stage or an array of stages that run
 * concurrently.  Entries are executed in order; within a parallel group
 * all stages start simultaneously and the group completes when all finish.
 *
 * @example
 * ```ts
 * const pipeline = new IndexPipeline([
 *   new ScipIndexerStage(),
 *   new FileDiscoveryStage(),
 *   new ImportResolutionStage(),
 *   new EmbeddingStage(),
 * ]);
 * await pipeline.run(context, 'build');
 * ```
 */
export class IndexPipeline {
  private readonly entries: PipelineEntry[];

  constructor(entries: PipelineEntry[]) {
    this.entries = entries;
  }

  /**
   * Execute all entries in order.  If any stage throws, the remaining entries
   * are skipped but every stage's `dispose()` hook is still called.
   */
  async run(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    const log = context.log ?? getLogger();
    const startMs = performance.now();

    try {
      for (const entry of this.entries) {
        throwIfPipelineCancelled(context);
        const stages = Array.isArray(entry) ? entry : [entry];

        if (stages.length === 1) {
          // Single stage — run directly.
          const stage = stages[0]!;
          const stageStart = performance.now();
          log.indexing(`stage:${stage.name} started`);
          try {
            await stage.execute(context, mode);
          } catch (error) {
            context.failedStage = stage.name;
            throw error;
          }
          throwIfPipelineCancelled(context);
          const durationMs = Math.round(performance.now() - stageStart);
          log.indexing(`stage:${stage.name} complete`, { durationMs });
        } else {
          // Parallel group — run all concurrently.
          const groupNames = stages.map(s => s.name).join(', ');
          log.indexing(`stage-group started: [${groupNames}]`);
          const groupStart = performance.now();

          const priorSignal = context.signal;
          const groupController = new AbortController();
          context.signal = priorSignal
            ? AbortSignal.any([priorSignal, groupController.signal])
            : groupController.signal;
          let firstError: unknown;
          const settled = await Promise.allSettled(
            stages.map(async (stage) => {
              const stageStart = performance.now();
              log.indexing(`stage:${stage.name} started`);
              try {
                await stage.execute(context, mode);
                throwIfPipelineCancelled(context);
                const durationMs = Math.round(performance.now() - stageStart);
                log.indexing(`stage:${stage.name} complete`, { durationMs });
              } catch (error) {
                context.failedStage ??= stage.name;
                firstError ??= error;
                if (!groupController.signal.aborted) groupController.abort(error);
                throw error;
              }
            }),
          );
          context.signal = priorSignal;

          // `allSettled` is load-bearing: no stage may still access shared
          // context/database state when disposal and connection teardown begin.
          if (firstError !== undefined) throw firstError;
          const rejected = settled.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          );
          if (rejected) throw rejected.reason;

          const groupMs = Math.round(performance.now() - groupStart);
          log.indexing(`stage-group complete: [${groupNames}]`, { durationMs: groupMs });
        }
      }
    } finally {
      // Always clean up, even on failure.
      const allStages = this.entries.flatMap(e => Array.isArray(e) ? e : [e]);
      for (const stage of allStages) {
        if (stage.dispose) {
          try {
            await stage.dispose();
          } catch {
            /* best-effort cleanup */
          }
        }
      }

      const totalMs = Math.round(performance.now() - startMs);
      const stageCount = this.entries.flatMap(e => Array.isArray(e) ? e : [e]).length;
      log.indexing('pipeline complete', { mode, totalStages: stageCount, durationMs: totalMs });
    }
  }

  /** Returns the ordered list of stage names (useful for introspection / tests). */
  get stageNames(): string[] {
    return this.entries.flatMap(e => Array.isArray(e) ? e.map(s => s.name) : [e.name]);
  }
}
