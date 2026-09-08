import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { resolveSymbolEdges } from '../../../src/resolution/call-graph.js';
import { reconcileEffectiveTargets } from '../../../src/resolution/effective-targets.js';
import { handler as graph } from '../../../src/server/tools/graph.js';
import { handler as dependents } from '../../../src/server/tools/dependents.js';
import { handler as trace } from '../../../src/server/tools/trace.js';
import { handler as cohesion } from '../../../src/server/tools/cohesion.js';
import { handler as structure } from '../../../src/server/tools/structure.js';

const TARGET_PATH = 'src/core/target.ts';

function seedOverlayReplacement(db: Database.Database): void {
  const insertFile = db.prepare(
    `INSERT INTO files (id, path, branch, language, source, layer, generation)
     VALUES (?, ?, 'main', 'typescript', ?, ?, ?)`,
  );
  insertFile.run(1, TARGET_PATH, 'function targetFn() {}\nclass Base {}\ntype Model = string;', 'baseline', 1);
  insertFile.run(2, 'src/app/caller.ts', 'function callerFn() { targetFn(); }\nclass Child extends Base {}', 'baseline', 1);
  insertFile.run(3, 'src/lib/helper.ts', 'function helper() {}', 'baseline', 1);
  insertFile.run(4, 'src/app/overlay-caller.ts', 'function overlayCaller() { targetFn(); }', 'overlay', 0);
  db.prepare(
    "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
  ).run();

  const insertSymbol = db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertSymbol.run(1, 1, 'targetFn', 'function', 0, 0, 'baseline', 1);
  insertSymbol.run(2, 1, 'Base', 'class', 1, 1, 'baseline', 1);
  insertSymbol.run(3, 1, 'Model', 'type', 2, 2, 'baseline', 1);
  insertSymbol.run(4, 1, 'oldTargetCaller', 'function', 3, 3, 'baseline', 1);
  insertSymbol.run(20, 2, 'callerFn', 'function', 0, 0, 'baseline', 1);
  insertSymbol.run(21, 2, 'Child', 'class', 1, 1, 'baseline', 1);
  insertSymbol.run(30, 3, 'helper', 'function', 0, 0, 'baseline', 1);
  insertSymbol.run(40, 4, 'overlayCaller', 'function', 0, 0, 'overlay', 0);
  insertSymbol.run(41, 4, 'OverlayChild', 'class', 1, 1, 'overlay', 0);

  db.prepare(
    `INSERT INTO symbol_refs
       (caller_id, file_id, callee_id, callee_name, call_line, definition_path,
        definition_line, resolution_method, layer, generation)
     VALUES (20, 2, 1, 'targetFn', 0, ?, 0, 'scip_definition', 'baseline', 1)`,
  ).run(TARGET_PATH);
  db.prepare(
    `INSERT INTO type_refs
       (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line,
        definition_path, definition_line, resolution_method, layer, generation)
     VALUES (2, 20, 3, 'Model', 'Model', 'return_type', 0, ?, 2,
             'scip_definition', 'baseline', 1)`,
  ).run(TARGET_PATH);
  db.prepare(
    `INSERT INTO symbol_relationships
       (file_id, source_symbol_id, target_symbol_id, target_symbol_name,
        relationship_type, line, definition_path, definition_line,
        resolution_method, layer, generation)
     VALUES (2, 21, 2, 'Base', 'extends', 1, ?, 1,
             'scip_definition', 'baseline', 1)`,
  ).run(TARGET_PATH);
  db.prepare(
    `INSERT INTO file_imports
       (file_id, raw_import, resolved_id, resolution_method, layer, generation)
     VALUES (2, '../core/target', 1, 'filesystem_exact', 'baseline', 1)`,
  ).run();

    db.prepare(
     `INSERT INTO symbol_refs
       (caller_id, file_id, callee_id, callee_name, call_line, definition_path,
        definition_line, resolution_method, layer, generation)
      VALUES (40, 4, 1, 'targetFn', 0, ?, 0, 'lsp_definition', 'overlay', 0)`,
    ).run(TARGET_PATH);
    db.prepare(
     `INSERT INTO type_refs
       (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line,
        definition_path, definition_line, resolution_method, layer, generation)
      VALUES (4, 40, 3, 'Model', 'Model', 'return_type', 0, ?, 2,
           'lsp_definition', 'overlay', 0)`,
    ).run(TARGET_PATH);
    db.prepare(
     `INSERT INTO symbol_relationships
       (file_id, source_symbol_id, target_symbol_id, target_symbol_name,
        relationship_type, line, definition_path, definition_line,
        resolution_method, layer, generation)
      VALUES (4, 41, 2, 'Base', 'extends', 1, ?, 1,
           'lsp_definition', 'overlay', 0)`,
    ).run(TARGET_PATH);
    db.prepare(
     `INSERT INTO file_imports
       (file_id, raw_import, resolved_id, resolution_method, layer, generation)
      VALUES (4, '../core/target', 1, 'filesystem_exact', 'overlay', 0)`,
    ).run();
    db.prepare(
     `INSERT INTO dirty_files (path, branch, overlay_gen)
      VALUES ('src/app/overlay-caller.ts', 'main', 0)`,
    ).run();

  // These edges originate in the baseline file that the overlay hides. Raw
  // readers would leak them and manufacture an import cycle.
  db.prepare(
    `INSERT INTO symbol_refs
       (caller_id, file_id, callee_id, callee_name, call_line, resolution_method, layer, generation)
     VALUES (4, 1, 20, 'callerFn', 3, 'scip_definition', 'baseline', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO file_imports
       (file_id, raw_import, resolved_id, resolution_method, layer, generation)
     VALUES (1, '../app/caller', 2, 'filesystem_exact', 'baseline', 1)`,
  ).run();

  insertFile.run(
    11,
    TARGET_PATH,
    "export function targetFn() { return helper(); }\nexport class Base {}\nexport type Model = number;",
    'overlay',
    0,
  );
  insertSymbol.run(101, 11, 'targetFn', 'function', 0, 0, 'overlay', 0);
  insertSymbol.run(102, 11, 'Base', 'class', 1, 1, 'overlay', 0);
  insertSymbol.run(103, 11, 'Model', 'type', 2, 2, 'overlay', 0);
  db.prepare(
    `INSERT INTO symbol_refs
       (caller_id, file_id, callee_id, callee_name, call_line, resolution_method, layer, generation)
     VALUES (101, 11, 30, 'helper', 0, 'lsp_definition', 'overlay', 0)`,
  ).run();

  // The dirty-file trigger invalidates symbol targets and remaps the file ID.
  db.prepare(
    `INSERT INTO dirty_files (path, branch, overlay_gen) VALUES (?, 'main', 0)`,
  ).run(TARGET_PATH);
  resolveSymbolEdges(db, { overlayOnly: true, branch: 'main' });
}

function danglingEffectiveTargetCounts(db: Database.Database): Record<string, number> {
  const count = (sql: string): number => (db.prepare(sql).get() as { count: number }).count;
  return {
    calls: count(`SELECT COUNT(*) AS count FROM effective_symbol_refs edge
      LEFT JOIN effective_symbols target ON target.id = edge.callee_id
      WHERE edge.callee_id IS NOT NULL AND target.id IS NULL`),
    types: count(`SELECT COUNT(*) AS count FROM effective_type_refs edge
      LEFT JOIN effective_symbols target ON target.id = edge.type_id
      WHERE edge.type_id IS NOT NULL AND target.id IS NULL`),
    relationships: count(`SELECT COUNT(*) AS count FROM effective_symbol_relationships edge
      LEFT JOIN effective_symbols target ON target.id = edge.target_symbol_id
      WHERE edge.target_symbol_id IS NOT NULL AND target.id IS NULL`),
    imports: count(`SELECT COUNT(*) AS count FROM effective_file_imports edge
      LEFT JOIN effective_files target ON target.id = edge.resolved_id
      WHERE edge.resolved_id IS NOT NULL AND target.id IS NULL`),
  };
}

describe('registered graph-facing tools use effective overlay state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedOverlayReplacement(db);
  });

  afterEach(() => {
    db.close();
  });

  it('serves replacement call, import, inheritance, and type targets', () => {
    expect(graph(db, { kind: 'call', source_id: 20 }).edges)
      .toEqual(expect.arrayContaining([expect.objectContaining({ target_id: 101, target_name: 'targetFn' })]));
    expect(graph(db, { kind: 'import', source_id: 2 }).edges)
      .toEqual([expect.objectContaining({ target_id: 11, target_name: TARGET_PATH })]);
    expect(graph(db, { kind: 'inheritance', source_id: 21 }).edges)
      .toEqual([expect.objectContaining({ target_id: 102, target_name: 'Base' })]);
    expect(graph(db, { kind: 'type_dependency', source_id: 20 }).edges)
      .toEqual([expect.objectContaining({ target_id: 103, target_name: 'Model' })]);
    expect(graph(db, { kind: 'call', source_id: 40 }).edges)
      .toEqual(expect.arrayContaining([expect.objectContaining({ target_id: 101 })]));
    expect(graph(db, { kind: 'import', source_id: 4 }).edges)
      .toEqual([expect.objectContaining({ target_id: 11 })]);
    expect(graph(db, { kind: 'inheritance', source_id: 41 }).edges)
      .toEqual([expect.objectContaining({ target_id: 102 })]);
    expect(graph(db, { kind: 'type_dependency', source_id: 40 }).edges)
      .toEqual([expect.objectContaining({ target_id: 103 })]);
    expect(danglingEffectiveTargetCounts(db)).toEqual({
      calls: 0,
      types: 0,
      relationships: 0,
      imports: 0,
    });
  });

  it('keeps dependents, traces, cohesion, and structure free of hidden baseline rows', () => {
    const targetDependents = dependents(db, { query: 'targetFn', kind: 'symbol' });
    expect(targetDependents.target.id).toBe(101);
    expect(targetDependents.dependents.callers)
      .toEqual(expect.arrayContaining([expect.objectContaining({ caller_name: 'callerFn' })]));

    const callerDependents = dependents(db, { query: 'callerFn', kind: 'symbol' });
    expect(callerDependents.dependents.callers.map((row) => row.caller_name))
      .not.toContain('oldTargetCaller');

    const traced = trace(db, { from: 20, depth: 5 });
    expect(traced.steps.map((step) => step.symbol_id)).toEqual([20, 101, 30]);
    expect(traced.steps.find((step) => step.symbol_id === 101)?.source)
      .toContain('return helper()');

    const directoryMetrics = cohesion(db, { depth: 2 }).directories;
    expect(directoryMetrics.find((row) => row.directory === 'src/core'))
      .toMatchObject({ external_inbound: 2, external_outbound: 1 });
    expect(structure(db, { analysis: 'cycles', depth: 2 }).cycles).toEqual([]);
  });

  it('invalidates all targets and excludes deleted effective files', () => {
    db.prepare('DELETE FROM files WHERE id = 11').run();
    reconcileEffectiveTargets(db, 'main');
    resolveSymbolEdges(db, { overlayOnly: true, branch: 'main' });

    expect(db.prepare(
      `SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = 20`,
    ).get()).toEqual({ callee_id: null, resolution_method: 'overlay_stale' });
    expect(db.prepare(
      `SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = 20`,
    ).get()).toEqual({ type_id: null, resolution_method: 'overlay_stale' });
    expect(db.prepare(
      `SELECT target_symbol_id, resolution_method FROM symbol_relationships WHERE source_symbol_id = 21`,
    ).get()).toEqual({ target_symbol_id: null, resolution_method: 'overlay_stale' });
    expect(db.prepare(
      `SELECT resolved_id, resolution_method FROM file_imports WHERE file_id = 2`,
    ).get()).toEqual({ resolved_id: null, resolution_method: 'overlay_stale' });
    expect(danglingEffectiveTargetCounts(db)).toEqual({
      calls: 0,
      types: 0,
      relationships: 0,
      imports: 0,
    });

    expect(graph(db, { kind: 'call', source_id: 20 }).edges)
      .toEqual([expect.objectContaining({ target_id: null, target_name: 'targetFn' })]);
    expect(graph(db, { kind: 'import', source_id: 2 }).edges)
      .toEqual([expect.objectContaining({ target_id: null })]);
    expect(graph(db, { kind: 'inheritance', source_id: 21 }).edges)
      .toEqual([expect.objectContaining({ target_id: null })]);
    expect(graph(db, { kind: 'type_dependency', source_id: 20 }).edges)
      .toEqual([expect.objectContaining({ target_id: null })]);
    expect(() => dependents(db, { query: 'targetFn', kind: 'symbol' })).toThrow(/No symbol found/);
    expect(() => dependents(db, { query: TARGET_PATH, kind: 'file' })).toThrow(/No file found/);
    expect(trace(db, { from: 20 }).steps.map((step) => step.symbol_id)).toEqual([20]);
    expect(cohesion(db, {}).directories).toEqual([]);
    expect(structure(db, { analysis: 'cycles' }).cycles).toEqual([]);
  });
});
