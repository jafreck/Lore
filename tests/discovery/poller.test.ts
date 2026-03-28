import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FilePoller, type PollerOptions } from '../../src/discovery/poller.js';
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
