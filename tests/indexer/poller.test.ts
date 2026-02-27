import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Stats } from 'node:fs';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('node:fs', () => ({
  statSync: vi.fn(),
}));

vi.mock('../../src/indexer/index.js', () => ({
  // Must use a regular function (not arrow) so `new IndexBuilder(...)` works
  IndexBuilder: vi.fn(function (this: Record<string, unknown>) {
    this.update = mockUpdate;
  }),
}));

vi.mock('../../src/indexer/walker.js', () => ({
  walkFiles: vi.fn(),
}));

import { FilePoller } from '../../src/indexer/poller.js';
import * as fs from 'node:fs';
import { IndexBuilder } from '../../src/indexer/index.js';
import { walkFiles } from '../../src/indexer/walker.js';

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

    // Default: empty directory, stat returns mtime 1000
    vi.mocked(walkFiles).mockResolvedValue([]);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as Stats);

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
    it('should call IndexBuilder.update for newly created files', async () => {
      vi.mocked(walkFiles).mockResolvedValue([makeEntry('/tmp/testroot/new.ts')]);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledOnce();
      const paths = mockUpdate.mock.calls[0]?.[0] as string[];
      expect(paths).toContain('/tmp/testroot/new.ts');
    });

    it('should call IndexBuilder.update for files with changed mtime', async () => {
      const file = '/tmp/testroot/changed.ts';

      // First poll — file is new
      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      vi.mocked(fs.statSync).mockReturnValueOnce({ mtimeMs: 1000 } as Stats);

      const poller = new FilePoller('/db.sqlite', walkerConfig, { intervalMs: 100 });
      poller.start();
      await vi.advanceTimersByTimeAsync(100);

      // Second poll — mtime has changed
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 2000 } as Stats);
      await vi.advanceTimersByTimeAsync(100);
      poller.stop();

      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it('should not call IndexBuilder.update for files with unchanged mtime', async () => {
      const file = '/tmp/testroot/stable.ts';

      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as Stats);

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
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as Stats);

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

    it('should log an error when IndexBuilder.update throws', async () => {
      const file = '/tmp/testroot/a.ts';
      vi.mocked(walkFiles).mockResolvedValue([makeEntry(file)]);
      vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 1000 } as Stats);
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
  });
});

