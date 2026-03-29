/**
 * Tests for LspExtractionStage — overlay-mode LSP-driven extraction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type Database } from '../../src/db/schema.js';
import { LspExtractionStage } from '../../src/indexer/stages/lsp-extraction.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

function makeContext(db: Database.Database, overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp', extensions: ['.ts'], include: ['**/*'], exclude: [] },
    branch: 'main',
    lsp: { enabled: true, requestTimeoutMs: 1000, servers: {} },
    scip: null,
    embedder: null,
    log: {
      indexing: vi.fn(),
      startup: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      toolCall: vi.fn(),
    } as any,
    files: [],
    indexDependencies: false,
    history: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    sourceCache: new Map(),
    layer: 'overlay',
    generation: 0,
    ...overrides,
  };
}

describe('LspExtractionStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: LogLevel.SILENT });
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('skips execution when layer is baseline', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, { layer: 'baseline' });
    await stage.execute(ctx, 'build');
    // No errors, no symbols inserted
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips execution when LSP is disabled', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, { lsp: null });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips execution when LSP enabled is false', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      lsp: { enabled: false, requestTimeoutMs: 1000, servers: {} },
    });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips execution when no changed files', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, { changedFiles: [] });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips files not in sourceCache', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/missing.ts'],
      files: [{ path: '/tmp/missing.ts', language: 'typescript' }],
    });
    // sourceCache is empty, so this file should be skipped
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips files without a matching entry in context.files', async () => {
    const stage = new LspExtractionStage();
    const cache = new Map<string, string>();
    cache.set('/tmp/orphan.ts', 'const x = 1;');
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/orphan.ts'],
      files: [], // no matching file entry
      sourceCache: cache,
    });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('has a name', () => {
    const stage = new LspExtractionStage();
    expect(stage.name).toBe('lsp-extraction');
  });

  it('dispose is a no-op', async () => {
    const stage = new LspExtractionStage();
    await expect(stage.dispose()).resolves.toBeUndefined();
  });
});
