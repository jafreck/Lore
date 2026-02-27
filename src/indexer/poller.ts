/**
 * @module indexer/poller
 *
 * FilePoller periodically walks the directory tree, diffs file mtimes against
 * a stored snapshot, and calls `IndexBuilder.update()` for any files that were
 * created, modified, or deleted since the last poll.
 */

import * as fs from 'node:fs';
import { IndexBuilder } from './index.js';
import { walkFiles } from './walker.js';
import type { WalkerConfig } from './walker.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration options for FilePoller. */
export interface PollerOptions {
  /** Whether the poller is active. Defaults to `true`. */
  enabled?: boolean;
  /** Polling interval in milliseconds. Defaults to 5000 (5 s). */
  intervalMs?: number;
}

// ─── FilePoller ───────────────────────────────────────────────────────────────

/**
 * Polls a directory tree on a configurable interval, compares mtimes against
 * a snapshot, and triggers incremental index updates via `IndexBuilder.update()`.
 *
 * @example
 * ```ts
 * const poller = new FilePoller('/path/to/kb.db', { rootDir: '/path/to/src' });
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

  /** Maps absolute path → last seen mtime (ms since epoch). */
  private snapshot: Map<string, number> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string, walkerConfig: WalkerConfig, options: PollerOptions = {}) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;
    this.intervalMs = options.intervalMs ?? 5000;
    this.enabled = options.enabled ?? true;
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
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async poll(): Promise<void> {
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

    for (const entry of entries) {
      currentPaths.add(entry.path);
      let mtime: number;
      try {
        mtime = fs.statSync(entry.path).mtimeMs;
      } catch {
        continue; // file vanished between walk and stat
      }

      const prev = this.snapshot.get(entry.path);
      if (prev === undefined || prev !== mtime) {
        changed.push(entry.path);
        this.snapshot.set(entry.path, mtime);
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
      const builder = new IndexBuilder(this.dbPath, this.walkerConfig);
      try {
        await builder.update(changed);
      } catch (err) {
        errorCount++;
        process.stderr.write(
          JSON.stringify({ level: 'error', source: 'FilePoller', message: String(err) }) + '\n',
        );
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
  }
}
