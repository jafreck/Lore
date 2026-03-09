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
import type { EmbeddingProvider } from './indexer/embedder.js';
import type { EffectiveLspSettings } from './indexer/lsp/config.js';
import type { WalkerConfig } from './indexer/walker.js';
import { getLogger, type LoreLogger } from './logger.js';

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
  /** Git history ingestion policy. */
  history: boolean | { depth?: number; all?: boolean };
  /** Whether to index dependency declarations (.d.ts, etc.). */
  indexDependencies: boolean;
  /** Whether to auto-seed notes from documentation files. */
  docsAutoNotes: boolean;
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
        const { SentenceTransformersProvider } = await import('./indexer/embedder.js');
        const provider = new SentenceTransformersProvider(this.config.embeddingModel);
        await provider.init();
        this._embedder = provider;
        this.log.startup('embedding model loaded', {
          embeddingModel: this.config.embeddingModel,
          embeddingReady: true,
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
      const { FileWatcher } = await import('./indexer/watcher.js');
      const watcher = new FileWatcher(this.config.dbPath, this.config.walkerConfig, {
        history: this.config.history,
        indexDependencies: this.config.indexDependencies,
        lsp: this.config.lsp ?? undefined,
        embedder: this._embedder ?? undefined,
      });
      watcher.start();
      this._refresher = watcher;
      this.log.startup('watch mode started', {
        rootDir: this.config.rootDir,
        embeddingEnabled: !!this._embedder,
      });
    } else if (this.config.refreshMode === 'poll') {
      const { FilePoller } = await import('./indexer/poller.js');
      const poller = new FilePoller(this.config.dbPath, this.config.walkerConfig, {
        history: this.config.history,
        indexDependencies: this.config.indexDependencies,
        lsp: this.config.lsp ?? undefined,
        embedder: this._embedder ?? undefined,
      });
      poller.start();
      this._refresher = poller;
      this.log.startup('poll mode started', {
        rootDir: this.config.rootDir,
        embeddingEnabled: !!this._embedder,
      });
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
   * Register process-level signal handlers (`SIGINT`, `SIGTERM`) that call
   * `shutdown()` and exit. Convenience for CLI entry points.
   */
  installSignalHandlers(): void {
    const handler = () => {
      this.shutdown()
        .catch(() => { /* best-effort */ })
        .finally(() => process.exit(0));
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }
}
