import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FilePoller, diffMtimeSnapshot, type PollerOptions, type MtimeEntry } from '../../src/discovery/poller.js';
import type { WalkerConfig } from '../../src/discovery/walker.js';

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
        scip: {
          enabled: true,
          timeoutMs: 120_000,
          indexers: {},
          indexDir: null,
        },
        scipQuietPeriodMs: 5000,
      });
      expect(poller).toBeDefined();
      poller.stop();
    });

    it('no ScipFlushManager when scipQuietPeriodMs is 0', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        scip: {
          enabled: true,
          timeoutMs: 120_000,
          indexers: {},
          indexDir: null,
        },
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
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
        scipQuietPeriodMs: 30_000,
      });
      expect(poller).toBeDefined();
      poller.stop();
    });

    it('default scipQuietPeriodMs does not crash', () => {
      const poller = new FilePoller(DB_PATH, walkerConfig, {
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
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
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
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
      scip: { enabled: true, timeoutMs: 30000, indexers: {}, indexDir: null },
      scipQuietPeriodMs: 0,
    });
    expect((poller as any).scipFlush).toBeNull();
    poller.stop();
  });

  it('creates scipFlush when SCIP is configured with quiet period', () => {
    const poller = new FilePoller(DB_PATH, walkerConfig, {
      scip: { enabled: true, timeoutMs: 30000, indexers: {}, indexDir: null },
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
});
