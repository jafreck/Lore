import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import { ReverseDepsStage } from '../../src/indexer/stages/reverse-deps.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

let db: Database.Database;

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
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

function insertFile(filePath: string, lang = 'typescript'): number {
  const info = db.prepare(
    "INSERT INTO files (path, language, branch, layer, generation) VALUES (?, ?, 'main', 'baseline', 1)",
  ).run(filePath, lang) as { lastInsertRowid: number | bigint };
  return Number(info.lastInsertRowid);
}

function insertSymbol(fileId: number, name: string): number {
  const info = db.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation) VALUES (?, ?, ?, 1, 10, ?, ?)',
  ).run(fileId, name, 'function', 'baseline', 1) as { lastInsertRowid: number | bigint };
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  resetLogger();
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('ReverseDepsStage', () => {
  it('builds reverse deps from resolved imports in build mode', async () => {
    const fileA = insertFile('src/a.ts');
    const fileB = insertFile('src/b.ts');
    const fileC = insertFile('src/c.ts');

    // a imports b, a imports c
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    ).run(fileA, './b', fileB, 'baseline', 1);
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    ).run(fileA, './c', fileC, 'baseline', 1);

    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx(), 'build');

    // b is depended on by a
    const depsB = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileB) as Array<{ dependent_id: number; dep_kind: string }>;
    expect(depsB.length).toBe(1);
    expect(depsB[0]!.dependent_id).toBe(fileA);
    expect(depsB[0]!.dep_kind).toBe('import');

    // c is depended on by a
    const depsC = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileC) as Array<{ dependent_id: number }>;
    expect(depsC.length).toBe(1);
    expect(depsC[0]!.dependent_id).toBe(fileA);
  });

  it('builds reverse deps from symbol refs in build mode', async () => {
    const fileA = insertFile('src/a.ts');
    const fileB = insertFile('src/b.ts');

    const symA = insertSymbol(fileA, 'caller');
    const symB = insertSymbol(fileB, 'callee');

    // symbol ref from A calling into B
    db.prepare(
      'INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(symA, fileA, symB, 'callee', 5, 'baseline', 1);

    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx(), 'build');

    const deps = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileB) as Array<{ dependent_id: number; dep_kind: string }>;
    expect(deps.length).toBe(1);
    expect(deps[0]!.dependent_id).toBe(fileA);
    expect(deps[0]!.dep_kind).toBe('ref');
  });

  it('clears and rebuilds in build mode', async () => {
    const fileA = insertFile('src/a.ts');
    const fileB = insertFile('src/b.ts');

    // Pre-populate stale reverse_deps
    db.prepare('INSERT INTO reverse_deps (file_id, dependent_id, dep_kind) VALUES (?, ?, ?)').run(fileA, fileB, 'import');

    // Now run build mode (no actual imports exist)
    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx(), 'build');

    // Stale entry should be gone (no resolved imports exist)
    const deps = db.prepare('SELECT * FROM reverse_deps').all();
    expect(deps.length).toBe(0);
  });

  it('update mode refreshes only changed files', async () => {
    const fileA = insertFile('src/a.ts');
    const fileB = insertFile('src/b.ts');
    const fileC = insertFile('src/c.ts');

    // b imports c (resolved)
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    ).run(fileB, './c', fileC, 'baseline', 1);

    // a imports b (resolved)
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    ).run(fileA, './b', fileB, 'baseline', 1);

    // First, build all
    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx(), 'build');

    const depsBeforeB = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileB) as Array<{ dependent_id: number }>;
    expect(depsBeforeB.length).toBe(1);

    // Now update with only a.ts changed
    const updateCtx = makeCtx({ changedFiles: ['src/a.ts'] });
    await stage.execute(updateCtx, 'update');

    // b's reverse deps should still include a
    const depsAfterB = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileB) as Array<{ dependent_id: number }>;
    expect(depsAfterB.some(d => d.dependent_id === fileA)).toBe(true);
  });

  it('update mode is a no-op when changedFiles is empty', async () => {
    insertFile('src/a.ts');

    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx({ changedFiles: [] }), 'update');

    const deps = db.prepare('SELECT * FROM reverse_deps').all();
    expect(deps.length).toBe(0);
  });

  it('update mode is a no-op when changedFiles paths are not in DB', async () => {
    insertFile('src/a.ts');

    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx({ changedFiles: ['src/nonexistent.ts'] }), 'update');

    const deps = db.prepare('SELECT * FROM reverse_deps').all();
    expect(deps.length).toBe(0);
  });

  it('handles both import and ref deps for same file pair', async () => {
    const fileA = insertFile('src/a.ts');
    const fileB = insertFile('src/b.ts');

    // import dep
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    ).run(fileA, './b', fileB, 'baseline', 1);

    // ref dep
    const symA = insertSymbol(fileA, 'caller');
    const symB = insertSymbol(fileB, 'callee');
    db.prepare(
      'INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(symA, fileA, symB, 'callee', 5, 'baseline', 1);

    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx(), 'build');

    const deps = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileB) as Array<{ dep_kind: string }>;
    expect(deps.length).toBe(2);
    expect(deps.some(d => d.dep_kind === 'import')).toBe(true);
    expect(deps.some(d => d.dep_kind === 'ref')).toBe(true);
  });

  it('does not create self-referential ref deps', async () => {
    const fileA = insertFile('src/a.ts');

    const sym1 = insertSymbol(fileA, 'foo');
    const sym2 = insertSymbol(fileA, 'bar');

    // ref within the same file
    db.prepare(
      'INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(sym1, fileA, sym2, 'bar', 5, 'baseline', 1);

    const stage = new ReverseDepsStage();
    await stage.execute(makeCtx(), 'build');

    // Should not create a reverse dep from fileA → fileA
    const deps = db.prepare('SELECT * FROM reverse_deps').all();
    expect(deps.length).toBe(0);
  });
});
