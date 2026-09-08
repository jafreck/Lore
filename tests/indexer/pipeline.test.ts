import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import type { PipelineContext, PipelineStage } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

/** Factory for a mock stage. */
function mockStage(name: string, opts?: {
  executeFn?: (ctx: PipelineContext, mode: 'build' | 'update') => Promise<void>;
  disposeFn?: () => Promise<void>;
}): PipelineStage {
  return {
    name,
    execute: opts?.executeFn ?? vi.fn(async () => {}),
    dispose: opts?.disposeFn ?? vi.fn(async () => {}),
  };
}

describe('IndexPipeline', () => {
  let ctx: PipelineContext;

  beforeEach(() => {
    resetLogger();
    const log = initLogger({ level: LogLevel.SILENT });
    ctx = {
      db: {} as any,
      dbPath: ':memory:',
      walkerConfig: { rootDir: '/tmp/test' } as any,
      branch: 'main',
      lsp: null,
      scip: null,
      embedder: null,
      log,
      files: [],
      indexDependencies: false,
      history: false,
      staleSymbolIds: [],
      changedSourcePaths: [],
      sourceCache: new Map(),
      layer: 'baseline',
      generation: 1,
    };
  });

  it('executes stages sequentially in order', async () => {
    const order: string[] = [];
    const s1 = mockStage('stage-1', {
      executeFn: async () => { order.push('s1'); },
    });
    const s2 = mockStage('stage-2', {
      executeFn: async () => { order.push('s2'); },
    });
    const s3 = mockStage('stage-3', {
      executeFn: async () => { order.push('s3'); },
    });

    const pipeline = new IndexPipeline([s1, s2, s3]);
    await pipeline.run(ctx, 'build');

    expect(order).toEqual(['s1', 's2', 's3']);
  });

  it('runs parallel groups concurrently', async () => {
    const starts: string[] = [];
    const ends: string[] = [];

    const makeDelayed = (name: string, ms: number): PipelineStage =>
      mockStage(name, {
        executeFn: async () => {
          starts.push(name);
          await new Promise(r => setTimeout(r, ms));
          ends.push(name);
        },
      });

    const a = makeDelayed('a', 10);
    const b = makeDelayed('b', 10);

    const pipeline = new IndexPipeline([[a, b]]);
    await pipeline.run(ctx, 'build');

    // Both should have started before either finished
    expect(starts).toContain('a');
    expect(starts).toContain('b');
    expect(ends).toContain('a');
    expect(ends).toContain('b');
  });

  it('calls dispose() on all stages even after failure', async () => {
    const disposeA = vi.fn(async () => {});
    const disposeB = vi.fn(async () => {});

    const a = mockStage('a', {
      executeFn: async () => { throw new Error('boom'); },
      disposeFn: disposeA,
    });
    const b = mockStage('b', { disposeFn: disposeB });

    const pipeline = new IndexPipeline([a, b]);
    await expect(pipeline.run(ctx, 'build')).rejects.toThrow('boom');

    expect(disposeA).toHaveBeenCalled();
    expect(disposeB).toHaveBeenCalled();
  });

  it('waits for parallel peers to settle before disposing after a stage failure', async () => {
    const events: string[] = [];
    let releasePeer!: () => void;
    const peerBlocked = new Promise<void>((resolve) => { releasePeer = resolve; });
    let peerStarted!: () => void;
    const peerStartedPromise = new Promise<void>((resolve) => { peerStarted = resolve; });

    const failing = mockStage('failing', {
      executeFn: async () => { throw new Error('parallel failure'); },
      disposeFn: async () => { events.push('dispose-failing'); },
    });
    const peer = mockStage('peer', {
      executeFn: async () => {
        events.push('peer-started');
        peerStarted();
        await peerBlocked;
        events.push('peer-settled');
      },
      disposeFn: async () => { events.push('dispose-peer'); },
    });

    const run = new IndexPipeline([[failing, peer]]).run(ctx, 'build');
    await peerStartedPromise;
    await Promise.resolve();
    expect(events).toEqual(['peer-started']);

    releasePeer();
    await expect(run).rejects.toThrow('parallel failure');
    expect(events.indexOf('peer-settled')).toBeLessThan(events.indexOf('dispose-failing'));
    expect(events.indexOf('peer-settled')).toBeLessThan(events.indexOf('dispose-peer'));
  });

  it('handles stages without dispose()', async () => {
    const stage: PipelineStage = {
      name: 'no-dispose',
      execute: vi.fn(async () => {}),
      // no dispose
    };

    const pipeline = new IndexPipeline([stage]);
    await pipeline.run(ctx, 'build');
    expect(stage.execute).toHaveBeenCalled();
  });

  it('passes context and mode to execute()', async () => {
    const executeFn = vi.fn(async () => {});
    const stage = mockStage('check-args', { executeFn });

    const pipeline = new IndexPipeline([stage]);
    await pipeline.run(ctx, 'update');

    expect(executeFn).toHaveBeenCalledWith(ctx, 'update');
  });

  it('stops before the next stage when the run signal is already aborted', async () => {
    const executeFn = vi.fn(async () => {});
    const disposeFn = vi.fn(async () => {});
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));
    ctx.signal = controller.signal;

    const pipeline = new IndexPipeline([mockStage('cancelled', { executeFn, disposeFn })]);
    await expect(pipeline.run(ctx, 'build')).rejects.toThrow('cancelled by test');
    expect(executeFn).not.toHaveBeenCalled();
    expect(disposeFn).toHaveBeenCalledOnce();
  });

  it('enforces an absolute pipeline deadline without timing-sensitive waits', async () => {
    const executeFn = vi.fn(async () => {});
    ctx.deadlineAt = Date.now() - 1;

    const pipeline = new IndexPipeline([mockStage('expired', { executeFn })]);
    await expect(pipeline.run(ctx, 'build')).rejects.toThrow('deadline exceeded');
    expect(executeFn).not.toHaveBeenCalled();
  });

  describe('stageNames', () => {
    it('returns flat list of stage names', () => {
      const a = mockStage('alpha');
      const b = mockStage('beta');
      const c = mockStage('gamma');

      const pipeline = new IndexPipeline([a, [b, c]]);
      expect(pipeline.stageNames).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('returns empty list for empty pipeline', () => {
      const pipeline = new IndexPipeline([]);
      expect(pipeline.stageNames).toEqual([]);
    });
  });

  it('silently catches dispose() errors', async () => {
    const stage = mockStage('bad-dispose', {
      disposeFn: async () => { throw new Error('dispose failed'); },
    });

    const pipeline = new IndexPipeline([stage]);
    // Should not throw
    await pipeline.run(ctx, 'build');
  });
});
