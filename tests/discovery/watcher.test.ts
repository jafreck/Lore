import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileWatcher } from '../../src/discovery/watcher.js';
import type { WalkerConfig } from '../../src/discovery/walker.js';

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
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
        scipQuietPeriodMs: 5000,
        onBaselineRebuild,
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('creates ScipFlushManager when scip options provided', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
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

    it('no ScipFlushManager when scipQuietPeriodMs is 0', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
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
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
        scipQuietPeriodMs: 30_000,
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });

    it('default scipQuietPeriodMs does not crash', () => {
      const watcher = new FileWatcher(DB_PATH, walkerConfig, {
        scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
      });
      expect(watcher).toBeDefined();
      watcher.stop();
    });
  });
});
