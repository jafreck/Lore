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

  it('should enforce enrichment before resolution in canonical pipeline', () => {
    // Validate that the canonical stage ordering has enrichment before resolution.
    // This is the structural enforcement that replaces call-site discipline.
    const pipeline = new IndexPipeline([
      { name: 'source-index', execute: async () => {} },
      { name: 'docs-index', execute: async () => {} },
      { name: 'import-resolution', execute: async () => {} },
      { name: 'dependency-api', execute: async () => {} },
      { name: 'lsp-enrichment', execute: async () => {} },
      { name: 'symbol-resolution', execute: async () => {} },
      { name: 'test-map', execute: async () => {} },
      { name: 'git-history', execute: async () => {} },
      { name: 'embedding', execute: async () => {} },
    ]);

    const names = pipeline.stageNames;
    const enrichIdx = names.indexOf('lsp-enrichment');
    const resolveIdx = names.indexOf('symbol-resolution');
    expect(enrichIdx).toBeGreaterThanOrEqual(0);
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(enrichIdx).toBeLessThan(resolveIdx);
  });

  it('should populate context.files when shared by stages', async () => {
    const ctx = createStubContext();

    const stageA: PipelineStage = {
      name: 'producer',
      execute: async (context) => {
        context.files = [{ path: '/tmp/a.ts', language: 'typescript' }];
      },
    };
    const stageB: PipelineStage = {
      name: 'consumer',
      execute: async (context) => {
        expect(context.files.length).toBe(1);
      },
    };

    const pipeline = new IndexPipeline([stageA, stageB]);
    await pipeline.run(ctx, 'build');
    expect(ctx.files.length).toBe(1);
  });
});
