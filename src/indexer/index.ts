/**
 * @module indexer/index
 *
 * The `IndexBuilder` class is a **façade** over the composable
 * `IndexPipeline` and its stage objects.
 *
 * For full builds, `build()` delegates entirely to the pipeline which
 * enforces the data-dependency chain:
 * ```
 * ScipIndexerStage → FileDiscoveryStage
 *   → ImportResolutionStage
 *   → LspEnrichmentStage → ResolutionStage
 *   → HistoryStage → EmbeddingStage
 * ```
 *
 * `ScipIndexerStage` populates structural data (symbols, refs) and
 * enrichment metadata (type signatures, definition locations) in a
 * single pass.  `FileDiscoveryStage` then walks remaining files and
 * populates the source cache.
 *
 * The enrichment → resolution ordering is **load-bearing** and enforced
 * structurally by the pipeline rather than by call-site discipline.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  openDb,
  setLoreMeta,
  getGeneration,
  incrementGeneration,
  LORE_META_LAST_HEAD_SHA,
  LORE_META_GENERATION,
  LORE_META_GENERATION_PENDING,
  deleteLoreMeta,
  LORE_META_BASELINE_HEAD_SHA,
} from '../db/schema.js';
import type { Database } from '../db/schema.js';
import type { WalkerConfig } from '../discovery/walker.js';
import type { EmbeddingProvider } from '../embeddings/embedder.js';
import { DEFAULT_EMBEDDING_MODEL } from '../embeddings/embedder.js';
import type { EffectiveLspSettings } from '../lsp/config.js';
import type { EffectiveScipSettings } from '../scip/config.js';
import { resolveSymbolEdges } from '../resolution/call-graph.js';
import { ingestGitHistory } from '../git/history.js';
import { getLogger } from '../logger.js';
import { IndexPipeline } from './pipeline.js';
import type { PipelineContext, PipelineStage } from './pipeline.js';
import { ByteBudgetLRU } from './byte-budget-lru.js';
import {
  ScipIndexerStage,
  FileDiscoveryStage,
  LspExtractionStage,
  ImportResolutionStage,
  LspEnrichmentStage,
  EmbeddingStage,
  ReverseDepsStage,
  OverlayCleanupStage,
} from './stages/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IndexBuilderOptions {
  history?: boolean | { depth?: number; all?: boolean };
  embeddingModel?: string;
  indexDependencies?: boolean;
  lsp?: EffectiveLspSettings;
  scip?: EffectiveScipSettings;
  maxWorkers?: number;
}

// ─── IndexBuilder (façade) ────────────────────────────────────────────────────

/**
 * Façade over the composable `IndexPipeline`.
 *
 * Preserves backward-compatible public API while internally delegating to
 * pipeline stages for the actual work.
 *
 * @example
 * ```ts
 * const builder = new IndexBuilder('/path/to/lore.db', { rootDir: '/path/to/src' });
 * await builder.build();
 * ```
 */
export class IndexBuilder {
  private readonly dbPath: string;
  private readonly walkerConfig: WalkerConfig;
  private readonly embedder: EmbeddingProvider | null;
  private readonly history: boolean | { depth?: number; all?: boolean };
  private readonly indexDependencies: boolean;
  private readonly embeddingModel: string;
  private readonly lspSettings: EffectiveLspSettings | null;
  private readonly scipSettings: EffectiveScipSettings | null;
  private readonly maxWorkers: number | undefined;

  /** Process-local mutex: queued promise chain prevents concurrent build/update/rebuild. */
  private _mutexChain: Promise<void> = Promise.resolve();

  constructor(
    dbPath: string,
    walkerConfig: WalkerConfig,
    embedder?: EmbeddingProvider,
    embeddingModelOrOptions?: string | IndexBuilderOptions,
  ) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;

    const opts =
      typeof embeddingModelOrOptions === 'string'
        ? { embeddingModel: embeddingModelOrOptions }
        : (embeddingModelOrOptions ?? {});

    if (embedder) {
      this.embedder = embedder;
      this.embeddingModel = embedder.modelName;
    } else {
      this.embeddingModel = opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
      this.embedder = null;
    }

    this.history = opts.history ?? false;
    this.indexDependencies = opts.indexDependencies ?? false;
    this.lspSettings = opts.lsp ?? null;
    this.scipSettings = opts.scip ?? null;
    this.maxWorkers = opts.maxWorkers;
  }

  // ─── Build mode discriminated union ──────────────────────────────────────

  /** Describes which kind of index run to perform. */

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Enqueue `fn` on the mutex chain so build/update/rebuild never overlap. */
  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._mutexChain.then(fn, fn);
    // Keep the chain alive regardless of success/failure of `fn`.
    this._mutexChain = next.then(() => {}, () => {});
    return next;
  }

  /**
   * Performs a full build by running the composable pipeline.
   *
   * The pipeline enforces the enrichment → resolution data-dependency
   * chain structurally (by stage ordering), not by convention.
   */
  async build(): Promise<void> {
    return this._enqueue(() => this._run({ kind: 'build' }));
  }

  /**
   * Incrementally re-processes only the listed files using the overlay layer.
   *
   * @param changedFiles  Absolute paths of files that have changed.
   */
  async update(changedFiles: string[]): Promise<void> {
    return this._enqueue(() => this._run({ kind: 'update', changedFiles }));
  }

  /**
   * Perform a background baseline rebuild (SCIP reconciliation).
   *
   * Writes to a new generation, then atomically promotes and cleans
   * stale overlay rows.
   */
  async baselineRebuild(): Promise<void> {
    return this._enqueue(() => this._run({ kind: 'rebuild' }));
  }

  // ─── Unified run implementation ─────────────────────────────────────────

  private async _run(
    mode: { kind: 'build' } | { kind: 'update'; changedFiles: string[] } | { kind: 'rebuild' },
  ): Promise<void> {
    const log = getLogger();
    const startTime = performance.now();
    const db = openDb(this.dbPath);
    const branch = this.resolveBranch();

    // ── Mode-specific setup ──────────────────────────────────────────────
    let layer: 'baseline' | 'overlay';
    let generation: number;
    let rebuildStartedAt: number | undefined;

    if (mode.kind === 'update') {
      layer = 'overlay';
      generation = 0;
    } else {
      layer = 'baseline';
      generation = incrementGeneration(db);
    }

    if (mode.kind === 'rebuild') {
      rebuildStartedAt = Math.floor(Date.now() / 1000);
      setLoreMeta(db, LORE_META_GENERATION_PENDING, String(generation));
      log.indexing('baseline rebuild started', { generation });
    } else if (mode.kind === 'build') {
      log.indexing('build started', { dbPath: this.dbPath, branch, rootDir: this.walkerConfig.rootDir });
    }

    // ── Pipeline stages ──────────────────────────────────────────────────
    // All three modes share the same core stage sequence.
    // Rebuild omits ReverseDepsStage and appends OverlayCleanupStage.
    const stages: (PipelineStage | PipelineStage[])[] = [
      new ScipIndexerStage(),
      new FileDiscoveryStage(),
      new LspExtractionStage(),
      new ImportResolutionStage(),
      [new LspEnrichmentStage(), historyStage()],
      ftsRefreshStage(),
      resolutionStage(),
    ];

    if (mode.kind !== 'rebuild') {
      stages.push(new ReverseDepsStage());
    }

    stages.push(new EmbeddingStage());

    if (mode.kind === 'rebuild') {
      stages.push(
        new OverlayCleanupStage({
          newGeneration: generation,
          rebuildStartedAt: rebuildStartedAt!,
          headSha: this.readGitValue(['rev-parse', 'HEAD']),
        }),
      );
    }

    const pipeline = new IndexPipeline(stages);

    // ── Pipeline context ─────────────────────────────────────────────────
    const context: PipelineContext = {
      db,
      dbPath: this.dbPath,
      walkerConfig: this.walkerConfig,
      branch,
      lsp: this.lspSettings,
      scip: this.scipSettings,
      embedder: this.embedder,
      log,
      files: [],
      indexDependencies: this.indexDependencies,
      history: this.history,
      staleSymbolIds: [],
      changedSourcePaths: [],
      sourceCache: new ByteBudgetLRU(),
      layer,
      generation,
      ...(mode.kind === 'update' && { changedFiles: mode.changedFiles }),
      ...(this.maxWorkers !== undefined && { maxWorkers: this.maxWorkers }),
    };

    const pipelineLabel = mode.kind === 'update' ? 'update' : 'build';

    try {
      await pipeline.run(context, pipelineLabel);
      this.saveLastKnownHead(db);

      // ── Mode-specific post-run ───────────────────────────────────────
      if (mode.kind === 'build') {
        const stats = this.gatherDbStats(db);
        const indexDurationMs = Math.round(performance.now() - startTime);
        log.startup('indexing complete', {
          dbPath: this.dbPath,
          dbSizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : undefined,
          embeddingModel: this.embeddingModel,
          embeddingReady: !!this.embedder,
          totalFiles: context.files.length,
          ...stats,
          indexDurationMs,
        });
      } else if (mode.kind === 'rebuild') {
        deleteLoreMeta(db, LORE_META_GENERATION_PENDING);
        const indexDurationMs = Math.round(performance.now() - startTime);
        log.indexing('baseline rebuild complete', { generation, durationMs: indexDurationMs });
      }
    } finally {
      db.close();
    }
  }

  /**
   * Writes an LLM-generated summary for a symbol to `symbol_summaries`.
   */
  async ingestSummary(symbolId: number, summary: string, model = 'unknown'): Promise<void> {
    const db = openDb(this.dbPath);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO symbol_summaries (symbol_id, summary, model)
         VALUES (?, ?, ?)`,
      ).run(symbolId, summary, model);

      if (this.embedder) {
        const [[embedding]] = await Promise.all([this.embedder.embed([summary])]);
        db.prepare(
          'INSERT OR REPLACE INTO symbol_semantic_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
        ).run(symbolId, JSON.stringify(embedding));
      }
    } finally {
      db.close();
    }
  }

  // ─── Private helpers (minimal — most logic lives in stages) ─────────────

  private resolveBranch(): string {
    if (this.walkerConfig.branch) return this.walkerConfig.branch;
    return this.readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
  }

  private saveLastKnownHead(db: Database.Database): void {
    const headSha = this.readGitValue(['rev-parse', 'HEAD']);
    if (headSha) setLoreMeta(db, LORE_META_LAST_HEAD_SHA, headSha);
  }

  private readGitValue(args: string[]): string | undefined {
    try {
      return execFileSync(
        'git',
        ['-C', this.walkerConfig.rootDir, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private gatherDbStats(db: Database.Database): Record<string, unknown> {
    let totalSymbols = 0;
    try { totalSymbols = (db.prepare('SELECT COUNT(*) AS cnt FROM symbols').get() as { cnt: number }).cnt; } catch { /* */ }
    let totalEdges = 0;
    try { totalEdges = (db.prepare('SELECT COUNT(*) AS cnt FROM symbol_refs').get() as { cnt: number }).cnt; } catch { /* */ }
    let commitCount: number | undefined;
    try { commitCount = (db.prepare('SELECT COUNT(*) AS cnt FROM commits').get() as { cnt: number }).cnt; } catch { /* */ }
    return { totalSymbols, totalEdges, commitCount };
  }
}

// ─── Trivial inline stages ────────────────────────────────────────────────────
// These are single-function-call stages that don't warrant their own files.

/** Resolve symbol edges (must run after LspEnrichmentStage). */
function resolutionStage(): PipelineStage {
  return {
    name: 'symbol-resolution',
    execute: async (ctx) => {
      resolveSymbolEdges(ctx.db, { overlayOnly: ctx.layer === 'overlay', branch: ctx.branch });
    },
  };
}


/**
 * Bulk-refresh the FTS5 index from the enriched `symbols` table.
 *
 * Replaces per-row FTS5 updates during enrichment with a single pass,
 * which is substantially faster for FTS5 virtual tables.
 */
function ftsRefreshStage(): PipelineStage {
  return {
    name: 'fts-refresh',
    execute: async (ctx) => {
      ctx.db.transaction(() => {
        ctx.db.exec('DELETE FROM symbols_fts');
        // Use effective_symbols view to index only the active layer's symbols
        ctx.db.exec(`
          INSERT INTO symbols_fts(rowid, name, signature, kind)
          SELECT s.id,
                 s.name,
                 COALESCE(s.resolved_type_signature, '') || char(10) ||
                 COALESCE(s.resolved_return_type, '')    || char(10) ||
                 COALESCE(s.signature, '')                || char(10) ||
                 s.name,
                 s.kind
          FROM effective_symbols s
        `);
      })();
    },
  };
}

/** Ingest git history. */
function historyStage(): PipelineStage {
  return {
    name: 'git-history',
    execute: async (ctx) => {
      if (!ctx.history) return;
      ctx.log.indexing('git history ingestion started');
      const opts = typeof ctx.history === 'object' ? ctx.history : undefined;
      await ingestGitHistory(ctx.db, ctx.walkerConfig.rootDir, opts);
      ctx.log.indexing('git history ingestion complete');
    },
  };
}
