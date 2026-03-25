import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Stats } from 'node:fs';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockBaselineRebuild = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockStat = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({
  statSync: vi.fn(),
  promises: {
    stat: mockStat,
  },
}));

vi.mock('../../src/indexer/index.js', () => ({
  // Must use a regular function (not arrow) so `new IndexBuilder(...)` works
  IndexBuilder: vi.fn(function (this: Record<string, unknown>) {
    this.update = mockUpdate;
    this.baselineRebuild = mockBaselineRebuild;
  }),
}));

vi.mock('../../src/discovery/walker.js', () => ({
  walkFiles: vi.fn(),
}));

import { FilePoller } from '../../src/discovery/poller.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import { walkFiles } from '../../src/discovery/walker.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const walkerConfig = { rootDir: '/tmp/testroot' };

function makeEntry(path: string) {
  return { path };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('FilePoller', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Reset update mock to default resolved behaviour
    mockUpdate.mockResolvedValue(undefined);

    // Default: empty directory, stats throw (no files present)
    vi.mocked(walkFiles).mockResolvedValue([]);
    mockStat.mockRejectedValue(new Error('missing file'));

    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    stderrSpy.mockRestore();
  });

  describe('constructor', () => {
    it('should default intervalMs to 5000 and enabled to true', () => {
      const poller = new FilePoller('/db.sqlite', walkerConfig);
      poller.start();
      // Timer is set but hasn't fired yet
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      poller.stop();
    });
  });

  describe('start()', () => {
    it('should begin polling at the configured interval', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/a.ts')]);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 500 });
      poller.start();

      await vi.advanceTimersByTimeAsync(500);
      expect(walkFiles).toHaveBeenCalledOnce();
      poller.stop();
    });

    it('should not start when enabled is false', async () => {
      const poller = new FilePoller('/db.sqlite', walkerConfig, { enabled: false });
      poller.start();
      await vi.advanceTimersByTimeAsync(10000);
      expect(walkFiles).not.toHaveBeenCalled();
    });

    it('should not start a second interval if already started', () => {
      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 500 });
      poller.start();
      const timerCountAfterFirst = vi.getTimerCount();
      poller.start();
      expect(vi.getTimerCount()).toBe(timerCountAfterFirst);
      poller.stop();
    });
  });

  describe('stop()', () => {
    it('should halt polling', async () => {
      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 500 });
      poller.start();
      poller.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(walkFiles).not.toHaveBeenCalled();
    });

    it('should not throw when called before start()', () => {
      const poller = new FilePoller('/db.sqlite', walkerConfig);
      expect(() => poller.stop()).not.toThrow();
    });
  });

  describe('poll() — change detection', () => {
    it('should not run overlapping poll cycles while update is in flight', async () => {
      const file = '/tmp/testroot/overlap.ts';
      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      let mtime = 0;
      mockStat.mockImplementation(async () => ({ mtimeMs: ++mtime } as Stats));

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

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 50 });
      poller.start();
      await vi.advanceTimersByTimeAsync(150);

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(maxInFlight).toBe(1);

      resolveUpdate();
      await vi.advanceTimersByTimeAsync(0);
      poller.stop();
    });

    it('should call IndexBuilder.update for newly created files', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/new.ts')]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledOnce();
      const paths = mockUpdate.mock.calls[0]?.[0] as string[];
      expect(paths).toContain('/tmp/testroot/new.ts');
    });

    it('should pass the history option to IndexBuilder when applying updates', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/new.ts')]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const history = { depth: 3, all: true };
      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100, history });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(IndexBuilder).toHaveBeenCalledWith('/db.sqlite', walkerConfig, undefined, { history });
    });

    it('should pass the embedder to IndexBuilder when provided', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/new.ts')]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const mockEmbedder = { embed: vi.fn(), init: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined), modelName: 'test-model', dims: 128 };
      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100, embedder: mockEmbedder });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(IndexBuilder).toHaveBeenCalledWith('/db.sqlite', walkerConfig, mockEmbedder, expect.any(Object));
    });

    it('should not dispose the embedder when stop() is called', () => {
      const mockEmbedder = { embed: vi.fn(), init: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined), modelName: 'test-model', dims: 128 };
      const poller = new FilePoller('/db.sqlite', walkerConfig, { embedder: mockEmbedder });
      poller.start();
      poller.stop();
      expect(mockEmbedder.dispose).not.toHaveBeenCalled();
    });

    it('should call IndexBuilder.update for files with changed mtime', async () => {
      const file = '/tmp/testroot/changed.ts';

      // First poll — file is new
      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      mockStat.mockResolvedValueOnce({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);

      // Second poll — mtime has changed
      mockStat.mockResolvedValue({ mtimeMs: 2000 } as Stats);
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it('should not call IndexBuilder.update for files with unchanged mtime', async () => {
      const file = '/tmp/testroot/stable.ts';

      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100); // first poll — new file, added to snapshot
      await vi.advanceTimersByTimeAsync(100); // second poll — same mtime
      poller.stop();

      // First poll counts as a change (new file); second poll should NOT call update again
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('should detect deleted files (in snapshot but removed from walk)', async () => {
      const file = '/tmp/testroot/deleted.ts';

      // First poll — file exists
      vi.mocked(walkFiles).mockResolvedValueOnce([makeEntry(file)]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);

      // Second poll — file is gone
      vi.mocked(walkFiles).mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledTimes(2);
      const secondCallPaths = mockUpdate.mock.calls[1]?.[0] as string[];
      expect(secondCallPaths).toContain(file);
    });

    it('should detect newly created coverage reports', async () => {
      const coverageFile = '/tmp/testroot/coverage/lcov.info';
      vi.mocked(walkFiles).mockResolvedValue([]);
      mockStat.mockImplementation(async (filePath) => {
        if (filePath === coverageFile) return { mtimeMs: 1000 } as Stats;
        throw new Error('missing file');
      });

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledOnce();
      const paths = mockUpdate.mock.calls[0]?.[0] as string[];
      expect(paths).toContain(coverageFile);
    });

    it('should detect modified coverage reports', async () => {
      const coverageFile = '/tmp/testroot/coverage/lcov.info';
      vi.mocked(walkFiles).mockResolvedValue([]);
      let mtime = 1000;
      mockStat.mockImplementation(async (filePath) => {
        if (filePath === coverageFile) return { mtimeMs: mtime } as Stats;
        throw new Error('missing file');
      });

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      mtime = 2000;
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledTimes(2);
      const secondCallPaths = mockUpdate.mock.calls[1]?.[0] as string[];
      expect(secondCallPaths).toContain(coverageFile);
    });

    it('should detect deleted coverage reports', async () => {
      const coverageFile = '/tmp/testroot/coverage/lcov.info';
      vi.mocked(walkFiles).mockResolvedValue([]);
      let exists = true;
      mockStat.mockImplementation(async (filePath) => {
        if (filePath === coverageFile && exists) return { mtimeMs: 1000 } as Stats;
        throw new Error('missing file');
      });

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      exists = false;
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledTimes(2);
      const secondCallPaths = mockUpdate.mock.calls[1]?.[0] as string[];
      expect(secondCallPaths).toContain(coverageFile);
    });

    it('should not call IndexBuilder.update when nothing has changed', async () => {
      vi.mocked(walkFiles).mockResolvedValue([]);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('should write a structured info log to stderr after each poll cycle', async () => {
      vi.mocked(walkFiles).mockResolvedValue([]);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(written.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.source).toBe('FilePoller');
      expect(parsed.message).toBe('poll cycle complete');
      expect(typeof parsed.changed).toBe('number');
    });

    it('should log an error and return early when walkFiles throws', async () => {
      vi.mocked(walkFiles).mockRejectedValue(new Error('walk failed'));

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const parsed = JSON.parse(written.trim());
      expect(parsed.level).toBe('error');
      expect(parsed.source).toBe('FilePoller');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should continue polling after a walkFiles failure on a prior cycle', async () => {
      const file = '/tmp/testroot/recovered.ts';
      vi.mocked(walkFiles)
        .mockRejectedValueOnce(new Error('walk failed'))
        .mockResolvedValueOnce([makeEntry(file)]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(200);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const paths = mockUpdate.mock.calls[0]?.[0] as string[];
      expect(paths).toContain(file);
    });

    it('should log an error when IndexBuilder.update throws', async () => {
      const file = '/tmp/testroot/a.ts';
      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);
      mockUpdate.mockRejectedValueOnce(new Error('update failed'));

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const lines = written
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const errorLine = lines.find((l: { level: string }) => l.level === 'error');
      expect(errorLine).toBeDefined();
      expect(errorLine.source).toBe('FilePoller');

      // Info log should still be written after the error
      const infoLine = lines.find((l: { level: string }) => l.level === 'info');
      expect(infoLine).toBeDefined();
      expect(infoLine.errors).toBe(1);
    });

    it('should continue polling after an update failure on a prior cycle', async () => {
      const file = '/tmp/testroot/recovered-after-update-failure.ts';
      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      let mtime = 0;
      mockStat.mockImplementation(async () => ({ mtimeMs: ++mtime } as Stats));
      mockUpdate.mockRejectedValueOnce(new Error('update failed'));

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(200);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });
  });

  describe('SCIP throttling', () => {
    const scipSettings = { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null };

    it('should not include SCIP on immediate poll when scipQuietPeriodMs > 0', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/a.ts')]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, {
        intervalMs: 100,
        scip: scipSettings,
        scipQuietPeriodMs: 5000,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledOnce();
      const opts = vi.mocked(IndexBuilder).mock.calls[0]![3] as Record<string, unknown>;
      expect(opts.scip).toBeUndefined();
    });

    it('should schedule a baseline rebuild after the quiet period', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/a.ts')]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, {
        intervalMs: 100,
        scip: scipSettings,
        scipQuietPeriodMs: 500,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(100); // first poll detects new file

      expect(mockUpdate).toHaveBeenCalledOnce();

      // Wait for SCIP quiet period (mtime unchanged so no new overlay update)
      await vi.advanceTimersByTimeAsync(500);
      poller.stop();

      expect(mockBaselineRebuild).toHaveBeenCalledOnce();
      const opts = vi.mocked(IndexBuilder).mock.calls[1]![3] as Record<string, unknown>;
      expect(opts.scip).toEqual(scipSettings);
    });

    it('should cancel SCIP timer on stop()', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/a.ts')]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, {
        intervalMs: 100,
        scip: scipSettings,
        scipQuietPeriodMs: 500,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      // Clear timer counts to isolate SCIP timer check
      await vi.advanceTimersByTimeAsync(1000);
      // Only the initial update should have run
      expect(mockUpdate).toHaveBeenCalledOnce();
    });

    it('should not schedule baseline rebuilds when scipQuietPeriodMs is 0', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/a.ts')]);
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, {
        intervalMs: 100,
        scip: scipSettings,
        scipQuietPeriodMs: 0,
      });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledOnce();
      // Overlay updates never include SCIP
      const opts = vi.mocked(IndexBuilder).mock.calls[0]![3] as Record<string, unknown>;
      expect(opts.scip).toBeUndefined();
      expect(mockBaselineRebuild).not.toHaveBeenCalled();
    });
  });
});
