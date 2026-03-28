/**
 * @module indexer/watcher
 *
 * FileWatcher wraps Node's built-in `fs.watch` to detect create/update/delete
 * events in a directory tree, debounces/batches them, and calls
 * `IndexBuilder.update()` with the affected paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IndexBuilder } from '../indexer/index.js';
import type { EmbeddingProvider } from '../embeddings/embedder.js';
import type { EffectiveLspSettings } from '../lsp/config.js';
import type { EffectiveScipSettings } from '../scip/config.js';
import type { WalkerConfig } from './walker.js';
import { isExcludedPath } from './walker.js';
import { ScipFlushManager } from './scip-flush.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration options for FileWatcher. */
export interface WatcherOptions {
  /** Whether the watcher is active. Defaults to `true`. */
  enabled?: boolean;
  /** Debounce window in milliseconds before flushing batched changes. Defaults to 300. */
  debounceMs?: number;
  /** Whether to refresh git history during update cycles. */
  history?: boolean | { depth?: number; all?: boolean };
  /** Whether to include dependency indexing during update cycles. */
  indexDependencies?: boolean;
  /** Effective LSP settings forwarded to update cycles. */
  lsp?: EffectiveLspSettings;
  /** Effective SCIP settings forwarded to update cycles. */
  scip?: EffectiveScipSettings;
  /**
   * Quiet-period in milliseconds before running a background baseline rebuild.
   * After each change, overlay updates run immediately.  A full SCIP baseline
   * rebuild is deferred until no new changes arrive for this duration.
   * Set to `0` to disable background baseline rebuilds.
   * Defaults to 10 000 (10 s).
   */
  scipQuietPeriodMs?: number;
  /**
   * Optional long-lived embedding provider. When supplied, each incremental
   * update cycle will generate embeddings for changed symbols.
   * The caller is responsible for the provider's lifecycle (init/dispose).
   */
  embedder?: EmbeddingProvider;
}

// ─── FileWatcher ──────────────────────────────────────────────────────────────

/**
 * Watches a directory tree for file changes and triggers incremental index
 * updates via `IndexBuilder.update()`.
 *
 * @example
 * ```ts
 * const watcher = new FileWatcher('/path/to/lore.db', { rootDir: '/path/to/src' });
 * watcher.start();
 * // ...later...
 * watcher.stop();
 * ```
 */
export class FileWatcher {
  private readonly dbPath: string;
  private readonly walkerConfig: WalkerConfig;
  private readonly debounceMs: number;
  private readonly enabled: boolean;
  private readonly history: boolean | { depth?: number; all?: boolean };
  private readonly indexDependencies: boolean;
  private readonly lsp: EffectiveLspSettings | undefined;
  private readonly scip: EffectiveScipSettings | undefined;
  private readonly scipQuietPeriodMs: number;
  private readonly embedder: EmbeddingProvider | undefined;

  private watcher: fs.FSWatcher | null = null;
  private pendingPaths: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushRunning = false;

  /** Deferred SCIP baseline rebuild manager. */
  private scipFlush: ScipFlushManager | null = null;

  constructor(dbPath: string, walkerConfig: WalkerConfig, options: WatcherOptions = {}) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;
    this.debounceMs = options.debounceMs ?? 300;
    this.enabled = options.enabled ?? true;
    this.history = options.history ?? false;
    this.indexDependencies = options.indexDependencies ?? false;
    this.lsp = options.lsp;
    this.scip = options.scip;
    this.scipQuietPeriodMs = options.scipQuietPeriodMs ?? 10_000;
    this.embedder = options.embedder;

    if (this.scip && this.scipQuietPeriodMs > 0) {
      this.scipFlush = new ScipFlushManager({
        dbPath: this.dbPath,
        walkerConfig: this.walkerConfig,
        embedder: this.embedder,
        history: this.history,
        indexDependencies: this.indexDependencies,
        lsp: this.lsp,
        scip: this.scip,
        scipQuietPeriodMs: this.scipQuietPeriodMs,
        source: 'FileWatcher',
      });
    }
  }

  /** Begin watching `walkerConfig.rootDir` recursively for file changes. */
  start(): void {
    if (!this.enabled || this.watcher) return;

    // `recursive: true` is supported on macOS, Windows, and Linux (Node >= 19.1).
    // On older Linux kernels/Node versions, subdirectory changes won't trigger events.
    if (process.platform === 'linux') {
      const [major] = process.versions.node.split('.').map(Number);
      if (major !== undefined && major < 19) {
        process.stderr.write(
          JSON.stringify({
            level: 'warn',
            source: 'FileWatcher',
            message: `fs.watch recursive option is not supported on Linux with Node ${process.versions.node}; subdirectory changes will not be detected`,
          }) + '\n',
        );
      }
    }

    this.watcher = fs.watch(
      this.walkerConfig.rootDir,
      { recursive: true },
      (event, filename) => {
        if (!filename) return;

        // Skip changes in excluded directories (node_modules, .git, etc.)
        if (isExcludedPath(filename, this.walkerConfig)) return;

        const absPath = path.join(this.walkerConfig.rootDir, filename);
        this.pendingPaths.add(absPath);
        this.scheduleFlush();
      },
    );

    this.watcher.on('error', (err) => {
      process.stderr.write(
        JSON.stringify({ level: 'error', source: 'FileWatcher', message: String(err) }) + '\n',
      );
    });
  }

  /** Stop watching and cancel any pending debounce flush. */
  stop(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.scipFlush?.stop();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private async flush(): Promise<void> {
    this.debounceTimer = null;
    if (this.flushRunning) return;
    this.flushRunning = true;
    try {
      const paths = [...this.pendingPaths];
      this.pendingPaths.clear();

      if (paths.length === 0) return;

      // Overlay update: tree-sitter + LSP only, no SCIP.
      // SCIP baseline rebuild is deferred to scheduleScipFlush().
      const builder = new IndexBuilder(this.dbPath, this.walkerConfig, this.embedder, {
        history: this.history,
        ...(this.indexDependencies && { indexDependencies: true }),
        ...(this.lsp && { lsp: this.lsp }),
        // Note: SCIP is not passed here — overlay updates never invoke SCIP.
      });
      let errorCount = 0;

      try {
        await builder.update(paths);
      } catch (err) {
        errorCount++;
        process.stderr.write(
          JSON.stringify({ level: 'error', source: 'FileWatcher', message: String(err) }) + '\n',
        );
      }

      process.stderr.write(
        JSON.stringify({
          level: 'info',
          source: 'FileWatcher',
          message: 'refresh cycle complete',
          files: paths.length,
          errors: errorCount,
        }) + '\n',
      );

      // If SCIP is configured with throttling, accumulate paths and
      // schedule a deferred SCIP-enabled update after the quiet period.
      if (this.scipFlush) {
        this.scipFlush.accumulate(paths);
      }
    } finally {
      this.flushRunning = false;
      if (this.pendingPaths.size > 0) {
        this.scheduleFlush();
      }
    }
  }

}
