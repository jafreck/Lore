import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LoreRuntime, type RuntimeConfig } from '../src/runtime.js';
import { initLogger, LogLevel, resetLogger } from '../src/logger.js';

function makeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    dbPath: '/tmp/test-lore.db',
    rootDir: '/tmp/test-project',
    walkerConfig: { rootDir: '/tmp/test-project' } as any,
    lsp: null,
    scip: null,
    history: false,
    indexDependencies: false,
    refreshMode: 'none',
    ...overrides,
  };
}

describe('LoreRuntime', () => {
  beforeEach(() => {
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
  });

  describe('constructor', () => {
    it('creates an instance with config', () => {
      const config = makeConfig();
      const runtime = new LoreRuntime(config);
      expect(runtime.config).toBe(config);
      expect(runtime.started).toBe(false);
    });

    it('uses provided logger', () => {
      const logger = initLogger({ level: LogLevel.DEBUG });
      const runtime = new LoreRuntime(makeConfig(), logger);
      expect(runtime.log).toBe(logger);
    });

    it('uses global logger when none provided', () => {
      const runtime = new LoreRuntime(makeConfig());
      expect(runtime.log).toBeDefined();
    });
  });

  describe('accessors before start', () => {
    it('embedder is undefined before start', () => {
      const runtime = new LoreRuntime(makeConfig());
      expect(runtime.embedder).toBeUndefined();
    });

    it('refresher is undefined before start', () => {
      const runtime = new LoreRuntime(makeConfig());
      expect(runtime.refresher).toBeUndefined();
    });

    it('started is false before start', () => {
      const runtime = new LoreRuntime(makeConfig());
      expect(runtime.started).toBe(false);
    });
  });

  describe('start and shutdown', () => {
    it('start sets started flag', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await runtime.start();
      expect(runtime.started).toBe(true);
      await runtime.shutdown();
    });

    it('start is idempotent', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await runtime.start();
      await runtime.start(); // Should be no-op
      expect(runtime.started).toBe(true);
      await runtime.shutdown();
    });

    it('shutdown clears started flag', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await runtime.start();
      await runtime.shutdown();
      expect(runtime.started).toBe(false);
    });

    it('shutdown is safe when not started', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await expect(runtime.shutdown()).resolves.not.toThrow();
    });

    it('shutdown is idempotent', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await runtime.start();
      await runtime.shutdown();
      await runtime.shutdown(); // Should be no-op
      expect(runtime.started).toBe(false);
    });
  });

  describe('config defaults', () => {
    it('has expected default values', () => {
      const config = makeConfig();
      expect(config.refreshMode).toBe('none');
      expect(config.lsp).toBeNull();
      expect(config.scip).toBeNull();
      expect(config.history).toBe(false);
      expect(config.indexDependencies).toBe(false);
    });
  });
});
