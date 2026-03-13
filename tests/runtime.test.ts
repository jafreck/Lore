/**
 * Unit tests for LoreRuntime lifecycle.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LoreRuntime, type RuntimeConfig } from '../src/runtime.js';
import { initLogger, LogLevel } from '../src/logger.js';

function stubConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const dir = mkdtempSync(join(tmpdir(), 'lore-rt-'));
  return {
    dbPath: join(dir, 'test.db'),
    rootDir: dir,
    walkerConfig: { rootDir: dir },
    lsp: null,
    scip: null,
    history: false,
    indexDependencies: false,
    refreshMode: 'none',
    ...overrides,
  };
}

describe('LoreRuntime', () => {
  let runtime: LoreRuntime | undefined;

  afterEach(async () => {
    if (runtime?.started) await runtime.shutdown();
  });

  it('should start and report started', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    expect(runtime.started).toBe(false);
    await runtime.start();
    expect(runtime.started).toBe(true);
  });

  it('should be a no-op when start is called twice', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    await runtime.start(); // no-op
    expect(runtime.started).toBe(true);
  });

  it('should shutdown cleanly', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    await runtime.shutdown();
    expect(runtime.started).toBe(false);
  });

  it('should be a no-op when shutdown is called without start', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.shutdown(); // no-op
    expect(runtime.started).toBe(false);
  });

  it('should expose embedder as undefined when no model configured', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    expect(runtime.embedder).toBeUndefined();
  });

  it('should expose refresher as undefined in none mode', async () => {
    runtime = new LoreRuntime(stubConfig(), initLogger({ level: LogLevel.SILENT }));
    await runtime.start();
    expect(runtime.refresher).toBeUndefined();
  });

  it('should expose config', () => {
    const cfg = stubConfig();
    runtime = new LoreRuntime(cfg, initLogger({ level: LogLevel.SILENT }));
    expect(runtime.config).toBe(cfg);
  });
});
