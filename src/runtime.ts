/**
 * @module runtime
 *
 * `LoreRuntime` centralises the lifecycle of all long-lived resources that a
 * Lore session needs: database handles, embedding providers, LSP coordinators,
 * and file-change refreshers (watcher / poller).
 *
 * Both the CLI sub-commands and the MCP server dispatch through a single
 * runtime instance so that startup, shutdown, and resource ownership are
 * handled in one place.
 */

import * as fs from 'node:fs';
import type { EmbeddingProvider } from './embeddings/embedder.js';
import type { EffectiveLspSettings } from './lsp/config.js';
import type { EffectiveScipSettings } from './scip/config.js';
import type { WalkerConfig } from './discovery/walker.js';
import { getLogger, type LoreLogger } from './logger.js';
import { killAllTracked } from './process-tracker.js';

// ─── RuntimeConfig ────────────────────────────────────────────────────────────

/** Immutable bag of settings collected from CLI flags / programmatic callers. */
export interface RuntimeConfig {
  /** Path to the Lore SQLite knowledge-base file. */
  dbPath: string;
  /** Root directory of the project being indexed. */
  rootDir: string;
  /** Walker configuration (globs, extensions, doc filters, etc.). */
  walkerConfig: WalkerConfig;

  // ── Policy flags ───────────────────────────────────────────────────────────
  /** Git branch / ref policy. */
  branch?: string;
  /** Embedding model identifier (default resolved internally). */
  embeddingModel?: string;
  /** LSP enrichment policy. `null` = disabled. */
  lsp: EffectiveLspSettings | null;
  /** SCIP enrichment policy. `null` = disabled. */
  scip: EffectiveScipSettings | null;
  /** Git history ingestion policy. */
  history: boolean | { depth?: number; all?: boolean };
  /** Whether to index dependency declarations (.d.ts, etc.). */
  indexDependencies: boolean;
  /** Refresh mode: `'none'` (one-shot), `'watch'`, or `'poll'`. */
  refreshMode: 'none' | 'watch' | 'poll';
}

// ─── Stoppable refresher abstraction ──────────────────────────────────────────

/** Minimal interface shared by FileWatcher and FilePoller. */
export interface Refresher {
  start(): void;
  stop(): void;
}

// ─── LoreRuntime ──────────────────────────────────────────────────────────────

/**
 * Owns the lifecycle of all long-lived Lore resources.
 *
 * Typical usage:
 * ```ts
 * const runtime = new LoreRuntime(config);
 * await runtime.start();
 * // ... do work ...
 * await runtime.shutdown();
 * ```
 */
export class LoreRuntime {
  readonly config: RuntimeConfig;
  readonly log: LoreLogger;

  private _embedder: EmbeddingProvider | null = null;
  private _refresher: Refresher | null = null;
  private _started = false;

  constructor(config: RuntimeConfig, logger?: LoreLogger) {
    this.config = config;
    this.log = logger ?? getLogger();
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  /** The live embedding provider, or `undefined` if embeddings are disabled. */
  get embedder(): EmbeddingProvider | undefined {
    return this._embedder ?? undefined;
  }

  /** The live file-change refresher, or `undefined` if refresh mode is `'none'`. */
  get refresher(): Refresher | undefined {
    return this._refresher ?? undefined;
  }

  get started(): boolean {
    return this._started;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialise optional long-lived resources (embedder, watcher/poller).
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    // ── Embedder ─────────────────────────────────────────────────────────────
    if (this.config.embeddingModel) {
      try {
        const { LazyEmbeddingProvider } = await import('./embeddings/embedder.js');
        const provider = new LazyEmbeddingProvider(this.config.embeddingModel);
        this._embedder = provider;
        this.log.startup('embedding model configured (lazy — loads on first use)', {
          embeddingModel: this.config.embeddingModel,
          embeddingReady: false,
        });
      } catch {
        this.log.warn(
          'startup',
          'embedding model unavailable, continuing without embeddings',
          { embeddingModel: this.config.embeddingModel },
        );
      }
    }

    // ── Refresher (watch / poll) ─────────────────────────────────────────────
    if (this.config.refreshMode === 'watch') {
      const { FileWatcher } = await import('./discovery/watcher.js');
      const { IndexBuilder } = await import('./indexer/index.js');
      const cfg = this.config;
      const embedder = this._embedder ?? undefined;
      const watcher = new FileWatcher(cfg.dbPath, cfg.walkerConfig, {
        history: cfg.history,
        indexDependencies: cfg.indexDependencies,
        lsp: cfg.lsp ?? undefined,
        scip: cfg.scip ?? undefined,
        embedder,
        onUpdate: async (changedFiles) => {
          const builder = new IndexBuilder(cfg.dbPath, cfg.walkerConfig, embedder, {
            history: cfg.history,
            ...(cfg.indexDependencies && { indexDependencies: true }),
            ...(cfg.lsp && { lsp: cfg.lsp }),
          });
          await builder.update(changedFiles);
        },
        ...(cfg.scip && {
          onBaselineRebuild: async () => {
            const builder = new IndexBuilder(cfg.dbPath, cfg.walkerConfig, embedder, {
              history: cfg.history,
              ...(cfg.indexDependencies && { indexDependencies: true }),
              ...(cfg.lsp && { lsp: cfg.lsp }),
              ...(cfg.scip && { scip: cfg.scip }),
            });
            await builder.baselineRebuild();
          },
        }),
      });
      watcher.start();
      this._refresher = watcher;
      this.log.startup('watch mode started', {
        rootDir: this.config.rootDir,
        embeddingEnabled: !!this._embedder,
      });
      process.stderr.write(
        JSON.stringify({ level: 'info', source: 'cli', message: 'watch mode started', rootDir: this.config.rootDir, embeddingEnabled: !!this._embedder }) + '\n',
      );
    } else if (this.config.refreshMode === 'poll') {
      const { FilePoller } = await import('./discovery/poller.js');
      const { IndexBuilder } = await import('./indexer/index.js');
      const cfg = this.config;
      const embedder = this._embedder ?? undefined;
      const poller = new FilePoller(cfg.dbPath, cfg.walkerConfig, {
        history: cfg.history,
        indexDependencies: cfg.indexDependencies,
        lsp: cfg.lsp ?? undefined,
        scip: cfg.scip ?? undefined,
        embedder,
        onUpdate: async (changedFiles) => {
          const builder = new IndexBuilder(cfg.dbPath, cfg.walkerConfig, embedder, {
            history: cfg.history,
            ...(cfg.indexDependencies && { indexDependencies: true }),
            ...(cfg.lsp && { lsp: cfg.lsp }),
          });
          await builder.update(changedFiles);
        },
        ...(cfg.scip && {
          onBaselineRebuild: async () => {
            const builder = new IndexBuilder(cfg.dbPath, cfg.walkerConfig, embedder, {
              history: cfg.history,
              ...(cfg.indexDependencies && { indexDependencies: true }),
              ...(cfg.lsp && { lsp: cfg.lsp }),
              ...(cfg.scip && { scip: cfg.scip }),
            });
            await builder.baselineRebuild();
          },
        }),
      });
      poller.start();
      this._refresher = poller;
      this.log.startup('poll mode started', {
        rootDir: this.config.rootDir,
        embeddingEnabled: !!this._embedder,
      });
      process.stderr.write(
        JSON.stringify({ level: 'info', source: 'cli', message: 'poll mode started', rootDir: this.config.rootDir, embeddingEnabled: !!this._embedder }) + '\n',
      );
    }
  }

  /**
   * Gracefully tear down all managed resources.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async shutdown(): Promise<void> {
    if (!this._started) return;
    this._started = false;

    if (this._refresher) {
      this._refresher.stop();
      this._refresher = null;
    }

    if (this._embedder) {
      try {
        await this._embedder.dispose();
      } catch {
        /* best-effort */
      }
      this._embedder = null;
    }
  }

  /**
   * Register process-level signal handlers (`SIGINT`, `SIGTERM`) that
   * gracefully tear down all managed resources before exiting.
   *
   * A second signal while shutdown is in progress forces an immediate exit.
   * As a safety net, `killAllTracked()` runs synchronously on the `exit`
   * event to SIGTERM any child processes that slipped past the async path
   * (e.g. LSP servers spawned by an in-flight pipeline stage).
   */
  private _signalHandlersInstalled = false;

  installSignalHandlers(): void {
    if (this._signalHandlersInstalled) return;
    this._signalHandlersInstalled = true;

    let shuttingDown = false;

    const handler = () => {
      if (shuttingDown) {
        // Second signal — force-kill children and bail.
        killAllTracked();
        process.exit(1);
      }
      shuttingDown = true;

      this.shutdown()
        .catch(() => { /* best-effort */ })
        .finally(() => {
          killAllTracked();
          process.exit(0);
        });
    };

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);

    // Last-resort: kill any children that are still alive when the
    // process is about to exit (covers unexpected exits / unhandled errors).
    process.once('exit', () => killAllTracked());
  }
}
