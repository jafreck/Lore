import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FSWatcher } from 'node:fs';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('node:fs', () => ({
  watch: vi.fn(),
}));

vi.mock('../../src/indexer/index.js', () => ({
  // Must use a regular function (not arrow) so `new IndexBuilder(...)` works
  IndexBuilder: vi.fn(function (this: Record<string, unknown>) {
    this.update = mockUpdate;
  }),
}));

import { FileWatcher } from '../../src/indexer/watcher.js';
import * as fs from 'node:fs';
import { IndexBuilder } from '../../src/indexer/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockWatcher() {
  return { on: vi.fn(), close: vi.fn() };
}

const walkerConfig = { rootDir: '/tmp/testroot' };

// ── Tests ────────────────────────────────────────────────────────────────────

describe('FileWatcher', () => {
  let mockWatcher: ReturnType<typeof makeMockWatcher>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockWatcher = makeMockWatcher();
    vi.mocked(fs.watch).mockReturnValue(mockWatcher as unknown as FSWatcher);

    // Reset update mock to default resolved behaviour
    mockUpdate.mockResolvedValue(undefined);

    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should default debounceMs to 300 and enabled to true', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig);
      watcher.start();
      expect(fs.watch).toHaveBeenCalledOnce();
    });

    it('should respect custom debounceMs option', async () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 50 });
      watcher.start();

      // Simulate a file event
      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'file.ts');

      // Only 50 ms needed, not 300
      await vi.advanceTimersByTimeAsync(50);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe('start()', () => {
    it('should call fs.watch on rootDir with recursive option', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig);
      watcher.start();
      expect(fs.watch).toHaveBeenCalledWith(
        walkerConfig.rootDir,
        { recursive: true },
        expect.any(Function),
      );
    });

    it('should not start when enabled is false', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { enabled: false });
      watcher.start();
      expect(fs.watch).not.toHaveBeenCalled();
    });

    it('should not start a second watcher if already started', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig);
      watcher.start();
      watcher.start();
      expect(fs.watch).toHaveBeenCalledOnce();
    });

    it('should register an error handler on the FSWatcher', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig);
      watcher.start();
      expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('stop()', () => {
    it('should close the underlying FSWatcher', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig);
      watcher.start();
      watcher.stop();
      expect(mockWatcher.close).toHaveBeenCalledOnce();
    });

    it('should not throw when called before start()', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig);
      expect(() => watcher.stop()).not.toThrow();
    });

    it('should cancel a pending debounce timer', async () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 300 });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'file.ts');

      watcher.stop(); // cancel before debounce fires
      await vi.advanceTimersByTimeAsync(500);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('file event debouncing and batching', () => {
    it('should not run overlapping flush cycles while update is in flight', async () => {
      let resolveUpdate!: () => void;
      const updateGate = new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });
      let inFlight = 0;
      let maxInFlight = 0;
      mockUpdate.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await updateGate;
        inFlight--;
      });

      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 50 });
      watcher.start();
      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;

      watchCb('change', 'a.ts');
      await vi.advanceTimersByTimeAsync(50);
      watchCb('change', 'b.ts');
      await vi.advanceTimersByTimeAsync(50);

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(maxInFlight).toBe(1);

      resolveUpdate();
      await vi.advanceTimersByTimeAsync(0);
      watcher.stop();
    });

    it('should call IndexBuilder.update after the debounce window with affected paths', async () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 100 });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'a.ts');
      watchCb('rename', 'b.ts');

      await vi.advanceTimersByTimeAsync(100);

      expect(mockUpdate).toHaveBeenCalledOnce();
      const paths = mockUpdate.mock.calls[0]?.[0] as string[];
      expect(paths).toContain(`${walkerConfig.rootDir}/a.ts`);
      expect(paths).toContain(`${walkerConfig.rootDir}/b.ts`);
    });

    it('should pass the history option to IndexBuilder when flushing updates', async () => {
      const history = { depth: 2, all: true };
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 100, history });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'a.ts');

      await vi.advanceTimersByTimeAsync(100);

      expect(IndexBuilder).toHaveBeenCalledWith('/db.sqlite', walkerConfig, undefined, { history });
    });

    it('should deduplicate repeated events for the same file', async () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 100 });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'a.ts');
      watchCb('change', 'a.ts');
      watchCb('change', 'a.ts');

      await vi.advanceTimersByTimeAsync(100);

      expect(mockUpdate).toHaveBeenCalledOnce();
      const paths = mockUpdate.mock.calls[0]?.[0] as string[];
      expect(paths.filter((p) => p.endsWith('a.ts'))).toHaveLength(1);
    });

    it('should reset the debounce timer on each new event', async () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 100 });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'a.ts');
      await vi.advanceTimersByTimeAsync(90); // not yet fired

      watchCb('change', 'b.ts'); // reset timer
      await vi.advanceTimersByTimeAsync(90); // still not fired

      expect(mockUpdate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10); // now fires
      expect(mockUpdate).toHaveBeenCalledOnce();
    });

    it('should ignore events with a null filename', async () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 100 });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string | null,
      ) => void;
      watchCb('change', null);

      await vi.advanceTimersByTimeAsync(200);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('should write a structured info log to stderr after each flush', async () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 50 });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'x.ts');

      await vi.advanceTimersByTimeAsync(50);

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(written.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.source).toBe('FileWatcher');
      expect(parsed.files).toBe(1);
      expect(parsed.errors).toBe(0);
    });

    it('should write an error log to stderr when IndexBuilder.update throws', async () => {
      mockUpdate.mockRejectedValueOnce(new Error('index failure'));

      const watcher = new FileWatcher('/db.sqlite', walkerConfig, { debounceMs: 50 });
      watcher.start();

      const watchCb = vi.mocked(fs.watch).mock.calls[0]?.[2] as (
        event: string,
        filename: string,
      ) => void;
      watchCb('change', 'y.ts');

      await vi.advanceTimersByTimeAsync(50);

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const lines = written
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const errorLine = lines.find((l) => l.level === 'error');
      expect(errorLine).toBeDefined();
      expect(errorLine.source).toBe('FileWatcher');
    });

    it('should write an error log to stderr when the FSWatcher emits an error', () => {
      const watcher = new FileWatcher('/db.sqlite', walkerConfig);
      watcher.start();

      // Retrieve and invoke the error handler registered via .on('error', ...)
      const [, errorHandler] = mockWatcher.on.mock.calls.find(([event]) => event === 'error')!;
      errorHandler(new Error('watch error'));

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(written.trim());
      expect(parsed.level).toBe('error');
      expect(parsed.source).toBe('FileWatcher');
    });
  });
});
