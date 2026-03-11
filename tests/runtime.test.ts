import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoreRuntime, type RuntimeConfig } from '../src/runtime.js';
import { initLogger, LogLevel } from '../src/logger.js';

function stubConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    dbPath: '/tmp/test.db',
    rootDir: '/tmp/test-project',
    walkerConfig: { rootDir: '/tmp/test-project' } as any,
    lsp: null,
    history: false,
    indexDependencies: false,
    docsAutoNotes: false,
    refreshMode: 'none',
    ...overrides,
  };
}

describe('LoreRuntime', () => {
  let runtime: LoreRuntime;

  afterEach(async () => {
    if (runtime?.started) {
      await runtime.shutdown();
    }
  });

  it('should initialise with config and default logger', () => {
    runtime = new LoreRuntime(stubConfig());
    expect(runtime.config.dbPath).toBe('/tmp/test.db');
    expect(runtime.started).toBe(false);
  });

  it('should accept a custom logger', () => {
    const log = initLogger({ level: LogLevel.SILENT });
    runtime = new LoreRuntime(stubConfig(), log);
    expect(runtime.log).toBe(log);
  });

  it('should expose undefined embedder and refresher before start', () => {
    runtime = new LoreRuntime(stubConfig());
    expect(runtime.embedder).toBeUndefined();
    expect(runtime.refresher).toBeUndefined();
  });

  it('start() should set started flag', async () => {
    runtime = new LoreRuntime(stubConfig());
    expect(runtime.started).toBe(false);
    await runtime.start();
    expect(runtime.started).toBe(true);
  });

  it('start() should be idempotent', async () => {
    runtime = new LoreRuntime(stubConfig());
    await runtime.start();
    await runtime.start();
    expect(runtime.started).toBe(true);
  });

  it('shutdown() should reset started flag', async () => {
    runtime = new LoreRuntime(stubConfig());
    await runtime.start();
    expect(runtime.started).toBe(true);
    await runtime.shutdown();
    expect(runtime.started).toBe(false);
  });

  it('shutdown() should be safe to call when not started', async () => {
    runtime = new LoreRuntime(stubConfig());
    await runtime.shutdown();
    expect(runtime.started).toBe(false);
  });

  it('should not create embedder when no embeddingModel is set', async () => {
    runtime = new LoreRuntime(stubConfig());
    await runtime.start();
    expect(runtime.embedder).toBeUndefined();
  });

  it('should not create refresher when refreshMode is none', async () => {
    runtime = new LoreRuntime(stubConfig());
    await runtime.start();
    expect(runtime.refresher).toBeUndefined();
  });

  it('installSignalHandlers should not throw', () => {
    runtime = new LoreRuntime(stubConfig());
    expect(() => runtime.installSignalHandlers()).not.toThrow();
  });
});
