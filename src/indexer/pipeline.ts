/**
 * @module indexer/pipeline
 *
 * `IndexPipeline` decomposes the monolithic `IndexBuilder.build()` /
 * `IndexBuilder.update()` into ordered, testable stages.
 *
 * ## Stage ordering (data-dependency chain)
 *
 * ```
 * ScipSourceStage → SourceIndexStage → DocsIndexStage
 *   → ImportResolutionStage → DependencyApiStage
 *   → LspEnrichmentStage → ResolutionStage
 *   → TestMapStage → HistoryStage → EmbeddingStage
 * ```
 *
 * `ScipSourceStage` runs first for SCIP-covered languages, populating
 * symbols AND refs directly with pre-resolved edges.  `SourceIndexStage`
 * then handles remaining languages via tree-sitter.
 *
 * LSP enrichment is optional for both paths (adds type signatures to
 * SCIP-sourced symbols, enriches non-SCIP refs with definition data).
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
  /** Whether to auto-seed documentation notes. */
  docsAutoNotes: boolean;

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
   * Set by `ScipEnrichmentStage`; read by `LspEnrichmentStage` to skip
   * languages that don't need LSP fallback.
   */
  scipCoveredLanguages?: ReadonlySet<string>;

  /**
   * Languages fully sourced from SCIP (symbols + refs).
   * Set by `ScipSourceStage`; read by `SourceIndexStage` to skip
   * tree-sitter extraction for these languages, and by `LspEnrichmentStage`.
   */
  scipSourcedLanguages?: ReadonlySet<string>;

  /**
   * Absolute file paths sourced from SCIP.
   * Set by `ScipSourceStage`; read by `SourceIndexStage` to skip files.
   */
  scipSourcedFiles?: ReadonlySet<string>;
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

// ─── IndexPipeline ────────────────────────────────────────────────────────────

/**
 * Orchestrates a sequence of `PipelineStage` instances through a shared
 * `PipelineContext`.
 *
 * Replaces the god-method `IndexBuilder.build()` with a declarative,
 * composable pipeline whose ordering is enforced structurally.
 *
 * @example
 * ```ts
 * const pipeline = new IndexPipeline([
 *   new SourceIndexStage(),
 *   new DocsIndexStage(),
 *   new ImportResolutionStage(),
 *   new LspEnrichmentStage(),
 *   new ResolutionStage(),
 *   new EmbeddingStage(),
 * ]);
 * await pipeline.run(context, 'build');
 * ```
 */
export class IndexPipeline {
  private readonly stages: PipelineStage[];

  constructor(stages: PipelineStage[]) {
    this.stages = stages;
  }

  /**
   * Execute all stages in order.  If any stage throws, the remaining stages
   * are skipped but every stage's `dispose()` hook is still called.
   */
  async run(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    const log = context.log ?? getLogger();
    const startMs = performance.now();

    try {
      for (const stage of this.stages) {
        const stageStart = performance.now();
        log.indexing(`stage:${stage.name} started`);
        await stage.execute(context, mode);
        const durationMs = Math.round(performance.now() - stageStart);
        log.indexing(`stage:${stage.name} complete`, { durationMs });
      }
    } finally {
      // Always clean up, even on failure.
      for (const stage of this.stages) {
        if (stage.dispose) {
          try {
            await stage.dispose();
          } catch {
            /* best-effort cleanup */
          }
        }
      }

      const totalMs = Math.round(performance.now() - startMs);
      log.indexing('pipeline complete', { mode, totalStages: this.stages.length, durationMs: totalMs });
    }
  }

  /** Returns the ordered list of stage names (useful for introspection / tests). */
  get stageNames(): string[] {
    return this.stages.map(s => s.name);
  }
}
