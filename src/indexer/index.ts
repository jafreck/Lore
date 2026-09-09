/**
 * @module indexer/index
 *
 * The `IndexBuilder` class is a **façade** over the composable
 * `IndexPipeline` and its stage objects.
 *
 * Every build, rebuild, and overlay update uses this stage order:
 * ```
 * ScipIndexerStage → FileDiscoveryStage → LspExtractionStage
 *   → ImportResolutionStage
 *   → [LspEnrichmentStage + git-history]
 *   → symbol-resolution → ReverseDepsStage
 *   → EmbeddingStage → FtsRefreshStage
 * ```
 *
 * Individual stages branch on the current layer. `ScipIndexerStage` writes
 * baseline structural data only. `LspExtractionStage` performs bounded
 * baseline supplementation and changed-file overlay extraction. Baseline
 * validation and atomic generation promotion happen after the pipeline;
 * promotion is not a pipeline stage.
 *
 * Extraction → enrichment → resolution → reverse-dependency → derived-index
 * ordering is load-bearing and enforced structurally by the pipeline.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  clearPendingBaselineGeneration,
  getLoreMeta,
  openDb,
  reserveBaselineGeneration,
  setLoreMeta,
  LORE_META_LAST_HEAD_SHA,
  beginIndexRun,
  finishIndexRun,
  recordIndexerRun,
} from '../db/schema.js';
import type { Database } from '../db/schema.js';
import { walkFiles, type WalkerConfig } from '../discovery/walker.js';
import type { EmbeddingProvider } from '../embeddings/embedder.js';
import { DEFAULT_EMBEDDING_MODEL, LazyEmbeddingProvider } from '../embeddings/embedder.js';
import {
  loadLspSettingsFromLoreConfig,
  resolveEffectiveLspSettings,
  type EffectiveLspSettings,
  type LspSettingsOverrides,
} from '../lsp/config.js';
import {
  loadScipSettingsFromLoreConfig,
  resolveEffectiveScipSettings,
  type EffectiveScipSettings,
  type ScipSettingsOverrides,
} from '../scip/config.js';
import {
  resolveIndexExecutionPolicy,
  type IndexExecutionOptions,
  type ResolvedIndexExecutionPolicy,
} from '../execution-policy.js';
import { resolveSymbolEdges } from '../resolution/call-graph.js';
import { ingestGitHistory } from '../git/history.js';
import { getLogger } from '../logger.js';
import { IndexPipeline } from './pipeline.js';
import type { PipelineContext, PipelineStage } from './pipeline.js';
import { ByteBudgetLRU } from './byte-budget-lru.js';
import {
  loadValidationPolicyFromLoreConfig,
  resolveIndexValidationPolicy,
  type IndexValidationPolicy,
  type ResolvedIndexValidationPolicy,
  type ValidationProfile,
} from '../validation/config.js';
import {
  IndexValidationError,
  validateIndex,
  type IndexHealthReport,
} from '../validation/index-health.js';
import {
  ScipIndexerStage,
  FileDiscoveryStage,
  LspExtractionStage,
  ImportResolutionStage,
  LspEnrichmentStage,
  EmbeddingStage,
  FtsRefreshStage,
  ReverseDepsStage,
} from './stages/index.js';
import {
  applyBaselinePromotion,
  cleanupFailedBaselineGeneration,
  cleanupSupersededBaselineRows,
} from './stages/overlay-cleanup.js';
import { collectRefreshChanges, resolveIndexBranch } from './refresh.js';
import { withDbWriter, type DbWriterLease } from './writer-queue.js';
import {
  dropStagingEffectiveViews,
  installStagingEffectiveViews,
} from './staging-views.js';
import { discoverCompilationDatabase, type ResponseFileLimits } from '../scip/compdb.js';
import { canonicalScopeRequest, resolveScipScope, type ResolvedScipScope, type ScipScope } from '../scip/scope.js';
import { resolve } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IndexBuilderOptions {
  history?: boolean | { depth?: number; all?: boolean };
  /** Explicit embedding policy. `false` also disables persisted model reuse. */
  embeddings?: boolean;
  embeddingModel?: string;
  indexDependencies?: boolean;
  /** `false` disables LSP; an object is merged over repository/default settings. */
  lsp?: boolean | LspSettingsOverrides | EffectiveLspSettings;
  /** `false` disables SCIP; an object is merged over repository/default settings. */
  scip?: boolean | ScipSettingsOverrides | EffectiveScipSettings;
  /** Host-owned file/language scope, intersected with WalkerConfig; grants no execution. */
  scipScope?: ScipScope;
  /** Host-trusted execution capabilities. Never loaded from `.lore.config`. */
  execution?: IndexExecutionOptions;
  maxWorkers?: number;
  /** Cooperatively cancel indexing between bounded batches and subprocesses. */
  signal?: AbortSignal;
  /** Optional timeout for the complete pipeline run, in milliseconds. */
  pipelineTimeoutMs?: number;
  /** Validate after each completed run; `false` explicitly disables repository policy. */
  validation?: IndexValidationPolicy | ValidationProfile | false;
  /** Compilation response-file budgets, applied independently to each entry. */
  responseFileLimits?: Partial<ResponseFileLimits>;
}

/** Resolved settings snapshot used by one builder instance. */
export interface ResolvedIndexBuilderConfiguration {
  lsp: EffectiveLspSettings | null;
  scip: EffectiveScipSettings | null;
  scipScope: ScipScope | null;
  execution: ResolvedIndexExecutionPolicy;
  validation: ResolvedIndexValidationPolicy | null;
}

// ─── IndexBuilder (façade) ────────────────────────────────────────────────────

/**
 * Façade over the composable `IndexPipeline`.
 *
 * Exposes indexing operations while delegating their work to pipeline stages.
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
  private readonly embeddings: boolean | undefined;
  private readonly embeddingModel: string | null;
  private readonly options: IndexBuilderOptions;
  private readonly maxWorkers: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly pipelineTimeoutMs: number | undefined;
  private _resolvedConfiguration: ResolvedIndexBuilderConfiguration | null = null;
  private _lastValidationReport: IndexHealthReport | null = null;

  constructor(
    dbPath: string,
    walkerConfig: WalkerConfig,
    embedder?: EmbeddingProvider,
    embeddingModelOrOptions?: string | IndexBuilderOptions,
  ) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;

    const opts: IndexBuilderOptions =
      typeof embeddingModelOrOptions === 'string'
        ? { embeddingModel: embeddingModelOrOptions }
        : (embeddingModelOrOptions ?? {});
    this.options = opts;

    if (embedder) {
      this.embedder = embedder;
      this.embeddingModel = embedder.modelName;
    } else {
      this.embeddingModel = opts.embeddingModel ?? null;
      this.embedder = null;
    }

    this.history = opts.history ?? false;
    this.indexDependencies = opts.indexDependencies ?? false;
    this.embeddings = opts.embeddings;
    this.maxWorkers = opts.maxWorkers;
    this.signal = opts.signal;
    this.pipelineTimeoutMs = opts.pipelineTimeoutMs !== undefined
      && Number.isFinite(opts.pipelineTimeoutMs)
      && opts.pipelineTimeoutMs > 0
      ? opts.pipelineTimeoutMs
      : undefined;
  }

  // ─── Build mode discriminated union ──────────────────────────────────────

  /** Describes which kind of index run to perform. */

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Enqueue `fn` on the process-wide queue for this database path. */
  private _enqueue<T>(fn: (lease: DbWriterLease | null) => Promise<T>): Promise<T> {
    return withDbWriter(this.dbPath, fn);
  }

  /**
   * Resolve repository requests and explicit overrides without opening a DB.
   * Filesystem/config errors are intentionally deferred here rather than being
   * thrown by the constructor. The result is cached for this builder instance.
   */
  async resolveConfiguration(): Promise<ResolvedIndexBuilderConfiguration> {
    if (this._resolvedConfiguration) return this._resolvedConfiguration;

    const execution = resolveIndexExecutionPolicy(this.options.execution);
    const lsp = this.options.lsp === false
      ? null
      : resolveEffectiveLspSettings(
          loadLspSettingsFromLoreConfig(this.walkerConfig.rootDir),
          toLspOverrides(this.options.lsp),
          this.options.execution,
        );
    const scip = this.options.scip === false
      ? null
      : resolveEffectiveScipSettings(
          loadScipSettingsFromLoreConfig(this.walkerConfig.rootDir),
          toScipOverrides(this.options.scip),
          this.options.execution,
        );
    const scipScope = this.options.scipScope ? canonicalScopeRequest(this.options.scipScope) : null;
    const configuredValidation = this.options.validation === false || scipScope !== null
      ? undefined
      : loadValidationPolicyFromLoreConfig(this.walkerConfig.rootDir);
    const explicitValidation = typeof this.options.validation === 'string'
      ? { profile: this.options.validation }
      : this.options.validation === false || this.options.validation === undefined
        ? {}
        : this.options.validation;
    const validation = this.options.validation === false
      ? null
      : configuredValidation !== undefined || this.options.validation !== undefined
        ? resolveIndexValidationPolicy(configuredValidation, explicitValidation)
        : null;

    this._resolvedConfiguration = { lsp, scip, scipScope, execution, validation };
    return this._resolvedConfiguration;
  }

  /**
   * Performs a full build by running the composable pipeline.
   *
   * The pipeline enforces the enrichment → resolution data-dependency
   * chain structurally (by stage ordering), not by convention.
   */
  async build(): Promise<void> {
    return this._enqueue((lease) => this._run({ kind: 'build' }, lease));
  }

  /**
   * Incrementally re-processes only the listed files using the overlay layer.
   *
   * @param changedFiles  Absolute paths of files that have changed.
   */
  async update(changedFiles: string[]): Promise<void> {
    return this._enqueue((lease) => this._run({ kind: 'update', changedFiles }, lease));
  }

  /**
   * Perform a background baseline rebuild (SCIP reconciliation).
   *
   * Writes to a new generation, then atomically promotes and cleans
   * stale overlay rows.
   */
  async baselineRebuild(): Promise<void> {
    return this._enqueue((lease) => this._run({ kind: 'rebuild' }, lease));
  }

  /**
   * Hash the configured filesystem scope and overlay only paths whose content
   * actually changed (plus indexed paths that were deleted).
   */
  async refresh(): Promise<string[]> {
    return this._enqueue(async (lease) => {
      const configuration = await this.resolveConfiguration();
      const scipScope = await this.resolveRunScipScope(configuration);
      const db = openDb(this.dbPath);
      const branch = this.resolveBranch();
      let changedFiles: string[];
      let hasBaseline: boolean;
      try {
        changedFiles = await collectRefreshChanges(db, this.walkerConfig, branch, {
          selectedFiles: scipScope?.effectiveFiles.map(file => ({
            ...file, path: resolve(scipScope.rootDir, file.path),
          })),
          ...(this.signal && { signal: this.signal }),
          ...(this.pipelineTimeoutMs !== undefined && {
            deadlineAt: Date.now() + this.pipelineTimeoutMs,
          }),
        });
        hasBaseline = Boolean(db.prepare(
          `SELECT 1 AS present
             FROM baseline_generations
            WHERE branch = ?
            LIMIT 1`,
        ).get(branch));
      } finally {
        db.close();
      }

      if (!hasBaseline) {
        await this._run({ kind: 'build' }, lease);
      } else if (changedFiles.length > 0) {
        await this._run({ kind: 'update', changedFiles }, lease);
      }
      return changedFiles;
    });
  }

  /** The report produced by the most recent policy-enforced run. */
  get lastValidationReport(): IndexHealthReport | null {
    return this._lastValidationReport;
  }

  /** Run the public doctor API against this builder's database. */
  validate(policy: IndexValidationPolicy | ValidationProfile = {}): IndexHealthReport {
    return validateIndex(this.dbPath, {
      rootDir: this.walkerConfig.rootDir,
      scipScope: this.options.scipScope,
      walkerConfig: this.walkerConfig,
      policy: typeof policy === 'string' ? { profile: policy } : policy,
    });
  }

  // ─── Unified run implementation ─────────────────────────────────────────

  private async resolveRunScipScope(
    configuration: ResolvedIndexBuilderConfiguration,
  ): Promise<ResolvedScipScope | undefined> {
    if (!configuration.scipScope) return undefined;
    return resolveScipScope(this.walkerConfig, configuration.scipScope, await walkFiles(this.walkerConfig, {
      compilationDatabase: discoverCompilationDatabase(this.walkerConfig.rootDir, undefined, {
        approvedExternalRoots: configuration.execution.allowedCwdRoots,
        responseFileLimits: this.options.responseFileLimits,
      }).database,
    }));
  }

  private async _run(
    mode: { kind: 'build' } | { kind: 'update'; changedFiles: string[] } | { kind: 'rebuild' },
    writerLease: DbWriterLease | null,
  ): Promise<void> {
    const configuration = await this.resolveConfiguration();
    const { lsp: lspSettings, scip: scipSettings, validation: validationPolicy } = configuration;
    const log = getLogger();
    const startTime = performance.now();
    const scipScope = await this.resolveRunScipScope(configuration);
    const db = openDb(this.dbPath);
    writerLease?.assertCurrent(db);
    const runEmbedder = this.resolveRunEmbedder(db);
    const branch = this.resolveBranch();
    const timeoutSignal = this.pipelineTimeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(this.pipelineTimeoutMs);
    const runSignal = this.signal && timeoutSignal
      ? AbortSignal.any([this.signal, timeoutSignal])
      : (this.signal ?? timeoutSignal);

    // ── Mode-specific setup ──────────────────────────────────────────────
    let layer: 'baseline' | 'overlay';
    let generation: number;
    const baselineRun = mode.kind !== 'update';
    const rebuildStartedAt = Math.floor(Date.now() / 1000);
    const baselineHeadSha = baselineRun
      ? this.readGitValue(['rev-parse', 'HEAD'])
      : undefined;

    if (mode.kind === 'update') {
      layer = 'overlay';
      generation = 0;
    } else {
      layer = 'baseline';
      generation = reserveBaselineGeneration(db, branch, writerLease?.generation);
    }

    if (mode.kind === 'rebuild') {
      log.indexing('baseline rebuild started', { generation });
    } else if (mode.kind === 'build') {
      log.indexing('build started', {
        dbPath: this.dbPath,
        branch,
        generation,
        rootDir: this.walkerConfig.rootDir,
      });
    }

    const runId = beginIndexRun(db, {
      mode: mode.kind,
      rootDir: resolvePath(this.walkerConfig.rootDir),
      branch,
      layer,
      generation,
      config: {
        includeGlobs: this.walkerConfig.includeGlobs ?? ['**/*'],
        excludeGlobs: this.walkerConfig.excludeGlobs ?? [],
        extensions: this.walkerConfig.extensions ?? null,
        scipScope: scipScope ?? null,
        scip: scipSettings ? {
          enabled: scipSettings.enabled,
          timeoutMs: scipSettings.timeoutMs,
          allowIndexerExecution: scipSettings.allowIndexerExecution,
          allowBuildExecution: scipSettings.allowBuildExecution,
          allowAutoInstall: scipSettings.allowAutoInstall,
          indexDir: scipSettings.indexDir,
        } : null,
        lsp: lspSettings ? {
          enabled: lspSettings.enabled,
          requestTimeoutMs: lspSettings.requestTimeoutMs,
          allowServerExecution: lspSettings.allowServerExecution,
          supplementation: lspSettings.supplementation ?? null,
        } : null,
        validation: validationPolicy,
        execution: configuration.execution,
        responseFileLimits: this.options.responseFileLimits ?? null,
        pipelineTimeoutMs: this.pipelineTimeoutMs ?? null,
      },
    });

    // ── Pipeline stages ──────────────────────────────────────────────────
    // Baseline rows stay hidden for the complete pipeline. Connection-local
    // effective views make downstream stages see the candidate generation while
    // concurrent readers continue to use the previously promoted generation.
    const stages: (PipelineStage | PipelineStage[])[] = [
      new ScipIndexerStage(),
      new FileDiscoveryStage(),
    ];
    stages.push(
      new LspExtractionStage(),
      new ImportResolutionStage(),
      [new LspEnrichmentStage(), historyStage()],
      resolutionStage(),
      new ReverseDepsStage(),
      new EmbeddingStage(),
      new FtsRefreshStage(),
    );

    const pipeline = new IndexPipeline(stages);

    // ── Pipeline context ─────────────────────────────────────────────────
    const context: PipelineContext = {
      db,
      runId,
      dbPath: this.dbPath,
      walkerConfig: this.walkerConfig,
      branch,
      lsp: lspSettings,
      scip: scipSettings,
      scipScope,
      walkedFiles: scipScope?.effectiveFiles.map((file) => ({
        path: resolve(scipScope.rootDir, file.path), language: file.language,
      })),
      approvedExternalBuildRoots: configuration.execution.allowedCwdRoots,
      responseFileLimits: this.options.responseFileLimits,
      embedder: runEmbedder.provider,
      log,
      files: [],
      indexDependencies: this.indexDependencies,
      history: this.history,
      staleSymbolIds: [],
      changedSourcePaths: [],
      sourceCache: new ByteBudgetLRU(),
      layer,
      generation,
      ...(baselineRun && { stagedMetadata: new Map<string, string | null>() }),
      ...(runSignal && { signal: runSignal }),
      ...(writerLease && {
        assertWriterLease: () => writerLease.assertCurrent(db),
        writerGeneration: writerLease.generation,
      }),
      ...(this.pipelineTimeoutMs !== undefined && {
        deadlineAt: Date.now() + this.pipelineTimeoutMs,
      }),
      ...(mode.kind === 'update' && { changedFiles: mode.changedFiles }),
      ...(this.maxWorkers !== undefined && { maxWorkers: this.maxWorkers }),
    };

    const pipelineLabel = mode.kind === 'update' ? 'update' : 'build';

    let committed = false;
    let runDegradation: { degraded: boolean; fallbackDegraded: boolean } | undefined;
    try {
      if (baselineRun) installStagingEffectiveViews(db, branch, generation);
      // Overlay updates retain their all-or-nothing transaction. Baseline
      // stages instead commit bounded batches into a hidden generation; this
      // prevents subprocess and LSP waits from holding a SQLite writer lock.
      if (!baselineRun) db.exec('BEGIN IMMEDIATE');

      await pipeline.run(context, pipelineLabel);
      const degradation = this.readRunDegradation(db, runId);
      runDegradation = degradation;
      const finalStatus = degradation.degraded ? 'degraded' : 'succeeded';

      if (validationPolicy) {
        const report = validateIndex(db, {
          rootDir: this.walkerConfig.rootDir,
          scipScope: configuration.scipScope ?? undefined,
          walkerConfig: this.walkerConfig,
          branch,
          policy: validationPolicy,
          ...(baselineRun && {
            candidateGeneration: generation,
            candidateRunId: runId,
            candidateRunStatus: finalStatus,
            candidateRunCompletedAt: Math.floor(Date.now() / 1000),
            candidateFallbackDegraded: degradation.fallbackDegraded,
          }),
        });
        this._lastValidationReport = report;
        if (!report.ok) {
          const validationError = report.errors
            .map((issue) => `${issue.code}: ${issue.message}`)
            .join('; ');
          if (report.provenance.latestRun?.id === runId) {
            report.provenance.latestRun.status = 'failed';
            report.provenance.latestRun.error = validationError;
          }
          throw new IndexValidationError(report);
        }
      }

      if (baselineRun) {
        writerLease?.assertCurrent(db);
        dropStagingEffectiveViews(db);
        db.transaction(() => {
          applyBaselinePromotion(db, branch, {
            newGeneration: generation,
            rebuildStartedAt,
            headSha: baselineHeadSha,
            stagedMetadata: context.stagedMetadata,
          }, writerLease?.generation);
          if (baselineHeadSha) {
            setLoreMeta(db, LORE_META_LAST_HEAD_SHA, baselineHeadSha);
          }
          finishIndexRun(db, runId, {
            status: finalStatus,
            fallbackDegraded: degradation.fallbackDegraded,
          });
        }).immediate();
      } else {
        const headSha = this.readGitValue(['rev-parse', 'HEAD']);
        if (headSha) setLoreMeta(db, LORE_META_LAST_HEAD_SHA, headSha);
        finishIndexRun(db, runId, {
          status: finalStatus,
          fallbackDegraded: degradation.fallbackDegraded,
        });
        db.exec('COMMIT');
      }
      committed = true;

      if (baselineRun) {
        try {
          cleanupSupersededBaselineRows(
            db,
            branch,
            generation,
            writerLease?.generation,
          );
        } catch (error) {
          // Superseded rows are already invisible. Garbage collection is
          // retryable and must not turn a successful promotion into failure.
          log.warn('indexing', 'post-promotion cleanup failed', {
            generation,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // ── Mode-specific post-run logging ───────────────────────────────
      if (mode.kind === 'build') {
        const stats = this.gatherDbStats(db);
        const indexDurationMs = Math.round(performance.now() - startTime);
        log.startup('indexing complete', {
          dbPath: this.dbPath,
          dbSizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : undefined,
          embeddingModel: runEmbedder.provider?.modelName ?? null,
          embeddingReady: !!runEmbedder.provider,
          totalFiles: context.files.length,
          ...stats,
          indexDurationMs,
        });
      } else if (mode.kind === 'rebuild') {
        const indexDurationMs = Math.round(performance.now() - startTime);
        log.indexing('baseline rebuild complete', { generation, durationMs: indexDurationMs });
      }
    } catch (error) {
      if (committed) {
        try {
          log.warn('indexing', 'post-commit reporting failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The index is already committed; observability must not change the result.
        }
        return;
      }
      if (db.inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the original pipeline/validation failure.
        }
      }
      if (baselineRun) {
        try {
          dropStagingEffectiveViews(db);
          cleanupFailedBaselineGeneration(db, branch, generation);
        } catch {
          try {
            clearPendingBaselineGeneration(db, generation);
          } catch {
            // Preserve the original pipeline/validation failure.
          }
        }
      }
      if (context.failedStage) {
        try {
          recordIndexerRun(db, {
            runId,
            provider: providerForStage(context.failedStage),
            indexer: context.failedStage,
            status: 'failed',
            attempted: true,
            message: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Preserve the original failure if diagnostic persistence fails.
        }
      }
      try {
        finishIndexRun(db, runId, {
          status: 'failed',
          fallbackDegraded: runDegradation?.fallbackDegraded,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Preserve the original failure if provenance finalization also fails.
      }
      throw error;
    } finally {
      if (baselineRun) {
        try { dropStagingEffectiveViews(db); } catch { /* connection is closing */ }
      }
      if (runEmbedder.owned) {
        try { await runEmbedder.provider?.dispose(); } catch { /* best effort */ }
      }
      db.close();
    }
  }

  /**
   * Writes an LLM-generated summary for a symbol to `symbol_summaries`.
   */
  async ingestSummary(symbolId: number, summary: string, model = 'unknown'): Promise<void> {
    return this._enqueue(async (lease) => {
      const db = openDb(this.dbPath);
      const runEmbedder = this.resolveRunEmbedder(db);
      try {
        lease?.assertCurrent(db);
        db.prepare(
          `INSERT OR REPLACE INTO symbol_summaries (symbol_id, summary, model)
           VALUES (?, ?, ?)`,
        ).run(symbolId, summary, model);

        if (runEmbedder.provider) {
          await runEmbedder.provider.init();
          const [embedding] = await runEmbedder.provider.embed([summary]);
          lease?.assertCurrent(db);
          db.prepare(
            'INSERT OR REPLACE INTO symbol_semantic_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
          ).run(symbolId, JSON.stringify(embedding));
        }
      } finally {
        if (runEmbedder.owned) {
          try { await runEmbedder.provider?.dispose(); } catch { /* best effort */ }
        }
        db.close();
      }
    });
  }

  // ─── Private helpers (minimal — most logic lives in stages) ─────────────

  private resolveBranch(): string {
    return resolveIndexBranch(this.walkerConfig);
  }

  private resolveRunEmbedder(db: Database.Database): {
    provider: EmbeddingProvider | null;
    owned: boolean;
  } {
    if (this.embeddings === false) return { provider: null, owned: false };
    if (this.embedder) return { provider: this.embedder, owned: false };
    const model = this.embeddingModel
      ?? getLoreMeta(db, 'embedding_model')
      ?? (this.embeddings === true ? DEFAULT_EMBEDDING_MODEL : undefined);
    return model
      ? { provider: new LazyEmbeddingProvider(model), owned: true }
      : { provider: null, owned: false };
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
    try { totalSymbols = (db.prepare('SELECT COUNT(*) AS cnt FROM effective_symbols').get() as { cnt: number }).cnt; } catch { /* */ }
    let totalEdges = 0;
    try { totalEdges = (db.prepare('SELECT COUNT(*) AS cnt FROM effective_symbol_refs').get() as { cnt: number }).cnt; } catch { /* */ }
    let commitCount: number | undefined;
    try { commitCount = (db.prepare('SELECT COUNT(*) AS cnt FROM commits').get() as { cnt: number }).cnt; } catch { /* */ }
    return { totalSymbols, totalEdges, commitCount };
  }

  private readRunDegradation(
    db: Database.Database,
    runId: string,
  ): { degraded: boolean; fallbackDegraded: boolean } {
    const row = db.prepare(
      `SELECT
         SUM(CASE WHEN status IN ('failed', 'unavailable', 'degraded') THEN 1 ELSE 0 END) AS degraded,
         SUM(CASE WHEN fallback = 1 AND status IN ('failed', 'unavailable', 'degraded') THEN 1 ELSE 0 END) AS fallback_degraded,
         SUM(CASE WHEN fallback = 1 THEN 1 ELSE 0 END) AS fallback_used
       FROM indexer_runs WHERE run_id = ?`,
    ).get(runId) as {
      degraded: number | null;
      fallback_degraded: number | null;
      fallback_used: number | null;
    };
    const run = db.prepare('SELECT branch FROM index_runs WHERE id = ?').get(runId) as
      | { branch: string }
      | undefined;
    const symbolLess = run
      ? (db.prepare(
          `SELECT COUNT(*) AS count
           FROM effective_files f
           WHERE f.branch = ?
             AND NOT EXISTS (SELECT 1 FROM effective_symbols s WHERE s.file_id = f.id)`,
        ).get(run.branch) as { count: number }).count
      : 0;
    const sourceFallbackDegraded = (row.fallback_used ?? 0) > 0 && symbolLess > 0;
    return {
      degraded: (row.degraded ?? 0) > 0 || sourceFallbackDegraded,
      fallbackDegraded: (row.fallback_degraded ?? 0) > 0 || sourceFallbackDegraded,
    };
  }
}

function resolvePath(path: string): string {
  return fs.realpathSync(path);
}

function toLspOverrides(
  value: IndexBuilderOptions['lsp'],
): LspSettingsOverrides {
  if (value === undefined) return {};
  if (typeof value === 'boolean') return { enabled: value };
  return {
    ...(value.enabled !== undefined && { enabled: value.enabled }),
    ...(value.requestTimeoutMs !== undefined && { requestTimeoutMs: value.requestTimeoutMs }),
    ...(value.servers !== undefined && { servers: value.servers }),
    ...(value.supplementation !== undefined && { supplementation: value.supplementation }),
  };
}

function toScipOverrides(
  value: IndexBuilderOptions['scip'],
): ScipSettingsOverrides {
  if (value === undefined) return {};
  if (typeof value === 'boolean') return { enabled: value };
  return {
    ...(value.enabled !== undefined && { enabled: value.enabled }),
    ...(value.timeoutMs !== undefined && { timeoutMs: value.timeoutMs }),
    ...('timeoutMsExplicit' in value && value.timeoutMsExplicit !== undefined && {
      timeoutMsExplicit: value.timeoutMsExplicit,
    }),
    ...(value.allowBuildExecution !== undefined && {
      allowBuildExecution: value.allowBuildExecution,
    }),
    ...('autoInstall' in value && value.autoInstall !== undefined && {
      autoInstall: value.autoInstall,
    }),
    ...(value.indexers !== undefined && { indexers: value.indexers }),
    ...(value.indexDir !== undefined && { indexDir: value.indexDir }),
  };
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

function providerForStage(stage: string): string {
  if (stage.startsWith('scip')) return 'scip';
  if (stage.startsWith('lsp')) return 'lsp';
  if (stage === 'file-discovery') return 'discovery';
  if (stage === 'embedding') return 'embedding';
  if (stage === 'git-history') return 'git';
  return 'pipeline';
}
