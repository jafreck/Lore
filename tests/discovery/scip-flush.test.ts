import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScipFlushManager, type ScipFlushConfig } from '../../src/discovery/scip-flush.js';

function makeConfig(overrides?: Partial<ScipFlushConfig>): ScipFlushConfig {
  return {
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp/test-scip-flush' },
    embedder: undefined,
    history: false,
    indexDependencies: false,
    lsp: undefined,
    scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
    scipQuietPeriodMs: 500,
    source: 'test',
    ...overrides,
  };
}

describe('ScipFlushManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a flush after quiet period', async () => {
    const onBaselineRebuild = vi.fn().mockResolvedValue(undefined);
    const manager = new ScipFlushManager(makeConfig({ onBaselineRebuild, scipQuietPeriodMs: 200 }));

    manager.accumulate(['/tmp/test/a.ts']);

    // Not yet flushed
    await vi.advanceTimersByTimeAsync(100);
    expect(onBaselineRebuild).not.toHaveBeenCalled();

    // Now past the quiet period
    await vi.advanceTimersByTimeAsync(150);
    expect(onBaselineRebuild).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it('resets timer on subsequent accumulate calls', async () => {
    const onBaselineRebuild = vi.fn().mockResolvedValue(undefined);
    const manager = new ScipFlushManager(makeConfig({ onBaselineRebuild, scipQuietPeriodMs: 200 }));

    manager.accumulate(['/tmp/test/a.ts']);
    await vi.advanceTimersByTimeAsync(150);
    manager.accumulate(['/tmp/test/b.ts']);
    await vi.advanceTimersByTimeAsync(150);

    // Still shouldn't have fired — timer was reset
    expect(onBaselineRebuild).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(onBaselineRebuild).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it('cancel prevents pending flush', async () => {
    const onBaselineRebuild = vi.fn().mockResolvedValue(undefined);
    const manager = new ScipFlushManager(makeConfig({ onBaselineRebuild, scipQuietPeriodMs: 200 }));

    manager.accumulate(['/tmp/test/a.ts']);
    manager.cancel();
    await vi.advanceTimersByTimeAsync(300);

    expect(onBaselineRebuild).not.toHaveBeenCalled();
    manager.stop();
  });

  it('stop prevents any future scheduling', async () => {
    const onBaselineRebuild = vi.fn().mockResolvedValue(undefined);
    const manager = new ScipFlushManager(makeConfig({ onBaselineRebuild, scipQuietPeriodMs: 200 }));

    manager.stop();
    manager.accumulate(['/tmp/test/a.ts']);
    await vi.advanceTimersByTimeAsync(300);

    expect(onBaselineRebuild).not.toHaveBeenCalled();
  });

  it('does not flush when no paths accumulated', async () => {
    const onBaselineRebuild = vi.fn().mockResolvedValue(undefined);
    const manager = new ScipFlushManager(makeConfig({ onBaselineRebuild, scipQuietPeriodMs: 100 }));

    // Accumulate empty array: won't add any paths
    manager.accumulate([]);

    // Now an internal schedule was created but pathsSinceLastScip is empty
    // when flush fires, it should short-circuit
    await vi.advanceTimersByTimeAsync(150);
    expect(onBaselineRebuild).not.toHaveBeenCalled();

    manager.stop();
  });
});
