/**
 * Tests for pipeline stage layer guards and overlay mode entry points.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import { ScipIndexerStage } from '../../src/indexer/stages/scip-indexer.js';
import { LspEnrichmentStage } from '../../src/indexer/stages/lsp-enrichment.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import type Database from 'better-sqlite3';

function makeContext(db: Database.Database, overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp' },
    branch: 'HEAD',
    lsp: null,
    scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
    embedder: null,
    log: initLogger({ level: LogLevel.SILENT }),
    files: [],
    indexDependencies: false,
    history: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    changedDocPaths: [],
    sourceCache: new Map(),
    layer: 'baseline',
    generation: 1,
    ...overrides,
  };
}

describe('ScipIndexerStage — overlay guard', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should skip entirely when layer is overlay', async () => {
    db = openDb(':memory:');
    const stage = new ScipIndexerStage();
    const ctx = makeContext(db, { layer: 'overlay' });

    // This should return immediately without trying to load SCIP indexes
    await stage.execute(ctx, 'update');

    // No files should have been indexed
    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('should skip when SCIP is disabled', async () => {
    db = openDb(':memory:');
    const stage = new ScipIndexerStage();
    const ctx = makeContext(db, { scip: null });

    await stage.execute(ctx, 'build');

    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });
});

describe('LspEnrichmentStage — baseline/overlay behavior', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should skip when LSP is disabled', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const ctx = makeContext(db, { lsp: null, layer: 'overlay' });

    // Should not throw
    await stage.execute(ctx, 'update');
    await stage.dispose?.();
  });

  it('should skip when no files to enrich', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const ctx = makeContext(db, {
      lsp: { enabled: true, languages: {} },
      layer: 'overlay',
      files: [],
    });

    // Should not throw
    await stage.execute(ctx, 'update');
    await stage.dispose?.();
  });

  it('should return early in baseline mode for SCIP-covered languages', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const ctx = makeContext(db, {
      lsp: { enabled: true, languages: {} },
      layer: 'baseline',
      files: [{ path: '/a.ts', language: 'typescript' }],
      scipSourcedLanguages: new Set(['typescript']),
      scipCoveredLanguages: new Set(['typescript']),
    });

    // Should return early (no non-SCIP files)
    await stage.execute(ctx, 'build');
    await stage.dispose?.();
  });
});
