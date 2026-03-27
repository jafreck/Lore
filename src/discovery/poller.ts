/**
 * @module indexer/poller
 *
 * FilePoller periodically walks the directory tree, diffs file mtimes against
 * a stored snapshot, and calls `IndexBuilder.update()` for any files that were
 * created, modified, or deleted since the last poll.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IndexBuilder } from '../indexer/index.js';
import type { EmbeddingProvider } from '../embeddings/embedder.js';
import type { EffectiveLspSettings } from '../lsp/config.js';
import type { EffectiveScipSettings } from '../scip/config.js';
import { walkFiles } from './walker.js';
import type { WalkerConfig } from './walker.js';
import { ScipFlushManager } from './scip-flush.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration options for FilePoller. */
export interface PollerOptions {
  /** Whether the poller is active. Defaults to `true`. */
  enabled?: boolean;
  /** Polling interval in milliseconds. Defaults to 5000 (5 s). */
  intervalMs?: number;
  /** Whether to refresh git history during poll update cycles. */
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


// ─── FilePoller ───────────────────────────────────────────────────────────────

/**
 * Polls a directory tree on a configurable interval, compares mtimes against
 * a snapshot, and triggers incremental index updates via `IndexBuilder.update()`.
 *
 * @example
 * ```ts
 * const poller = new FilePoller('/path/to/lore.db', { rootDir: '/path/to/src' });
 * poller.start();
 * // ...later...
 * poller.stop();
 * ```
 */
export class FilePoller {
  private readonly dbPath: string;
  private readonly walkerConfig: WalkerConfig;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly history: boolean | { depth?: number; all?: boolean };
  private readonly indexDependencies: boolean;
  private readonly lsp: EffectiveLspSettings | undefined;
  private readonly scip: EffectiveScipSettings | undefined;
  private readonly scipQuietPeriodMs: number;
  private readonly embedder: EmbeddingProvider | undefined;

  /** Maps absolute path → last seen mtime (ms since epoch). */
  private snapshot: Map<string, number> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollRunning = false;

  /** Deferred SCIP baseline rebuild manager. */
  private scipFlush: ScipFlushManager | null = null;

  constructor(dbPath: string, walkerConfig: WalkerConfig, options: PollerOptions = {}) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;
    this.intervalMs = options.intervalMs ?? 5000;
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
        source: 'FilePoller',
      });
    }
  }

  /** Begin polling `walkerConfig.rootDir` at the configured interval. */
  start(): void {
    if (!this.enabled || this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** Stop the polling interval. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.scipFlush?.stop();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      let errorCount = 0;
      const changed: string[] = [];

      let entries: { path: string }[];
      try {
        entries = await walkFiles(this.walkerConfig);
      } catch (err) {
        process.stderr.write(
          JSON.stringify({ level: 'error', source: 'FilePoller', message: String(err) }) + '\n',
        );
        return;
      }

      const currentPaths = new Set<string>();

      const STAT_BATCH_SIZE = 100;
      for (let i = 0; i < entries.length; i += STAT_BATCH_SIZE) {
        const batch = entries.slice(i, i + STAT_BATCH_SIZE);
        const stats = await Promise.all(
          batch.map(async (entry) => {
            try {
              const stat = await fs.promises.stat(entry.path);
              return { path: entry.path, mtime: stat.mtimeMs };
            } catch {
              return { path: entry.path, mtime: null };
            }
          }),
        );
        for (const { path: filePath, mtime } of stats) {
          if (mtime === null) {
            // Don't add to currentPaths — let deletion sweep handle it if
            // previously indexed.  New unreadable files are simply ignored.
            continue;
          }
          currentPaths.add(filePath);
          const prev = this.snapshot.get(filePath);
          if (prev === undefined || prev !== mtime) {
            changed.push(filePath);
            this.snapshot.set(filePath, mtime);
          }
        }
      }

      // Detect deletions: paths in snapshot that are no longer on disk
      for (const [p] of this.snapshot) {
        if (!currentPaths.has(p)) {
          changed.push(p);
          this.snapshot.delete(p);
        }
      }

      if (changed.length > 0) {
        // Overlay update: tree-sitter + LSP only, no SCIP.
        const builder = new IndexBuilder(this.dbPath, this.walkerConfig, this.embedder, {
          history: this.history,
          ...(this.indexDependencies && { indexDependencies: true }),
          ...(this.lsp && { lsp: this.lsp }),
          // Note: SCIP is not passed — overlay updates never invoke SCIP.
        });
        try {
          await builder.update(changed);
        } catch (err) {
          errorCount++;
          process.stderr.write(
            JSON.stringify({ level: 'error', source: 'FilePoller', message: String(err) }) + '\n',
          );
        }

        // If SCIP is configured with throttling, accumulate paths and
        // schedule a deferred SCIP-enabled update after the quiet period.
        if (this.scipFlush) {
          this.scipFlush.accumulate(changed);
        }
      }

      process.stderr.write(
        JSON.stringify({
          level: 'info',
          source: 'FilePoller',
          message: 'poll cycle complete',
          changed: changed.length,
          errors: errorCount,
        }) + '\n',
      );
    } finally {
      this.pollRunning = false;
    }
  }

}
