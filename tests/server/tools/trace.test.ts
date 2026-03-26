import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef, type TraceArgs, type TraceResult } from '../../../src/server/tools/trace.js';
import { openDb } from '../../../src/db/schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = openDb(':memory:');
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string, source: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, ?, ?, 0, NULL, ?)')
    .run(path, branch, 'typescript', source);
  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
  signature?: string,
): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(fileId, name, kind, startLine, endLine, signature ?? null);
  return result.lastInsertRowid as number;
}

function insertCallEdge(
  db: Database.Database,
  callerId: number,
  calleeId: number,
  calleeName: string,
  callLine: number,
  resolutionMethod = 'tree-sitter',
): void {
  db.prepare(
    'INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line, resolution_method) VALUES (?, ?, ?, ?, ?)',
  ).run(callerId, calleeId, calleeName, callLine, resolutionMethod);
}

// ─── Source fixtures ──────────────────────────────────────────────────────────

const MAIN_SOURCE = [
  'import { helper } from "./helper";',
  '',
  'function main() {',
  '  const result = helper();',
  '  console.log(result);',
  '}',
].join('\n');

const HELPER_SOURCE = [
  'import { util } from "./util";',
  '',
  'export function helper() {',
  '  return util("hello");',
  '}',
].join('\n');

const UTIL_SOURCE = [
  'export function util(msg: string) {',
  '  return msg.toUpperCase();',
  '}',
].join('\n');

// ─── toolDef ──────────────────────────────────────────────────────────────────

describe('lore_trace toolDef', () => {
  it('exposes the correct tool name', () => {
    expect(toolDef.name).toBe('lore_trace');
  });

  it('defines from, from_name, to, to_name, depth, max_source_lines, branch', () => {
    const props = toolDef.inputSchema.properties;
    expect(props.from.type).toBe('number');
    expect(props.from_name.type).toBe('string');
    expect(props.to.type).toBe('number');
    expect(props.to_name.type).toBe('string');
    expect(props.depth.type).toBe('number');
    expect(props.depth.minimum).toBe(1);
    expect(props.depth.maximum).toBe(10);
    expect(props.max_source_lines.type).toBe('number');
    expect(props.branch.type).toBe('string');
  });
});

// ─── Forward trace (DFS) ─────────────────────────────────────────────────────

describe('trace handler – forward trace', () => {
  let db: Database.Database;
  let mainId: number;
  let helperId: number;
  let utilId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main', MAIN_SOURCE);
    const helperFileId = insertFile(db, 'src/helper.ts', 'main', HELPER_SOURCE);
    const utilFileId = insertFile(db, 'src/util.ts', 'main', UTIL_SOURCE);

    mainId = insertSymbol(db, mainFileId, 'main', 'function', 3, 6, '(): void');
    helperId = insertSymbol(db, helperFileId, 'helper', 'function', 3, 5, '(): string');
    utilId = insertSymbol(db, utilFileId, 'util', 'function', 1, 3, '(msg: string): string');

    // main → helper (line 3, 0-indexed)
    insertCallEdge(db, mainId, helperId, 'helper', 3);
    // helper → util (line 3, 0-indexed)
    insertCallEdge(db, helperId, utilId, 'util', 3);
  });

  it('traces a simple call chain with source inlined', () => {
    const result = handler(db, { from: mainId });

    expect(result.entry).toBe('main');
    expect(result.steps).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.total_nodes).toBe(3);

    // Entry step
    expect(result.steps[0]!.depth).toBe(0);
    expect(result.steps[0]!.name).toBe('main');
    expect(result.steps[0]!.kind).toBe('function');
    expect(result.steps[0]!.file_path).toBe('src/main.ts');
    expect(result.steps[0]!.source).toContain('function main()');

    // First callee
    expect(result.steps[1]!.depth).toBe(1);
    expect(result.steps[1]!.name).toBe('helper');
    expect(result.steps[1]!.call_line).toBe(4); // 0-based 3 → 1-based 4
    expect(result.steps[1]!.resolution_method).toBe('tree-sitter');
    expect(result.steps[1]!.source).toContain('export function helper()');

    // Deepest callee
    expect(result.steps[2]!.depth).toBe(2);
    expect(result.steps[2]!.name).toBe('util');
    expect(result.steps[2]!.source).toContain('export function util');
  });

  it('respects depth limit', () => {
    const result = handler(db, { from: mainId, depth: 1 });

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.name).toBe('main');
    expect(result.steps[1]!.name).toBe('helper');
    expect(result.truncated).toBe(true); // helper has further edges
  });

  it('resolves from_name to symbol ID', () => {
    const result = handler(db, { from_name: 'main' });

    expect(result.entry).toBe('main');
    expect(result.steps[0]!.symbol_id).toBe(mainId);
  });

  it('includes signature when present', () => {
    const result = handler(db, { from: mainId });

    expect(result.steps[0]!.signature).toBe('(): void');
    expect(result.steps[1]!.signature).toBe('(): string');
  });

  it('truncates source when max_source_lines is exceeded', () => {
    const result = handler(db, { from: mainId, max_source_lines: 2 });

    // main has 4 lines (3-6), should be truncated
    const mainSource = result.steps[0]!.source;
    expect(mainSource).toContain('// ... (2 more lines)');
  });

  it('handles cycle without infinite loop', () => {
    // Create a cycle: util → main
    insertCallEdge(db, utilId, mainId, 'main', 1);

    const result = handler(db, { from: mainId });

    // main visited once, helper once, util once — cycle back to main is skipped
    expect(result.steps).toHaveLength(3);
    const names = result.steps.map((s) => s.name);
    expect(names).toEqual(['main', 'helper', 'util']);
  });
});

// ─── Point-to-point trace (BFS) ──────────────────────────────────────────────

describe('trace handler – point-to-point', () => {
  let db: Database.Database;
  let mainId: number;
  let helperId: number;
  let utilId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main', MAIN_SOURCE);
    const helperFileId = insertFile(db, 'src/helper.ts', 'main', HELPER_SOURCE);
    const utilFileId = insertFile(db, 'src/util.ts', 'main', UTIL_SOURCE);

    mainId = insertSymbol(db, mainFileId, 'main', 'function', 3, 6, '(): void');
    helperId = insertSymbol(db, helperFileId, 'helper', 'function', 3, 5, '(): string');
    utilId = insertSymbol(db, utilFileId, 'util', 'function', 1, 3, '(msg: string): string');

    insertCallEdge(db, mainId, helperId, 'helper', 3);
    insertCallEdge(db, helperId, utilId, 'util', 3);
  });

  it('finds shortest path between two symbols', () => {
    const result = handler(db, { from: mainId, to: utilId });

    expect(result.entry).toBe(`main → symbol ${utilId}`);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.name).toBe('main');
    expect(result.steps[1]!.name).toBe('helper');
    expect(result.steps[2]!.name).toBe('util');
    expect(result.truncated).toBe(false);
  });

  it('finds direct path when adjacent', () => {
    const result = handler(db, { from: mainId, to: helperId });

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.name).toBe('main');
    expect(result.steps[1]!.name).toBe('helper');
  });

  it('resolves to_name for point-to-point', () => {
    const result = handler(db, { from: mainId, to_name: 'util' });

    expect(result.steps).toHaveLength(3);
    expect(result.steps[2]!.name).toBe('util');
  });

  it('throws when no path exists', () => {
    // util has no outgoing edges to main
    expect(() => handler(db, { from: utilId, to: mainId })).toThrow(
      /No call path found/,
    );
  });

  it('throws when path exceeds depth', () => {
    // main → helper → util is 2 hops, depth=1 should fail
    expect(() => handler(db, { from: mainId, to: utilId, depth: 1 })).toThrow(
      /No call path found/,
    );
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('trace handler – errors', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('throws when neither from nor from_name is provided', () => {
    expect(() => handler(db, {})).toThrow(/Provide `from`/);
  });

  it('throws when from_name matches no symbols', () => {
    expect(() => handler(db, { from_name: 'nonexistent' })).toThrow(
      /Symbol not found/,
    );
  });

  it('throws when from_name is ambiguous', () => {
    const fId = insertFile(db, 'src/a.ts', 'main', 'function foo() {}');
    insertSymbol(db, fId, 'foo', 'function', 1, 1);
    const fId2 = insertFile(db, 'src/b.ts', 'main', 'function foo() {}');
    insertSymbol(db, fId2, 'foo', 'function', 1, 1);

    expect(() => handler(db, { from_name: 'foo' })).toThrow(/Ambiguous/);
  });

  it('throws when from symbol ID does not exist', () => {
    expect(() => handler(db, { from: 99999 })).toThrow(/Entry symbol not found/);
  });
});

// ─── Coverage enrichment ──────────────────────────────────────────────────────


// ─── Metrics enrichment ──────────────────────────────────────────────────────

describe('trace handler – metrics enrichment', () => {
  it('includes cyclomatic complexity from symbol_metrics', () => {
    const db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main', MAIN_SOURCE);
    const mainId = insertSymbol(db, fileId, 'main', 'function', 3, 6);
    db.prepare('INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (?, ?, ?, ?, ?)').run(
      mainId,
      4,
      0,
      3,
      1,
    );

    const result = handler(db, { from: mainId });

    expect(result.steps[0]!.cyclomatic).toBe(3);
  });
});

// ─── Pre-order DFS ordering ──────────────────────────────────────────────────

describe('trace handler – DFS ordering', () => {
  it('returns steps in pre-order DFS (callees before siblings)', () => {
    const db = createTestDb();
    const source = 'function a() {}\nfunction b() {}\nfunction c() {}\nfunction d() {}';
    const fileId = insertFile(db, 'src/main.ts', 'main', source);

    const a = insertSymbol(db, fileId, 'a', 'function', 1, 1);
    const b = insertSymbol(db, fileId, 'b', 'function', 2, 2);
    const c = insertSymbol(db, fileId, 'c', 'function', 3, 3);
    const d = insertSymbol(db, fileId, 'd', 'function', 4, 4);

    // a calls b and c; b calls d
    insertCallEdge(db, a, b, 'b', 0);
    insertCallEdge(db, a, c, 'c', 0);
    insertCallEdge(db, b, d, 'd', 1);

    const result = handler(db, { from: a });

    // Pre-order DFS: a → b → d → c
    const names = result.steps.map((s) => s.name);
    expect(names).toEqual(['a', 'b', 'd', 'c']);
    expect(result.steps[0]!.depth).toBe(0);
    expect(result.steps[1]!.depth).toBe(1);
    expect(result.steps[2]!.depth).toBe(2);
    expect(result.steps[3]!.depth).toBe(1);
  });
});
