/**
 * Unit tests for LoreRuntime lifecycle.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LoreRuntime, type RuntimeConfig } from '../src/runtime.js';
import { initLogger, LogLevel } from '../src/logger.js';

function stubConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const dir = mkdtempSync(join(tmpdir(), 'lore-rt-'));
  return {
    dbPath: join(dir, 'test.db'),
    rootDir: dir,
    walkerConfig: { rootDir: dir },
    lsp: null,
    scip: null,
    history: false,
    indexDependencies: false,
    refreshMode: 'none',
    ...overrides,
  };
}

describe('LoreRuntime', () => {
  let runtime: LoreRuntime | undefined;

  afterEach(async () => {
    if (runtime?.started) await runtime.shutdown();
  });

  it('should start and report started', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    expect(runtime.started).toBe(false);
    await runtime.start();
    expect(runtime.started).toBe(true);
  });

  it('should be a no-op when start is called twice', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    await runtime.start(); // no-op
    expect(runtime.started).toBe(true);
  });

  it('should shutdown cleanly', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    await runtime.shutdown();
    expect(runtime.started).toBe(false);
  });

  it('should be a no-op when shutdown is called without start', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.shutdown(); // no-op
    expect(runtime.started).toBe(false);
  });

  it('should expose embedder as undefined when no model configured', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    expect(runtime.embedder).toBeUndefined();
  });

  it('should expose refresher as undefined in none mode', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    expect(runtime.refresher).toBeUndefined();
  });

  it('should expose config', () => {
    const cfg = stubConfig();
    runtime = new LoreRuntime(cfg, initLogger({ level: LogLevel.SILENT }));
    expect(runtime.config).toBe(cfg);
  });

  it('should create embedder when embeddingModel is configured', async () => {
    runtime = new LoreRuntime(
      stubConfig({ embeddingModel: 'test-model' }),
      initLogger({ level: LogLevel.SILENT }),
    );
    await runtime.start();
    // The LazyEmbeddingProvider should be created (not initialized yet)
    expect(runtime.embedder).toBeDefined();
    expect(runtime.embedder!.modelName).toBe('test-model');
  });

  it('should start in watch mode and create a refresher', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg = stubConfig({ refreshMode: 'watch' });
    // Create a valid DB file for the watcher
    const { openDb } = await import('../src/db/schema.js');
    const db = openDb(cfg.dbPath);
    db.close();

    runtime = new LoreRuntime(cfg, initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    expect(runtime.refresher).toBeDefined();
    stderrSpy.mockRestore();
  });

  it('should start in poll mode and create a refresher', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg = stubConfig({ refreshMode: 'poll' });
    // Create a valid DB file for the poller
    const { openDb } = await import('../src/db/schema.js');
    const db = openDb(cfg.dbPath);
    db.close();

    runtime = new LoreRuntime(cfg, initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    expect(runtime.refresher).toBeDefined();
    stderrSpy.mockRestore();
  });

  it('should dispose embedder and refresher during shutdown', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg = stubConfig({ refreshMode: 'poll', embeddingModel: 'test-model' });
    const { openDb } = await import('../src/db/schema.js');
    const db = openDb(cfg.dbPath);
    db.close();

    runtime = new LoreRuntime(cfg, initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    expect(runtime.refresher).toBeDefined();
    expect(runtime.embedder).toBeDefined();

    await runtime.shutdown();
    expect(runtime.refresher).toBeUndefined();
    expect(runtime.embedder).toBeUndefined();
    expect(runtime.started).toBe(false);
    stderrSpy.mockRestore();
  });
});
