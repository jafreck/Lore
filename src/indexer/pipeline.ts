/**
 * @module indexer/pipeline
 *
 * `IndexPipeline` decomposes the monolithic `IndexBuilder.build()` /
 * `IndexBuilder.update()` into ordered, testable stages.
 *
 * ## Stage ordering (data-dependency chain)
 *
 * ```
 * ScipIndexerStage → SourceIndexStage → DocsIndexStage
 *   → ImportResolutionStage → DependencyApiStage
 *   → LspEnrichmentStage → ResolutionStage
 *   → TestMapStage → HistoryStage → EmbeddingStage
 * ```
 *
 * `ScipIndexerStage` runs first for SCIP-covered languages, populating
 * symbols AND refs directly with pre-resolved edges and enrichment
 * metadata (type signatures, definition locations) in a single pass.
 * `SourceIndexStage` then adds tree-sitter metrics (complexity, nesting)
 * to SCIP-sourced files and handles remaining languages.
 *
 * LSP enrichment is optional (enriches non-SCIP refs with definition data).
 *
 * The resolution stage only processes refs that are still `unresolved`
 * (i.e. non-SCIP languages without LSP enrichment).
 */

import type { Database } from '../db/schema.js';
import type { WalkerConfig } from '../discovery/walker.js';
import type { EmbeddingProvider } from '../embeddings/embedder.js';
import type { EffectiveLspSettings } from '../lsp/config.js';
import type { EffectiveScipSettings } from '../scip/config.js';
import type { LoreLogger } from '../logger.js';
import { getLogger } from '../logger.js';

// ─── Stage interface ──────────────────────────────────────────────────────────

/**
 * Shared context bag that flows through every stage.
 * Stages read from and write to this object.
 */
export interface PipelineContext {
  /** Read-write database handle. */
  db: Database.Database;
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
  /** Optional embedding provider. */
  embedder: EmbeddingProvider | null;
  /** Logger instance. */
  log: LoreLogger;

  /**
   * File list populated by SourceIndexStage.
   * In build mode: all walked files.
   * In update mode: only the changed files that were (re-)indexed.
   * Later stages (enrichment, resolution, embedding) iterate over this.
   */
  files: Array<{ path: string; language: string }>;

  /** Whether to index dependency declarations (.d.ts, etc.). */
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
   * re-processed files).  Accumulated by SourceIndexStage in update mode.
   */
  staleSymbolIds: number[];

  /**
   * Paths of changed source files — used to look up new file IDs for
   * scoped embedding.  Accumulated by SourceIndexStage in update mode.
   */
  changedSourcePaths: string[];

  /**
   * Paths of changed doc files — used to look up new doc IDs for scoped
   * embedding.  Accumulated by DocsIndexStage in update mode.
   */
  changedDocPaths: string[];

  /**
   * Languages for which SCIP enrichment already provided data.
   * Set by `ScipIndexerStage`; read by `LspEnrichmentStage` to skip
   * languages that don't need LSP fallback.
   */
  scipCoveredLanguages?: ReadonlySet<string>;

  /**
   * Languages fully sourced from SCIP (symbols + refs).
   * Set by `ScipIndexerStage`; read by `SourceIndexStage` to skip
   * tree-sitter extraction for these languages, and by `LspEnrichmentStage`.
   */
  scipSourcedLanguages?: ReadonlySet<string>;

  /**
   * Absolute file paths sourced from SCIP.
   * Set by `ScipIndexerStage`; read by `SourceIndexStage` to skip files.
   */
  scipSourcedFiles?: ReadonlySet<string>;

  /**
   * In-memory cache of source file contents (path → source text).
   * Populated by SourceIndexStage / ScipIndexerStage during parsing.
   * Later stages (LSP enrichment) read from here to
   * avoid redundant `readFileSync` calls.
   */
  sourceCache: Map<string, string>;

  // ── Incremental (baseline + overlay) fields ───────────────────────────────

  /**
   * The layer that stages should write to:
   *  - `'baseline'` for full SCIP builds.
   *  - `'overlay'` for tree-sitter + LSP incremental updates.
   */
  layer: 'baseline' | 'overlay';

  /**
   * Baseline generation counter produced by SCIP.
   * Baseline rows are written with this value.
   * Overlay rows always use `generation = 0`.
   */
  generation: number;

  /**
   * SCIP ref data stashed by `ScipIndexerStage` for deferred processing.
   *
   * The SCIP stage inserts symbols (Pass 1) but defers ref insertion
   * until after `SourceIndexStage` patches symbol `end_line` values
   * with accurate tree-sitter spans.  `ScipRefStage` then reads this
   * data (Pass 2+3+4) to build the containment index and insert refs.
   */
  scipRefData?: {
    /** SCIP symbol → Lore DB symbol ID */
    scipToLoreId: Map<string, number>;
    /** SCIP symbol → definition location */
    symbolDefinitions: Map<string, { filePath: string; line: number; character: number }>;
    /** SCIP symbol → SymbolInformation (docs, display name) */
    symbolInfoMap: Map<string, unknown>;
    /** Absolute path → file_id */
    fileIdMap: Map<string, number>;
    /** Raw SCIP documents (occurrences + symbols) */
    documents: unknown[];
    /** Internal package prefixes for external-symbol detection */
    isExternalSymbol: (sym: string) => boolean;
  };
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
 *   [new SourceIndexStage(), new DocsIndexStage()],  // run in parallel
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
        const stages = Array.isArray(entry) ? entry : [entry];

        if (stages.length === 1) {
          // Single stage — run directly.
          const stage = stages[0]!;
          const stageStart = performance.now();
          log.indexing(`stage:${stage.name} started`);
          await stage.execute(context, mode);
          const durationMs = Math.round(performance.now() - stageStart);
          log.indexing(`stage:${stage.name} complete`, { durationMs });
        } else {
          // Parallel group — run all concurrently.
          const groupNames = stages.map(s => s.name).join(', ');
          log.indexing(`stage-group started: [${groupNames}]`);
          const groupStart = performance.now();

          await Promise.all(
            stages.map(async (stage) => {
              const stageStart = performance.now();
              log.indexing(`stage:${stage.name} started`);
              await stage.execute(context, mode);
              const durationMs = Math.round(performance.now() - stageStart);
              log.indexing(`stage:${stage.name} complete`, { durationMs });
            }),
          );

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
