import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoreRuntime, type RuntimeConfig } from '../src/runtime.js';
import { initLogger, LogLevel, resetLogger } from '../src/logger.js';
import { openDb } from '../src/db/schema.js';

// ── Hoisted mock fns (available inside vi.mock factories) ────────────────────
const mocks = vi.hoisted(() => ({
  watcherStart: vi.fn(),
  watcherStop: vi.fn(),
  pollerStart: vi.fn(),
  pollerStop: vi.fn(),
  indexBuilderRefresh: vi.fn().mockResolvedValue([]),
  indexBuilderUpdate: vi.fn().mockResolvedValue(undefined),
  indexBuilderBaselineRebuild: vi.fn().mockResolvedValue(undefined),
  embedderDispose: vi.fn().mockResolvedValue(undefined),
  killAllTracked: vi.fn(),
}));

vi.mock('../src/discovery/watcher.js', () => ({
  FileWatcher: vi.fn().mockImplementation(function (this: any) {
    this.start = mocks.watcherStart;
    this.stop = mocks.watcherStop;
  }),
}));

vi.mock('../src/discovery/poller.js', () => ({
  FilePoller: vi.fn().mockImplementation(function (this: any) {
    this.start = mocks.pollerStart;
    this.stop = mocks.pollerStop;
  }),
}));

vi.mock('../src/indexer/index.js', () => ({
  IndexBuilder: vi.fn().mockImplementation(function (this: any) {
    this.refresh = mocks.indexBuilderRefresh;
    this.update = mocks.indexBuilderUpdate;
    this.baselineRebuild = mocks.indexBuilderBaselineRebuild;
  }),
}));

vi.mock('../src/embeddings/embedder.js', () => ({
  DEFAULT_EMBEDDING_MODEL: 'default-test-model',
  LazyEmbeddingProvider: vi.fn().mockImplementation(function (this: any) {
    this.dispose = mocks.embedderDispose;
  }),
}));

vi.mock('../src/process-tracker.js', () => ({
  killAllTracked: mocks.killAllTracked,
}));

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
    vi.clearAllMocks();
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
      // Should be the global logger instance
      expect(typeof runtime.log.info).toBe('function');
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

  describe('shutdown disposes resources', () => {
    it('embedder remains undefined when not configured', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await runtime.start();
      expect(runtime.embedder).toBeUndefined(); // no embeddingModel configured
      await runtime.shutdown();
      expect(runtime.embedder).toBeUndefined();
    });

    it('refresher remains undefined when refreshMode=none', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await runtime.start();
      expect(runtime.refresher).toBeUndefined(); // refreshMode=none
      await runtime.shutdown();
      expect(runtime.refresher).toBeUndefined();
    });
  });

  describe('installSignalHandlers', () => {
    it('installs without throwing', () => {
      const runtime = new LoreRuntime(makeConfig());
      expect(() => runtime.installSignalHandlers()).not.toThrow();
    });

    it('is idempotent (calling twice does not throw)', () => {
      const runtime = new LoreRuntime(makeConfig());
      runtime.installSignalHandlers();
      expect(() => runtime.installSignalHandlers()).not.toThrow();
    });
  });

  describe('start with embeddingModel', () => {
    it('does not crash when embeddingModel is set but model unavailable', async () => {
      const runtime = new LoreRuntime(makeConfig({
        embeddingModel: 'nonexistent-model',
      }));
      // start() should catch the error and continue
      await runtime.start();
      // embedder may or may not be set depending on whether lazy init catches
      expect(runtime.started).toBe(true);
      await runtime.shutdown();
    });

    it('loads the persisted embedding model when no model is supplied', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-runtime-embedding-'));
      const dbPath = path.join(directory, 'lore.db');
      const db = openDb(dbPath);
      db.prepare("INSERT INTO lore_meta (key, value) VALUES ('embedding_model', 'persisted-model')").run();
      db.close();
      try {
        const { LazyEmbeddingProvider } = await import('../src/embeddings/embedder.js');
        const runtime = new LoreRuntime(makeConfig({ dbPath }));
        await runtime.start();
        expect(LazyEmbeddingProvider).toHaveBeenCalledWith('persisted-model');
        expect(runtime.embedder).toBeDefined();
        await runtime.shutdown();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('does not load a persisted embedding model when explicitly disabled', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-runtime-no-embedding-'));
      const dbPath = path.join(directory, 'lore.db');
      const db = openDb(dbPath);
      db.prepare("INSERT INTO lore_meta (key, value) VALUES ('embedding_model', 'persisted-model')").run();
      db.close();
      try {
        const { LazyEmbeddingProvider } = await import('../src/embeddings/embedder.js');
        const runtime = new LoreRuntime(makeConfig({ dbPath, embeddings: false }));
        await runtime.start();
        expect(LazyEmbeddingProvider).not.toHaveBeenCalled();
        expect(runtime.embedder).toBeUndefined();
        await runtime.shutdown();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  describe('double shutdown', () => {
    it('multiple shutdowns are safe after started', async () => {
      const runtime = new LoreRuntime(makeConfig());
      await runtime.start();
      await runtime.shutdown();
      await runtime.shutdown();
      await runtime.shutdown();
      expect(runtime.started).toBe(false);
    });
  });

  describe('start with refreshMode=watch', () => {
    it('starts watcher and sets refresher', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const runtime = new LoreRuntime(makeConfig({ refreshMode: 'watch' }));
      await runtime.start();

      expect(mocks.indexBuilderRefresh).toHaveBeenCalledOnce();
      expect(mocks.watcherStart).toHaveBeenCalled();
      expect(mocks.indexBuilderRefresh.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.watcherStart.mock.invocationCallOrder[0]!);
      expect(runtime.refresher).toBeDefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('watch mode started'),
      );

      await runtime.shutdown();
      expect(mocks.watcherStop).toHaveBeenCalled();
      expect(runtime.refresher).toBeUndefined();
      stderrSpy.mockRestore();
    });

    it('includes onBaselineRebuild when scip is configured', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { FileWatcher } = await import('../src/discovery/watcher.js');

      const runtime = new LoreRuntime(makeConfig({
        refreshMode: 'watch',
        scip: { enabled: true, indexerPath: 'scip-typescript', args: [] } as any,
      }));
      await runtime.start();

      const ctorCalls = vi.mocked(FileWatcher).mock.calls;
      const lastCall = ctorCalls[ctorCalls.length - 1];
      expect(lastCall?.[2]?.onBaselineRebuild).toBeTypeOf('function');

      await runtime.shutdown();
      stderrSpy.mockRestore();
    });

    it('omits onBaselineRebuild when SCIP is disabled', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { FileWatcher } = await import('../src/discovery/watcher.js');
      const runtime = new LoreRuntime(makeConfig({
        refreshMode: 'watch',
        scip: { enabled: false } as any,
      }));

      await runtime.start();
      const lastCall = vi.mocked(FileWatcher).mock.calls.at(-1);
      expect(lastCall?.[2]).not.toHaveProperty('scip');
      expect(lastCall?.[2]?.onBaselineRebuild).toBeUndefined();

      await runtime.shutdown();
      stderrSpy.mockRestore();
    });
  });

  describe('start with refreshMode=poll', () => {
    it('starts poller and sets refresher', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const runtime = new LoreRuntime(makeConfig({ refreshMode: 'poll' }));
      await runtime.start();

      expect(mocks.indexBuilderRefresh).toHaveBeenCalledOnce();
      expect(mocks.pollerStart).toHaveBeenCalled();
      expect(mocks.indexBuilderRefresh.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.pollerStart.mock.invocationCallOrder[0]!);
      expect(runtime.refresher).toBeDefined();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('poll mode started'),
      );

      await runtime.shutdown();
      expect(mocks.pollerStop).toHaveBeenCalled();
      expect(runtime.refresher).toBeUndefined();
      stderrSpy.mockRestore();
    });

    it('includes onBaselineRebuild when scip is configured', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { FilePoller } = await import('../src/discovery/poller.js');

      const runtime = new LoreRuntime(makeConfig({
        refreshMode: 'poll',
        scip: { enabled: true, indexerPath: 'scip-typescript', args: [] } as any,
      }));
      await runtime.start();

      const ctorCalls = vi.mocked(FilePoller).mock.calls;
      const lastCall = ctorCalls[ctorCalls.length - 1];
      expect(lastCall?.[2]?.onBaselineRebuild).toBeTypeOf('function');

      await runtime.shutdown();
      stderrSpy.mockRestore();
    });

    it('omits onBaselineRebuild when SCIP is disabled', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const { FilePoller } = await import('../src/discovery/poller.js');
      const runtime = new LoreRuntime(makeConfig({
        refreshMode: 'poll',
        scip: { enabled: false } as any,
      }));

      await runtime.start();
      const lastCall = vi.mocked(FilePoller).mock.calls.at(-1);
      expect(lastCall?.[2]).not.toHaveProperty('scip');
      expect(lastCall?.[2]?.onBaselineRebuild).toBeUndefined();

      await runtime.shutdown();
      stderrSpy.mockRestore();
    });

    it('rejects watch startup clearly when the initial baseline refresh fails', async () => {
      mocks.indexBuilderRefresh.mockRejectedValueOnce(new Error('index unavailable'));
      const runtime = new LoreRuntime(makeConfig({ refreshMode: 'watch' }));

      await expect(runtime.start()).rejects.toThrow(
        'Cannot start watch refresh without a valid baseline: index unavailable',
      );
      expect(mocks.watcherStart).not.toHaveBeenCalled();
      expect(runtime.started).toBe(false);
    });
  });

  describe('shutdown with active resources', () => {
    it('stops refresher on shutdown', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const runtime = new LoreRuntime(makeConfig({ refreshMode: 'watch' }));
      await runtime.start();
      expect(runtime.refresher).toBeDefined();

      await runtime.shutdown();
      expect(mocks.watcherStop).toHaveBeenCalledOnce();
      stderrSpy.mockRestore();
    });

    it('disposes embedder on shutdown', async () => {
      const runtime = new LoreRuntime(makeConfig({ embeddingModel: 'test-model' }));
      await runtime.start();
      expect(runtime.embedder).toBeDefined();

      await runtime.shutdown();
      expect(mocks.embedderDispose).toHaveBeenCalledOnce();
      expect(runtime.embedder).toBeUndefined();
    });

    it('handles embedder dispose error gracefully', async () => {
      mocks.embedderDispose.mockRejectedValueOnce(new Error('dispose failed'));
      const runtime = new LoreRuntime(makeConfig({ embeddingModel: 'test-model' }));
      await runtime.start();

      await expect(runtime.shutdown()).resolves.not.toThrow();
      expect(runtime.embedder).toBeUndefined();
    });
  });

  describe('installSignalHandlers double-signal', () => {
    it('second signal calls killAllTracked and process.exit(1)', async () => {
      const runtime = new LoreRuntime(makeConfig());

      const registeredHandlers: Record<string, Function> = {};
      const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: Function) => {
        registeredHandlers[event] = handler;
        return process;
      }) as any);
      const onceSpy = vi.spyOn(process, 'once').mockImplementation((() => process) as any);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      runtime.installSignalHandlers();

      const sigintHandler = registeredHandlers['SIGINT'] as (() => void) | undefined;
      expect(sigintHandler).toBeDefined();

      // First signal — starts async shutdown
      sigintHandler!();
      // Second signal — force exit
      sigintHandler!();

      expect(mocks.killAllTracked).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);

      // Flush the async shutdown().finally() so process.exit(0) hits
      // our mock rather than Vitest's real process.exit wrapper.
      await new Promise(resolve => setTimeout(resolve, 0));

      onSpy.mockRestore();
      onceSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
