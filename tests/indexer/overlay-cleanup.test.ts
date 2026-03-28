/**
 * Tests for the OverlayCleanupStage: atomic baseline promotion with
 * stale overlay row cleanup after a background baseline rebuild.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openDb, setLoreMeta, getLoreMeta, getGeneration } from '../../src/db/schema.js';
import { OverlayCleanupStage } from '../../src/indexer/stages/overlay-cleanup.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import type Database from 'better-sqlite3';

function makeContext(db: Database.Database): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp' },
    branch: 'HEAD',
    lsp: null,
    scip: null,
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
    generation: 2,
  };
}

describe('OverlayCleanupStage', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  function seedData(db: Database.Database) {
    // Old baseline (gen 1)
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 10, 'old', 'baseline', 1);
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/b.ts', 'HEAD', 'typescript', 10, 'old', 'baseline', 1);

    // New baseline (gen 2)
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/c.ts', 'HEAD', 'typescript', 10, 'new', 'baseline', 2);

    // Overlay row for a file dirtied BEFORE rebuild started (should be cleaned)
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/d.ts', 'HEAD', 'typescript', 10, 'overlay-old', 'overlay', 0);
    db.prepare(
      "INSERT INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES (?, ?, ?, ?)",
    ).run('/src/d.ts', 'HEAD', 1000, 0);

    // Overlay row for a file dirtied DURING rebuild (should be kept)
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/e.ts', 'HEAD', 'typescript', 10, 'overlay-active', 'overlay', 0);
    db.prepare(
      "INSERT INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES (?, ?, ?, ?)",
    ).run('/src/e.ts', 'HEAD', 3000, 0);

    setLoreMeta(db, 'generation', '1');
  }

  it('should delete old baseline rows (generation < new)', async () => {
    db = openDb(':memory:');
    seedData(db);

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: 2000,
    });
    await stage.execute(makeContext(db), 'build');

    // Old gen-1 baseline rows should be gone
    const oldRows = db.prepare("SELECT * FROM files WHERE generation = 1 AND layer = 'baseline'").all();
    expect(oldRows).toHaveLength(0);

    // New gen-2 baseline row should remain
    const newRows = db.prepare("SELECT * FROM files WHERE generation = 2 AND layer = 'baseline'").all();
    expect(newRows).toHaveLength(1);
  });

  it('should clear overlay rows for files dirtied before rebuild', async () => {
    db = openDb(':memory:');
    seedData(db);

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: 2000,
    });
    await stage.execute(makeContext(db), 'build');

    // /src/d.ts was dirtied at 1000, before rebuild started at 2000 → cleaned
    const dRow = db.prepare("SELECT * FROM files WHERE path = '/src/d.ts' AND layer = 'overlay'").get();
    expect(dRow).toBeUndefined();

    // /src/e.ts was dirtied at 3000, during rebuild → kept
    const eRow = db.prepare("SELECT * FROM files WHERE path = '/src/e.ts' AND layer = 'overlay'").get();
    expect(eRow).toBeDefined();
  });

  it('should remove promoted paths from dirty_files', async () => {
    db = openDb(':memory:');
    seedData(db);

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: 2000,
    });
    await stage.execute(makeContext(db), 'build');

    // /src/d.ts dirty_since=1000 < 2000 → removed
    const dDirty = db.prepare("SELECT * FROM dirty_files WHERE path = '/src/d.ts'").get();
    expect(dDirty).toBeUndefined();

    // /src/e.ts dirty_since=3000 > 2000 → still dirty
    const eDirty = db.prepare("SELECT * FROM dirty_files WHERE path = '/src/e.ts'").get();
    expect(eDirty).toBeDefined();
  });

  it('should update generation metadata', async () => {
    db = openDb(':memory:');
    seedData(db);

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: 2000,
    });
    await stage.execute(makeContext(db), 'build');

    expect(getLoreMeta(db, 'generation')).toBe('2');
  });

  it('should set baseline_head_sha when headSha is provided', async () => {
    db = openDb(':memory:');
    seedData(db);

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: 2000,
      headSha: 'abc123',
    });
    await stage.execute(makeContext(db), 'build');

    expect(getLoreMeta(db, 'baseline_head_sha')).toBe('abc123');
  });

  it('should not set baseline_head_sha when headSha is omitted', async () => {
    db = openDb(':memory:');
    seedData(db);

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: 2000,
    });
    await stage.execute(makeContext(db), 'build');

    expect(getLoreMeta(db, 'baseline_head_sha')).toBeUndefined();
  });

  it('should rebuild reverse_deps from new baseline', async () => {
    db = openDb(':memory:');
    // Insert baseline files
    const f1Info = db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 10, '', 'baseline', 2);
    const f1Id = Number(f1Info.lastInsertRowid);
    const f2Info = db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/b.ts', 'HEAD', 'typescript', 10, '', 'baseline', 2);
    const f2Id = Number(f2Info.lastInsertRowid);

    // Add a resolved import: b imports a
    db.prepare(
      "INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)",
    ).run(f2Id, './a', f1Id, 'baseline', 2);

    setLoreMeta(db, 'generation', '1');

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: 2000,
    });
    await stage.execute(makeContext(db), 'build');

    const deps = db.prepare('SELECT * FROM reverse_deps').all() as Array<{ file_id: number; dependent_id: number; dep_kind: string }>;
    expect(deps).toHaveLength(1);
    expect(deps[0]!.file_id).toBe(f1Id);
    expect(deps[0]!.dependent_id).toBe(f2Id);
    expect(deps[0]!.dep_kind).toBe('import');
  });
});
