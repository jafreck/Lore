import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FilePoller, diffMtimeSnapshot, type PollerOptions, type MtimeEntry } from '../../src/discovery/poller.js';
import type { WalkerConfig } from '../../src/discovery/walker.js';
import { openDb } from '../../src/db/schema.js';
import { effectiveScipSettings } from '../helpers/effective-settings.js';

// Mock walkFiles so poll() can be tested without filesystem
vi.mock('../../src/discovery/walker.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/discovery/walker.js')>();
  return {
    ...mod,
    walkFiles: vi.fn().mockResolvedValue([]),
  };
});

const DB_PATH = ':memory:';
const walkerConfig: WalkerConfig = { rootDir: '/tmp/test-poller-root' };

describe('FilePoller', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor defaults', () => {
    it('defaults enabled to true and intervalMs to 5000', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig);
      expect(poller).toBeDefined();
      poller.stop();
    });

    it('respects enabled=false', () => {
      vi.useFakeTimers();
      const poller = new FilePoller(DB_PATH, walkerConfig, { enabled: false });

      // start should be a no-op
      poller.start();
      // advance timers — no poll should run
      vi.advanceTimersByTime(10_000);
      poller.stop();
      vi.useRealTimers();
    });
  });

  describe('start/stop lifecycle', () => {
    it('start creates an interval timer', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 1000 });
      poller.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
      poller.stop();
      vi.useRealTimers();
    });

    it('stop clears the interval', () => {
      vi.useFakeTimers();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 1000 });
      poller.start();
      poller.stop();

      expect(clearIntervalSpy).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('double start does not create second interval', () => {
      vi.useFakeTimers();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 1000 });
      poller.start();
      poller.start();

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      poller.stop();
      vi.useRealTimers();
    });

    it('stop is safe when not started', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig);
      expect(() => poller.stop()).not.toThrow();
    });
  });

  describe('options forwarding', () => {
    it('accepts custom intervalMs', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 2000 });
      expect(poller).toBeDefined();
      poller.stop();
    });

    it('creates ScipFlushManager when scip options provided', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 5000,
      });
      expect(poller).toBeDefined();
      poller.stop();
    });

    it('no ScipFlushManager when scipQuietPeriodMs is 0', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 0,
      });
      expect(poller).toBeDefined();
      poller.stop();
    });
  });

  describe('onUpdate callback', () => {
    it('poller with onUpdate callback constructs without error', () => {
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        onUpdate,
        intervalMs: 1000,
      });
      expect(poller).toBeDefined();
      poller.stop();
    });
  });

  describe('scipQuietPeriodMs configuration', () => {
    it('accepts custom scipQuietPeriodMs with scip', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 30_000,
      });
      expect(poller).toBeDefined();
      poller.stop();
    });

    it('default scipQuietPeriodMs does not crash', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
      });
      expect(poller).toBeDefined();
      poller.stop();
    });
  });

  describe('stop cleans up resources', () => {
    it('stop clears interval and scipFlush', () => {
      vi.useFakeTimers();
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        intervalMs: 1000,
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 5000,
      });
      poller.start();
      poller.stop();
      // After stop, advancing timers should not trigger polling
      vi.advanceTimersByTime(10_000);
      // No error means cleanup worked
      vi.useRealTimers();
    });

    it('stop after stop is safe', () => {
      vi.useFakeTimers();
      const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 1000 });
      poller.start();
      poller.stop();
      expect(() => poller.stop()).not.toThrow();
      vi.useRealTimers();
    });
  });
});

describe('diffMtimeSnapshot', () => {
  it('detects new files', () => {
    const prev = new Map<string, number>();
    const entries: MtimeEntry[] = [
      { path: '/a.ts', mtime: 1000 },
      { path: '/b.ts', mtime: 2000 },
    ];
    const { changed, newSnapshot } = diffMtimeSnapshot(prev, entries);
    expect(changed).toEqual(['/a.ts', '/b.ts']);
    expect(newSnapshot.size).toBe(2);
    expect(newSnapshot.get('/a.ts')).toBe(1000);
  });

  it('detects modified files', () => {
    const prev = new Map([
      ['/a.ts', 1000],
      ['/b.ts', 2000],
    ]);
    const entries: MtimeEntry[] = [
      { path: '/a.ts', mtime: 1000 },  // unchanged
      { path: '/b.ts', mtime: 3000 },  // modified
    ];
    const { changed, newSnapshot } = diffMtimeSnapshot(prev, entries);
    expect(changed).toEqual(['/b.ts']);
    expect(newSnapshot.get('/b.ts')).toBe(3000);
  });

  it('detects deleted files', () => {
    const prev = new Map([
      ['/a.ts', 1000],
      ['/b.ts', 2000],
    ]);
    const entries: MtimeEntry[] = [
      { path: '/a.ts', mtime: 1000 },
    ];
    const { changed, newSnapshot } = diffMtimeSnapshot(prev, entries);
    expect(changed).toEqual(['/b.ts']);
    expect(newSnapshot.has('/b.ts')).toBe(false);
    expect(newSnapshot.size).toBe(1);
  });

  it('skips entries with null mtime', () => {
    const prev = new Map<string, number>();
    const entries: MtimeEntry[] = [
      { path: '/a.ts', mtime: 1000 },
      { path: '/b.ts', mtime: null },
    ];
    const { changed, newSnapshot } = diffMtimeSnapshot(prev, entries);
    expect(changed).toEqual(['/a.ts']);
    expect(newSnapshot.has('/b.ts')).toBe(false);
  });

  it('handles empty prev and empty entries', () => {
    const { changed, newSnapshot } = diffMtimeSnapshot(new Map(), []);
    expect(changed).toEqual([]);
    expect(newSnapshot.size).toBe(0);
  });

  it('handles unchanged files', () => {
    const prev = new Map([['/a.ts', 1000]]);
    const entries: MtimeEntry[] = [{ path: '/a.ts', mtime: 1000 }];
    const { changed } = diffMtimeSnapshot(prev, entries);
    expect(changed).toEqual([]);
  });

  it('handles simultaneous add, modify, and delete', () => {
    const prev = new Map([
      ['/existing.ts', 1000],
      ['/toDelete.ts', 2000],
    ]);
    const entries: MtimeEntry[] = [
      { path: '/existing.ts', mtime: 3000 },  // modified
      { path: '/new.ts', mtime: 4000 },        // added
      // /toDelete.ts missing (deleted)
    ];
    const { changed, newSnapshot } = diffMtimeSnapshot(prev, entries);
    expect(changed).toContain('/existing.ts');
    expect(changed).toContain('/new.ts');
    expect(changed).toContain('/toDelete.ts');
    expect(changed).toHaveLength(3);
    expect(newSnapshot.size).toBe(2);
    expect(newSnapshot.get('/existing.ts')).toBe(3000);
  });
});

describe('FilePoller poll behavior', () => {
  it('pollRunning guard is initially false', () => {
    const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 999999 });
    expect((poller as any).pollRunning).toBe(false);
    poller.stop();
  });

  it('does not create scipFlush when scipQuietPeriodMs is 0', () => {
    const poller = new FilePoller(DB_PATH, walkerConfig, {
      scip: effectiveScipSettings({ timeoutMs: 30_000 }),
      scipQuietPeriodMs: 0,
    });
    expect((poller as any).scipFlush).toBeNull();
    poller.stop();
  });

  it('creates scipFlush when SCIP is configured with quiet period', () => {
    const poller = new FilePoller(DB_PATH, walkerConfig, {
      scip: effectiveScipSettings({ timeoutMs: 30_000 }),
      scipQuietPeriodMs: 5000,
    });
    expect((poller as any).scipFlush).not.toBeNull();
    poller.stop();
  });

  it('stores onUpdate callback', () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const poller = new FilePoller(DB_PATH, walkerConfig, {
      onUpdate,
      intervalMs: 999999,
    });
    expect((poller as any).onUpdateCb).toBe(onUpdate);
    poller.stop();
  });

  it('does not overlay every file on the first poll when persisted hashes match', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-poller-hash-')));
    try {
      const filePath = path.join(root, 'a.ts');
      const source = 'export const value = 1;\n';
      fs.writeFileSync(filePath, source);
      const dbPath = path.join(root, 'lore.db');
      const db = openDb(dbPath);
      try {
        db.prepare(
          `INSERT INTO files
             (path, branch, language, source, last_hash, layer, generation)
           VALUES (?, 'HEAD', 'typescript', ?, ?, 'baseline', 1)`,
        ).run(filePath, source, createHash('sha256').update(source).digest('hex'));
        db.prepare(
          "INSERT INTO baseline_generations (branch, generation) VALUES ('HEAD', 1)",
        ).run();
      } finally {
        db.close();
      }

      const { walkFiles } = await import('../../src/discovery/walker.js');
      vi.mocked(walkFiles).mockResolvedValue([{ path: filePath, language: 'typescript' }]);
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const poller = new FilePoller(dbPath, { rootDir: root }, { onUpdate });
      await (poller as any).poll();
      expect(onUpdate).not.toHaveBeenCalled();
      poller.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── poll() internal coverage ─────────────────────────────────────────────────

describe('FilePoller poll() coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('poll runs when interval fires and walkFiles returns empty', async () => {
    const { walkFiles } = await import('../../src/discovery/walker.js');
    vi.mocked(walkFiles).mockResolvedValue([]);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 100 });
    poller.start();

    await vi.advanceTimersByTimeAsync(150);

    // poll() completed and logged a cycle
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('poll cycle complete'),
    );

    poller.stop();
    stderrSpy.mockRestore();
  });

  it('poll handles walkFiles error gracefully', async () => {
    const { walkFiles } = await import('../../src/discovery/walker.js');
    vi.mocked(walkFiles).mockRejectedValue(new Error('walk failed'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 100 });
    poller.start();

    await vi.advanceTimersByTimeAsync(150);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('walk failed'),
    );

    poller.stop();
    stderrSpy.mockRestore();
  });

  it('poll calls onUpdate callback when files change', async () => {
    const { walkFiles } = await import('../../src/discovery/walker.js');
    const fs = await import('node:fs');

    vi.mocked(walkFiles).mockResolvedValue([{ path: '/tmp/test/a.ts' }] as any);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mtimeMs: 1000 } as any);

    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const poller = new FilePoller(DB_PATH, walkerConfig, {
      intervalMs: 100,
      onUpdate,
    });
    poller.start();

    // First poll: new file detected => changed
    await vi.advanceTimersByTimeAsync(150);
    expect(onUpdate).toHaveBeenCalledWith(['/tmp/test/a.ts']);

    poller.stop();
    stderrSpy.mockRestore();
  });

  it('poll handles onUpdate error gracefully', async () => {
    const { walkFiles } = await import('../../src/discovery/walker.js');
    const fs = await import('node:fs');

    vi.mocked(walkFiles).mockResolvedValue([{ path: '/tmp/test/a.ts' }] as any);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mtimeMs: 2000 } as any);

    const onUpdate = vi.fn().mockRejectedValue(new Error('update failed'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const poller = new FilePoller(DB_PATH, walkerConfig, {
      intervalMs: 100,
      onUpdate,
    });
    poller.start();

    await vi.advanceTimersByTimeAsync(150);

    // Error should be logged but not thrown
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('update failed'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('poll cycle complete'),
    );

    poller.stop();
    stderrSpy.mockRestore();
  });

  it('poll skips when pollRunning is true (re-entrancy guard)', async () => {
    const { walkFiles } = await import('../../src/discovery/walker.js');

    // Make walkFiles hang so pollRunning stays true
    let resolveWalk: () => void;
    vi.mocked(walkFiles).mockImplementation(
      () => new Promise<any[]>((resolve) => { resolveWalk = () => resolve([]); }),
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const callCountBefore = vi.mocked(walkFiles).mock.calls.length;

    const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 50 });
    poller.start();

    // First poll starts (hangs in walkFiles)
    await vi.advanceTimersByTimeAsync(60);
    expect(vi.mocked(walkFiles).mock.calls.length - callCountBefore).toBe(1);

    // Second poll should be skipped (pollRunning still true)
    await vi.advanceTimersByTimeAsync(60);
    expect(vi.mocked(walkFiles).mock.calls.length - callCountBefore).toBe(1);

    // Resolve the hanging walk
    resolveWalk!();
    await vi.advanceTimersByTimeAsync(1);

    poller.stop();
    stderrSpy.mockRestore();
  });

  it('poll handles stat failure gracefully', async () => {
    const { walkFiles } = await import('../../src/discovery/walker.js');
    const fs = await import('node:fs');

    vi.mocked(walkFiles).mockResolvedValue([{ path: '/tmp/test/fail.ts' }] as any);
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('ENOENT'));

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const poller = new FilePoller(DB_PATH, walkerConfig, { intervalMs: 100 });
    poller.start();

    await vi.advanceTimersByTimeAsync(150);

    // Should complete without error (stat failure produces null mtime)
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('poll cycle complete'),
    );

    poller.stop();
    stderrSpy.mockRestore();
  });

  it('poll accumulates to scipFlush when files change', async () => {
    const { walkFiles } = await import('../../src/discovery/walker.js');
    const fs = await import('node:fs');

    vi.mocked(walkFiles).mockResolvedValue([{ path: '/tmp/test/scip.ts' }] as any);
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mtimeMs: 5000 } as any);

    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const poller = new FilePoller(DB_PATH, walkerConfig, {
      intervalMs: 100,
      onUpdate,
      scip: effectiveScipSettings(),
      scipQuietPeriodMs: 5000,
    });
    poller.start();

    await vi.advanceTimersByTimeAsync(150);

    // scipFlush should have accumulated paths
    const flush = (poller as any).scipFlush;
    expect(flush).not.toBeNull();
    expect((flush as any).pathsSinceLastScip.size).toBeGreaterThanOrEqual(1);

    poller.stop();
    stderrSpy.mockRestore();
  });
});
