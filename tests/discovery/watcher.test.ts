import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileWatcher } from '../../src/discovery/watcher.js';
import type { WalkerConfig } from '../../src/discovery/walker.js';
import { effectiveScipSettings } from '../helpers/effective-settings.js';

// vi.spyOn(fs, 'watch') fails in ESM — test constructor/options handling
// and lifecycle via the onUpdate callback seam instead.

const DB_PATH = ':memory:';
const walkerConfig: WalkerConfig = { rootDir: '/tmp/test-watcher-root' };

describe('FileWatcher', () => {
  describe('constructor defaults', () => {
    it('creates a watcher with default options', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig);
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('respects enabled=false', () => {
      // When disabled, start() should be a no-op. If it tried to actually watch,
      // it would fail because the rootDir doesn't exist.
      const watcher = new FileWatcher(DB_PATH, walkerConfig, { enabled: false });
      expect(() => watcher.start()).not.toThrow();
      watcher.stop();
    });
  });

  describe('start/stop lifecycle', () => {
    it('stop is safe when not started', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig);
      expect(() => watcher.stop()).not.toThrow();
    });

    it('stop is safe when called twice', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, { enabled: false });
      watcher.start();
      expect(() => {
        watcher.stop();
        watcher.stop();
      }).not.toThrow();
    });
  });

  describe('options forwarding', () => {
    it('accepts custom debounceMs', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, { debounceMs: 500 });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('accepts history options', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, { history: { depth: 50 } });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('accepts indexDependencies option', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, { indexDependencies: true });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('accepts onUpdate callback', () => {
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, { onUpdate });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('accepts onBaselineRebuild callback', () => {
      const onBaselineRebuild = vi.fn().mockResolvedValue(undefined);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 5000,
        onBaselineRebuild,
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('creates ScipFlushManager when scip options provided', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 5000,
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('no ScipFlushManager when scip not provided', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, { scipQuietPeriodMs: 5000 });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('no ScipFlushManager when SCIP is disabled', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings({ enabled: false }),
        scipQuietPeriodMs: 5000,
      });
      expect((watcher as any).scip).toBeUndefined();
      expect((watcher as any).scipFlush).toBeNull();
      watcher.stop();
    });

    it('no ScipFlushManager when scipQuietPeriodMs is 0', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 0,
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });
  });

  describe('start idempotency with real directory', () => {
    it('start is idempotent — calling twice does not create two watchers', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-watcher-test-'));
      try {
        const cfg: WalkerConfig = { rootDir: tmpDir };
        const watcher = new FileWatcher(DB_PATH, cfg);
        watcher.start();
        // Second call should be no-op (watcher already set)
        watcher.start();
        watcher.stop();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('stop after start cleans up watcher', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-watcher-test-'));
      try {
        const cfg: WalkerConfig = { rootDir: tmpDir };
        const watcher = new FileWatcher(DB_PATH, cfg);
        watcher.start();
        watcher.stop();
        // Second stop should be safe
        watcher.stop();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe('onUpdate callback', () => {
    it('watcher with onUpdate callback constructs without error', () => {
      const onUpdate = vi.fn().mockResolvedValue(undefined);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate,
        debounceMs: 100,
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });
  });

  describe('scipQuietPeriodMs configuration', () => {
    it('accepts custom scipQuietPeriodMs', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
        scipQuietPeriodMs: 30_000,
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('default scipQuietPeriodMs does not crash', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings(),
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });
  });

  describe('flush behavior', () => {
    it('calls onUpdate with accumulated paths', async () => {
      const updates: string[][] = [];
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async (paths) => { updates.push(paths); },
        debounceMs: 10,
      });
      (watcher as any).pendingPaths.add('/tmp/src/file1.ts');
      (watcher as any).pendingPaths.add('/tmp/src/file2.ts');
      await (watcher as any).flush();
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain('/tmp/src/file1.ts');
      expect(updates[0]).toContain('/tmp/src/file2.ts');
      watcher.stop();
    });

    it('clears pendingPaths after flush', async () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async () => {},
      });
      (watcher as any).pendingPaths.add('/tmp/src/file.ts');
      await (watcher as any).flush();
      expect((watcher as any).pendingPaths.size).toBe(0);
      watcher.stop();
    });

    it('skips flush when no pending paths', async () => {
      const updates: string[][] = [];
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async (paths) => { updates.push(paths); },
      });
      await (watcher as any).flush();
      expect(updates).toHaveLength(0);
      watcher.stop();
    });

    it('logs error when onUpdate throws', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async () => { throw new Error('update failed'); },
      });
      (watcher as any).pendingPaths.add('/tmp/src/file.ts');
      await (watcher as any).flush();
      const errorCalls = stderrSpy.mock.calls.filter(c => {
        const msg = String(c[0]);
        return msg.includes('error') || msg.includes('Error');
      });
      expect(errorCalls.length).toBeGreaterThan(0);
      stderrSpy.mockRestore();
      watcher.stop();
    });

    it('retains a failed batch and retries it without another filesystem event', async () => {
      const onUpdate = vi.fn()
        .mockRejectedValueOnce(new Error('transient update failure'))
        .mockResolvedValueOnce(undefined);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate,
        debounceMs: 60_000,
      });
      const changedPath = '/tmp/src/retry.ts';
      (watcher as any).pendingPaths.add(changedPath);

      await (watcher as any).flush();
      expect((watcher as any).pendingPaths.has(changedPath)).toBe(true);

      // Cancel the automatic retry timer and invoke the retained batch now.
      watcher.stop();
      await (watcher as any).flush();
      expect(onUpdate).toHaveBeenNthCalledWith(1, [changedPath]);
      expect(onUpdate).toHaveBeenNthCalledWith(2, [changedPath]);
      expect((watcher as any).pendingPaths.size).toBe(0);

      stderrSpy.mockRestore();
      watcher.stop();
    });

    it('does not schedule a retry when an in-flight update fails after stop', async () => {
      let rejectUpdate: ((reason?: unknown) => void) | undefined;
      const onUpdate = vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectUpdate = reject;
      }));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate,
        debounceMs: 60_000,
      });
      const changedPath = '/tmp/src/stopped-retry.ts';
      (watcher as any).pendingPaths.add(changedPath);

      const flush = (watcher as any).flush() as Promise<void>;
      expect(onUpdate).toHaveBeenCalledWith([changedPath]);
      watcher.stop();
      rejectUpdate!(new Error('update failed after stop'));
      await flush;

      expect((watcher as any).pendingPaths.has(changedPath)).toBe(true);
      expect((watcher as any).debounceTimer).toBeNull();
      stderrSpy.mockRestore();
    });

    it('writes info log after successful flush', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async () => {},
      });
      (watcher as any).pendingPaths.add('/tmp/src/file.ts');
      await (watcher as any).flush();
      const infoCalls = stderrSpy.mock.calls.filter(c => {
        const msg = String(c[0]);
        return msg.includes('refresh cycle complete');
      });
      expect(infoCalls.length).toBeGreaterThan(0);
      stderrSpy.mockRestore();
      watcher.stop();
    });

    it('prevents concurrent flush execution', async () => {
      let flushCount = 0;
      let resolveFlush: (() => void) | null = null;
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async () => {
          flushCount++;
          await new Promise<void>(r => { resolveFlush = r; });
        },
      });
      (watcher as any).pendingPaths.add('/tmp/src/a.ts');
      const flush1 = (watcher as any).flush();
      (watcher as any).pendingPaths.add('/tmp/src/b.ts');
      const flush2 = (watcher as any).flush();
      await flush2;
      expect(flushCount).toBe(1);
      resolveFlush!();
      await flush1;
      watcher.stop();
    });

    it('re-schedules flush if new paths arrived during flush', async () => {
      const updates: string[][] = [];
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async (paths) => {
          updates.push([...paths]);
          if (updates.length === 1) {
            (watcher as any).pendingPaths.add('/tmp/src/late.ts');
          }
        },
        debounceMs: 1,
      });
      (watcher as any).pendingPaths.add('/tmp/src/early.ts');
      await (watcher as any).flush();
      expect((watcher as any).debounceTimer).not.toBeNull();
      watcher.stop();
    });

    it('still logs info after onUpdate error', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async () => { throw new Error('boom'); },
      });
      (watcher as any).pendingPaths.add('/tmp/src/file.ts');
      await (watcher as any).flush();
      const infoCalls = stderrSpy.mock.calls.filter(c => {
        const msg = String(c[0]);
        return msg.includes('refresh cycle complete') && msg.includes('"errors":1');
      });
      expect(infoCalls.length).toBeGreaterThan(0);
      stderrSpy.mockRestore();
      watcher.stop();
    });
  });

  describe('scheduleFlush', () => {
    it('resets debounce timer on repeated calls', () => {
      vi.useFakeTimers();
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async () => {},
        debounceMs: 100,
      });
      (watcher as any).scheduleFlush();
      const timer1 = (watcher as any).debounceTimer;
      expect(timer1).not.toBeNull();
      (watcher as any).scheduleFlush();
      const timer2 = (watcher as any).debounceTimer;
      expect(timer2).not.toBeNull();
      watcher.stop();
      vi.useRealTimers();
    });
  });

  describe('SCIP flush integration', () => {
    it('accumulates paths to scipFlush after update', async () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        onUpdate: async () => {},
        scip: effectiveScipSettings({ timeoutMs: 30_000 }),
        scipQuietPeriodMs: 5000,
      });
      const scipFlush = (watcher as any).scipFlush;
      expect(scipFlush).not.toBeNull();

      const accumulateSpy = vi.spyOn(scipFlush, 'accumulate');
      (watcher as any).pendingPaths.add('/tmp/src/file.ts');
      await (watcher as any).flush();
      expect(accumulateSpy).toHaveBeenCalledWith(['/tmp/src/file.ts']);
      accumulateSpy.mockRestore();
      watcher.stop();
    });

    it('does not create scipFlush when scipQuietPeriodMs is 0', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: effectiveScipSettings({ timeoutMs: 30_000 }),
        scipQuietPeriodMs: 0,
      });
      expect((watcher as any).scipFlush).toBeNull();
      watcher.stop();
    });
  });
});
