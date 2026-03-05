/**
 * @module indexer/watcher
 *
 * FileWatcher wraps Node's built-in `fs.watch` to detect create/update/delete
 * events in a directory tree, debounces/batches them, and calls
 * `IndexBuilder.update()` with the affected paths.
 */

import * as fs from 'node:fs';
import { IndexBuilder } from './index.js';
import type { EffectiveLspSettings } from './lsp/config.js';
import type { WalkerConfig } from './walker.js';

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

  private watcher: fs.FSWatcher | null = null;
  private pendingPaths: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushRunning = false;

  constructor(dbPath: string, walkerConfig: WalkerConfig, options: WatcherOptions = {}) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;
    this.debounceMs = options.debounceMs ?? 300;
    this.enabled = options.enabled ?? true;
    this.history = options.history ?? false;
    this.indexDependencies = options.indexDependencies ?? false;
    this.lsp = options.lsp;
  }

  /** Begin watching `walkerConfig.rootDir` recursively for file changes. */
  start(): void {
    if (!this.enabled || this.watcher) return;

    this.watcher = fs.watch(
      this.walkerConfig.rootDir,
      { recursive: true },
      (event, filename) => {
        if (!filename) return;
        const absPath = `${this.walkerConfig.rootDir}/${filename}`;
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

      const builder = new IndexBuilder(this.dbPath, this.walkerConfig, undefined, {
        history: this.history,
        ...(this.indexDependencies && { indexDependencies: true }),
        ...(this.lsp && { lsp: this.lsp }),
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
    } finally {
      this.flushRunning = false;
    }
  }
}
