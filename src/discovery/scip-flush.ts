/**
 * @module discovery/scip-flush
 *
 * Shared SCIP background baseline rebuild logic used by both
 * FilePoller and FileWatcher.
 */

import { IndexBuilder } from '../indexer/index.js';
import type { EmbeddingProvider } from '../embeddings/embedder.js';
import type { EffectiveLspSettings } from '../lsp/config.js';
import type { EffectiveScipSettings } from '../scip/config.js';
import type { WalkerConfig } from './walker.js';

export interface ScipFlushConfig {
  dbPath: string;
  walkerConfig: WalkerConfig;
  embedder: EmbeddingProvider | undefined;
  history: boolean | { depth?: number; all?: boolean };
  indexDependencies: boolean;
  lsp: EffectiveLspSettings | undefined;
  scip: EffectiveScipSettings;
  scipQuietPeriodMs: number;
  /** Label used in log messages (e.g. 'FilePoller' or 'FileWatcher'). */
  source: string;
  /**
   * Optional callback to perform the baseline rebuild.  When provided,
   * IndexBuilder is NOT constructed internally — the caller owns that
   * responsibility.  When omitted the legacy behaviour (constructing
   * IndexBuilder inline) is preserved.
   */
  onBaselineRebuild?: () => Promise<void>;
}

/**
 * Manages deferred SCIP baseline rebuilds.
 *
 * After each batch of overlay changes, call `accumulate(paths)`.  A background
 * baseline rebuild is scheduled after `scipQuietPeriodMs` of inactivity.
 */
export class ScipFlushManager {
  private readonly config: ScipFlushConfig;
  private pathsSinceLastScip: Set<string> = new Set();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(config: ScipFlushConfig) {
    this.config = config;
  }

  /** Accumulate changed paths and (re-)schedule the background rebuild. */
  accumulate(paths: string[]): void {
    if (this.disposed) return;
    for (const p of paths) this.pathsSinceLastScip.add(p);
    this.schedule();
  }

  /** Cancel any pending deferred rebuild. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Cancel pending rebuild and prevent any future scheduling. */
  stop(): void {
    this.disposed = true;
    this.cancel();
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), this.config.scipQuietPeriodMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const paths = [...this.pathsSinceLastScip];
    this.pathsSinceLastScip.clear();

    if (paths.length === 0) return;

    const { source } = this.config;

    try {
      if (this.config.onBaselineRebuild) {
        await this.config.onBaselineRebuild();
      } else {
        const { dbPath, walkerConfig, embedder, history, indexDependencies, lsp, scip } = this.config;
        const builder = new IndexBuilder(dbPath, walkerConfig, embedder, {
          history,
          ...(indexDependencies && { indexDependencies: true }),
          ...(lsp && { lsp }),
          scip,
        });
        await builder.baselineRebuild();
      }
    } catch (err) {
      // Re-queue paths on failure so next flush retries them
      for (const p of paths) this.pathsSinceLastScip.add(p);
      process.stderr.write(
        JSON.stringify({ level: 'error', source, message: String(err) }) + '\n',
      );
      return;
    }

    process.stderr.write(
      JSON.stringify({
        level: 'info',
        source,
        message: 'baseline rebuild complete',
        files: paths.length,
      }) + '\n',
    );
  }
}
