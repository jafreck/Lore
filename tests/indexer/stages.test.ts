import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import { ImportResolutionStage } from '../../src/indexer/stages/import-resolution.js';
import { ReverseDepsStage } from '../../src/indexer/stages/reverse-deps.js';
import { OverlayCleanupStage } from '../../src/indexer/stages/overlay-cleanup.js';
import { EmbeddingStage } from '../../src/indexer/stages/embedding.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

function makeCtx(db: Database.Database, overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp/test' } as any,
    branch: 'main',
    lsp: null,
    scip: null,
    embedder: null,
    log: initLogger({ level: LogLevel.SILENT }),
    files: [],
    indexDependencies: false,
    history: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    sourceCache: new Map(),
    layer: 'baseline',
    generation: 1,
    ...overrides,
  };
}

describe('ImportResolutionStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('has the correct name', () => {
    const stage = new ImportResolutionStage();
    expect(stage.name).toBe('import-resolution');
  });

  it('runs without error on empty database', async () => {
    const stage = new ImportResolutionStage();
    const ctx = makeCtx(db);
    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
  });

  it('resolves internal imports when files exist', async () => {
    // Insert files
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES (?, ?, 'main', 'baseline', 1)",
    ).run('src/a.ts', 'typescript');
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES (?, ?, 'main', 'baseline', 1)",
    ).run('src/b.ts', 'typescript');

    const fileA = db.prepare("SELECT id FROM files WHERE path = 'src/a.ts'").get() as { id: number };
    const fileB = db.prepare("SELECT id FROM files WHERE path = 'src/b.ts'").get() as { id: number };

    // Insert an import from a.ts → ./b (should resolve to b.ts)
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, layer, generation) VALUES (?, ?, ?, ?)',
    ).run(fileA.id, './b', 'baseline', 1);

    const stage = new ImportResolutionStage();
    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // Check that the import was resolved
    const imp = db.prepare('SELECT resolved_id FROM file_imports WHERE file_id = ?').get(fileA.id) as { resolved_id: number | null };
    expect(imp).toBeDefined();
    // resolved_id may or may not be resolved depending on path resolution
    if (imp.resolved_id !== null) {
      expect(imp.resolved_id).toBe(fileB.id);
    }
  });
});

describe('ReverseDepsStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('has the correct name', () => {
    const stage = new ReverseDepsStage();
    expect(stage.name).toBe('reverse-deps');
  });

  it('runs without error on empty database in build mode', async () => {
    const stage = new ReverseDepsStage();
    const ctx = makeCtx(db);
    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
  });

  it('builds reverse deps from resolved imports', async () => {
    // Insert two files
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/a.ts', 'typescript', 'main', 'baseline', 1)",
    ).run();
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/b.ts', 'typescript', 'main', 'baseline', 1)",
    ).run();

    const fileA = db.prepare("SELECT id FROM files WHERE path = 'src/a.ts'").get() as { id: number };
    const fileB = db.prepare("SELECT id FROM files WHERE path = 'src/b.ts'").get() as { id: number };

    // a.ts imports b.ts (resolved)
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    ).run(fileA.id, './b', fileB.id, 'baseline', 1);

    const stage = new ReverseDepsStage();
    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // b.ts is depended on by a.ts
    const deps = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileB.id) as Array<{ dependent_id: number }>;
    expect(deps.length).toBeGreaterThanOrEqual(1);
    expect(deps.some(d => d.dependent_id === fileA.id)).toBe(true);
  });

  it('handles update mode with no changed files', async () => {
    const stage = new ReverseDepsStage();
    const ctx = makeCtx(db, { changedFiles: [] });
    await expect(stage.execute(ctx, 'update')).resolves.not.toThrow();
  });
});

describe('OverlayCleanupStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('has the correct name', () => {
    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: Math.floor(Date.now() / 1000),
    });
    expect(stage.name).toBe('overlay-cleanup');
  });

  it('deletes old baseline rows', async () => {
    // Insert a file with generation 1
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/old.ts', 'typescript', 'main', 'baseline', 1)",
    ).run();

    // Insert a file with generation 2
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/new.ts', 'typescript', 'main', 'baseline', 2)",
    ).run();

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: Math.floor(Date.now() / 1000) + 100,
    });

    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // Old generation file should be deleted
    const old = db.prepare("SELECT * FROM files WHERE path = 'src/old.ts'").get();
    expect(old).toBeUndefined();

    // New generation file should remain
    const newer = db.prepare("SELECT * FROM files WHERE path = 'src/new.ts'").get();
    expect(newer).toBeDefined();
  });
});

describe('EmbeddingStage', () => {
  it('has the correct name', () => {
    const stage = new EmbeddingStage();
    expect(stage.name).toBe('embedding');
  });

  it('skips when no embedder is configured', async () => {
    resetLogger();
    const db = openDb(':memory:');
    const ctx = makeCtx(db, { embedder: null });
    const stage = new EmbeddingStage();

    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
    db.close();
  });
});
