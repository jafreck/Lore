import { describe, it, expect } from 'vitest';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import type { PipelineContext, PipelineStage } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';

/** Minimal no-op context for pipeline tests. */
function createStubContext(): PipelineContext {
  return {
    db: null as any,
    dbPath: '/tmp/test.db',
    walkerConfig: { rootDir: '/tmp' },
    branch: 'main',
    lsp: null,
    embedder: null,
    log: initLogger({ level: LogLevel.SILENT }),
    files: [],
    indexDependencies: false,
    history: false,
    docsAutoNotes: true,
  };
}

describe('IndexPipeline', () => {
  it('should execute stages in declared order', async () => {
    const executionOrder: string[] = [];

    const stageA: PipelineStage = {
      name: 'stage-a',
      execute: async () => { executionOrder.push('a'); },
    };
    const stageB: PipelineStage = {
      name: 'stage-b',
      execute: async () => { executionOrder.push('b'); },
    };
    const stageC: PipelineStage = {
      name: 'stage-c',
      execute: async () => { executionOrder.push('c'); },
    };

    const pipeline = new IndexPipeline([stageA, stageB, stageC]);
    await pipeline.run(createStubContext(), 'build');

    expect(executionOrder).toEqual(['a', 'b', 'c']);
  });

  it('should call dispose on all stages even when one fails', async () => {
    const disposed: string[] = [];

    const stageA: PipelineStage = {
      name: 'stage-a',
      execute: async () => { throw new Error('stage-a failed'); },
      dispose: async () => { disposed.push('a'); },
    };
    const stageB: PipelineStage = {
      name: 'stage-b',
      execute: async () => {},
      dispose: async () => { disposed.push('b'); },
    };

    const pipeline = new IndexPipeline([stageA, stageB]);

    await expect(pipeline.run(createStubContext(), 'build')).rejects.toThrow('stage-a failed');
    expect(disposed).toContain('a');
    expect(disposed).toContain('b');
  });

  it('should expose stage names for introspection', () => {
    const pipeline = new IndexPipeline([
      { name: 'foo', execute: async () => {} },
      { name: 'bar', execute: async () => {} },
    ]);
    expect(pipeline.stageNames).toEqual(['foo', 'bar']);
  });

  it('should pass mode to stages', async () => {
    let receivedMode: string | undefined;

    const stage: PipelineStage = {
      name: 'mode-check',
      execute: async (_ctx, mode) => { receivedMode = mode; },
    };

    const pipeline = new IndexPipeline([stage]);
    await pipeline.run(createStubContext(), 'update');

    expect(receivedMode).toBe('update');
  });
});
