import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Database } from '../../src/db/schema.js';
import { FtsRefreshStage } from '../../src/indexer/stages/fts-refresh.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

let db: Database.Database;

function context(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/repo' },
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

function insertFile(path: string, layer: 'baseline' | 'overlay', generation: number): number {
  const result = db.prepare(
    `INSERT INTO files (path, branch, language, layer, generation)
     VALUES (?, 'main', 'typescript', ?, ?)`,
  ).run(path, layer, generation) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

function insertSymbol(fileId: number, name: string, signature: string, layer: 'baseline' | 'overlay', generation: number): number {
  const result = db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, layer, generation)
     VALUES (?, ?, 'function', 0, 0, ?, ?, ?)`,
  ).run(fileId, name, signature, layer, generation) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  resetLogger();
  db = openDb(':memory:');
  db.prepare(
    "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
  ).run();
});

afterEach(() => {
  db.close();
  resetLogger();
});

describe('FtsRefreshStage', () => {
  it('adds a hidden baseline generation without deleting active FTS rows', async () => {
    const fileId = insertFile('/repo/a.ts', 'baseline', 1);
    const symbolId = insertSymbol(fileId, 'alpha', 'function alpha(): void', 'baseline', 1);
    db.prepare(
      "INSERT INTO symbols_fts(rowid, name, signature, kind) VALUES (999, 'stale', '', 'function')",
    ).run();

    const execSpy = vi.spyOn(db, 'exec');
    await new FtsRefreshStage().execute(context(), 'build');

    expect(execSpy).not.toHaveBeenCalledWith('DELETE FROM symbols_fts');
    expect(db.prepare('SELECT rowid, name FROM symbols_fts ORDER BY rowid').all()).toEqual([
      { rowid: symbolId, name: 'alpha' },
      { rowid: 999, name: 'stale' },
    ]);
  });

  it('replaces only stale and changed-file rows for an overlay update', async () => {
    const baselineA = insertFile('/repo/a.ts', 'baseline', 1);
    const baselineB = insertFile('/repo/b.ts', 'baseline', 1);
    const oldA = insertSymbol(baselineA, 'oldAlpha', 'old signature', 'baseline', 1);
    const symbolB = insertSymbol(baselineB, 'bravo', 'stable signature', 'baseline', 1);
    const stage = new FtsRefreshStage();
    await stage.execute(context(), 'build');

    db.prepare(
      "INSERT INTO dirty_files(path, branch, overlay_gen) VALUES ('/repo/a.ts', 'main', 0)",
    ).run();
    const overlayA = insertFile('/repo/a.ts', 'overlay', 0);
    const newA = insertSymbol(overlayA, 'newAlpha', 'new signature', 'overlay', 0);

    const execSpy = vi.spyOn(db, 'exec');
    await stage.execute(context({
      layer: 'overlay',
      generation: 0,
      staleSymbolIds: [oldA],
      changedSourcePaths: ['/repo/a.ts'],
    }), 'update');

    expect(execSpy).not.toHaveBeenCalledWith('DELETE FROM symbols_fts');
    expect(db.prepare('SELECT rowid, name FROM symbols_fts ORDER BY rowid').all()).toEqual([
      { rowid: symbolB, name: 'bravo' },
      { rowid: newA, name: 'newAlpha' },
    ]);
  });
});
