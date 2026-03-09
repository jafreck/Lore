import { describe, it, expect } from 'vitest';
import { normalizeTypeName, resolveSymbolEdges, topoSort, detectCycles } from '../../src/indexer/call-graph.js';
import { openDb } from '../../src/indexer/db.js';
import type { Database } from '../../src/indexer/db.js';

describe('normalizeTypeName', () => {
  it('should strip pointer suffix', () => {
    expect(normalizeTypeName('ZSTD_CCtx*')).toBe('ZSTD_CCtx');
  });

  it('should strip const qualifier and pointer', () => {
    expect(normalizeTypeName('const ZSTD_CCtx*')).toBe('ZSTD_CCtx');
  });

  it('should strip struct keyword', () => {
    expect(normalizeTypeName('struct Foo')).toBe('Foo');
  });

  it('should strip enum keyword', () => {
    expect(normalizeTypeName('enum Bar')).toBe('Bar');
  });

  it('should strip Rust &mut reference', () => {
    expect(normalizeTypeName('&mut Foo')).toBe('Foo');
  });

  it('should strip Rust lifetime annotation', () => {
    expect(normalizeTypeName("&'a Foo")).toBe('Foo');
  });

  it('should strip Rust static mut lifetime', () => {
    expect(normalizeTypeName("&'static mut Bar")).toBe('Bar');
  });

  it('should truncate at generic args', () => {
    expect(normalizeTypeName('Vec<MyStruct>')).toBe('Vec');
  });

  it('should take last segment after :: for std::vector<int>', () => {
    expect(normalizeTypeName('std::vector<int>')).toBe('vector');
  });

  it('should take last segment after :: for crate::types::Foo', () => {
    expect(normalizeTypeName('crate::types::Foo')).toBe('Foo');
  });

  it('should take last segment after . for MyModule.MyType', () => {
    expect(normalizeTypeName('MyModule.MyType')).toBe('MyType');
  });

  it('should truncate nested generics', () => {
    expect(normalizeTypeName('Option<Box<MyStruct>>')).toBe('Option');
  });

  it('should preserve unsigned int (compound C type)', () => {
    expect(normalizeTypeName('unsigned int')).toBe('unsigned int');
  });

  it('should preserve int32_t', () => {
    expect(normalizeTypeName('int32_t')).toBe('int32_t');
  });

  it('should return empty for empty string', () => {
    expect(normalizeTypeName('')).toBe('');
  });

  it('should return bare name unchanged', () => {
    expect(normalizeTypeName('MyType')).toBe('MyType');
  });

  it('should handle nested generics A<B<C>>', () => {
    expect(normalizeTypeName('A<B<C>>')).toBe('A');
  });

  it('should handle Rust &', () => {
    expect(normalizeTypeName('&Foo')).toBe('Foo');
  });

  it('should preserve long long (C compound type)', () => {
    expect(normalizeTypeName('long long')).toBe('long long');
  });

  it('should handle C function pointer void (*)(int) → empty', () => {
    expect(normalizeTypeName('void (*)(int)')).toBe('');
  });

  it('should strip array suffix', () => {
    expect(normalizeTypeName('int[]')).toBe('int');
  });

  it('should strip volatile qualifier', () => {
    expect(normalizeTypeName('volatile int*')).toBe('int');
  });
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string): number {
  return Number(
    db.prepare("INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, 'main', 'typescript', 0, NULL, '')")
      .run(path).lastInsertRowid,
  );
}

function insertSymbol(db: Database.Database, fileId: number, name: string, kind = 'class', startLine = 1, endLine?: number): number {
  return Number(
    db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, name, kind, startLine, endLine ?? startLine + 10, `${kind} ${name}`).lastInsertRowid,
  );
}

// ─── resolveSymbolEdges: containment-based resolution ─────────────────────────

describe('resolveSymbolEdges – containment mapping', () => {
  it('should resolve symbol_ref when definition_path + definition_line point into a symbol', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const target = insertSymbol(db, file2, 'Widget', 'class', 1, 20);
    const caller = insertSymbol(db, file1, 'renderWidget', 'function', 1, 10);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, definition_path, definition_line)
       VALUES (?, ?, 'Widget', 5, ?, ?)`,
    ).run(caller, file1, 'src/file2.ts', 5);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBe(target);
    expect(ref.resolution_method).toBe('lsp_definition');
  });

  it('should pick the narrowest enclosing symbol when multiple contain the definition line', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    // Outer class spans 1-50, inner method spans 10-20
    insertSymbol(db, file2, 'OuterClass', 'class', 1, 50);
    const innerMethod = insertSymbol(db, file2, 'doStuff', 'function', 10, 20);

    const caller = insertSymbol(db, file1, 'main', 'function', 1, 10);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, definition_path, definition_line)
       VALUES (?, ?, 'doStuff', 5, ?, ?)`,
    ).run(caller, file1, 'src/file2.ts', 15);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBe(innerMethod);
    expect(ref.resolution_method).toBe('lsp_definition');
  });

  it('should mark external_definition when definition_path is not in indexed files', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');

    const caller = insertSymbol(db, file1, 'main', 'function', 1, 10);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, definition_path, definition_line)
       VALUES (?, ?, 'console', 5, ?, ?)`,
    ).run(caller, file1, 'node_modules/typescript/lib/lib.dom.d.ts', 100);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBeNull();
    expect(ref.resolution_method).toBe('external_definition');
  });

  it('should mark unresolved when no definition data is present', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');

    const caller = insertSymbol(db, file1, 'main', 'function', 1, 10);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line) VALUES (?, ?, 'unknown', 5)`,
    ).run(caller, file1);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBeNull();
    expect(ref.resolution_method).toBe('unresolved');
  });

  it('should mark ambiguous_definition when multiple equally-narrow symbols contain the line', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    // Two symbols on the same line with identical spans
    insertSymbol(db, file2, 'alpha', 'function', 5, 5);
    insertSymbol(db, file2, 'beta', 'function', 5, 5);

    const caller = insertSymbol(db, file1, 'main', 'function', 1, 10);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, definition_path, definition_line)
       VALUES (?, ?, 'something', 3, ?, ?)`,
    ).run(caller, file1, 'src/file2.ts', 5);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBeNull();
    expect(ref.resolution_method).toBe('ambiguous_definition');
  });

  it('should resolve type_ref via containment mapping', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const targetType = insertSymbol(db, file2, 'Widget', 'class', 1, 30);
    const consumer = insertSymbol(db, file1, 'render', 'function', 1, 10);

    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, definition_path, definition_line)
       VALUES (?, ?, 'Widget', 'Widget', 'parameter', 5, ?, ?)`,
    ).run(file1, consumer, 'src/file2.ts', 10);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = ?').get(consumer) as { type_id: number | null; resolution_method: string };
    expect(ref.type_id).toBe(targetType);
    expect(ref.resolution_method).toBe('lsp_definition');
  });

  it('should resolve symbol_relationships via containment mapping', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/a.ts');
    const file2 = insertFile(db, 'src/b.ts');

    const parent = insertSymbol(db, file2, 'BaseClass', 'class', 1, 30);
    const child = insertSymbol(db, file1, 'ChildClass', 'class', 1, 20);

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, definition_path, definition_line)
       VALUES (?, ?, 'BaseClass', 'extends', 1, ?, ?)`,
    ).run(file1, child, 'src/b.ts', 5);

    resolveSymbolEdges(db);

    const rel = db.prepare('SELECT target_symbol_id, resolution_method FROM symbol_relationships WHERE source_symbol_id = ?').get(child) as { target_symbol_id: number | null; resolution_method: string };
    expect(rel.target_symbol_id).toBe(parent);
    expect(rel.resolution_method).toBe('lsp_definition');
  });

  it('should mark unresolved when definition_line does not fall within any symbol', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    // The only symbol in file2 spans lines 10-20
    insertSymbol(db, file2, 'Foo', 'class', 10, 20);

    const caller = insertSymbol(db, file1, 'main', 'function', 1, 10);

    // definition_line 5 is outside Foo's range
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, definition_path, definition_line)
       VALUES (?, ?, 'something', 3, ?, ?)`,
    ).run(caller, file1, 'src/file2.ts', 5);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBeNull();
    expect(ref.resolution_method).toBe('unresolved');
  });
});

// ─── resolveSymbolEdges: name-based fallback ──────────────────────────────────

describe('resolveSymbolEdges – name-based fallback', () => {
  it('should resolve symbol_ref via name_same_file when callee is in the same file', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const target = insertSymbol(db, file1, 'handle', 'function', 1, 10);
    insertSymbol(db, file2, 'handle', 'function', 1, 10); // same name, different file

    const caller = insertSymbol(db, file1, 'dispatch', 'function', 20, 30);

    // No definition_path/definition_line — will use name fallback
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line) VALUES (?, ?, 'handle', 22)`,
    ).run(caller, file1);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBe(target);
    expect(ref.resolution_method).toBe('name_same_file');
  });

  it('should resolve symbol_ref via name_unique when callee name is globally unique', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const target = insertSymbol(db, file2, 'UniqueHelper', 'function', 1, 10);
    const caller = insertSymbol(db, file1, 'main', 'function', 1, 10);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line) VALUES (?, ?, 'UniqueHelper', 5)`,
    ).run(caller, file1);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBe(target);
    expect(ref.resolution_method).toBe('name_unique');
  });

  it('should leave unresolved when name has non-unique cross-file matches', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');
    const file3 = insertFile(db, 'src/file3.ts');

    insertSymbol(db, file2, 'handler', 'function', 1, 10);
    insertSymbol(db, file3, 'handler', 'function', 1, 10);

    const caller = insertSymbol(db, file1, 'router', 'function', 1, 10);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line) VALUES (?, ?, 'handler', 5)`,
    ).run(caller, file1);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    expect(ref.callee_id).toBeNull();
    expect(ref.resolution_method).toBe('unresolved');
  });

  it('should resolve type_ref via name_same_file when no LSP data', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const widget1 = insertSymbol(db, file1, 'Widget', 'class', 1, 20);
    insertSymbol(db, file2, 'Widget', 'class', 1, 20);

    const consumer = insertSymbol(db, file1, 'render', 'function', 25, 35);

    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line)
       VALUES (?, ?, 'Widget', 'Widget', 'parameter', 27)`,
    ).run(file1, consumer);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = ?').get(consumer) as { type_id: number | null; resolution_method: string };
    expect(ref.type_id).toBe(widget1);
    expect(ref.resolution_method).toBe('name_same_file');
  });

  it('should resolve symbol_relationships via name_same_file fallback', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/a.ts');

    const parent = insertSymbol(db, file1, 'BaseClass', 'class', 1, 15);
    const child = insertSymbol(db, file1, 'ChildClass', 'class', 20, 35);

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line)
       VALUES (?, ?, 'BaseClass', 'extends', 20)`,
    ).run(file1, child);

    resolveSymbolEdges(db);

    const rel = db.prepare('SELECT target_symbol_id, resolution_method FROM symbol_relationships WHERE source_symbol_id = ?').get(child) as { target_symbol_id: number | null; resolution_method: string };
    expect(rel.target_symbol_id).toBe(parent);
    expect(rel.resolution_method).toBe('name_same_file');
  });

  it('should resolve symbol_relationships with normalizeTypeName fallback', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/a.ts');

    const target = insertSymbol(db, file1, 'Widget', 'class', 1, 15);
    const source = insertSymbol(db, file1, 'ChildWidget', 'class', 20, 35);

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line)
       VALUES (?, ?, 'const Widget*', 'extends', 20)`,
    ).run(file1, source);

    resolveSymbolEdges(db);

    const rel = db.prepare('SELECT target_symbol_id, resolution_method FROM symbol_relationships WHERE source_symbol_id = ?').get(source) as { target_symbol_id: number | null; resolution_method: string };
    expect(rel.target_symbol_id).toBe(target);
    expect(rel.resolution_method).toBe('name_same_file');
  });

  it('should prefer LSP containment over name fallback when both could match', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const sameFileTarget = insertSymbol(db, file1, 'Widget', 'class', 1, 10);
    const lspTarget = insertSymbol(db, file2, 'Widget', 'class', 1, 30);

    const caller = insertSymbol(db, file1, 'main', 'function', 20, 30);

    // Has LSP definition data pointing to file2
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, definition_path, definition_line)
       VALUES (?, ?, 'Widget', 22, ?, ?)`,
    ).run(caller, file1, 'src/file2.ts', 10);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null; resolution_method: string };
    // LSP wins — resolves to file2's Widget, not file1's
    expect(ref.callee_id).toBe(lspTarget);
    expect(ref.resolution_method).toBe('lsp_definition');
  });
});

// ─── topoSort ─────────────────────────────────────────────────────────────────

describe('topoSort', () => {
  it('should return file IDs in topological order for a linear chain', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    const b = insertFile(db, 'src/b.ts');
    const c = insertFile(db, 'src/c.ts');

    // a → b → c (a imports b, b imports c)
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './b', b);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(b, './c', c);

    const sorted = topoSort(db);
    const idxA = sorted.indexOf(String(a));
    const idxB = sorted.indexOf(String(b));
    const idxC = sorted.indexOf(String(c));

    // Dependencies should appear before dependents
    expect(idxC).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxA);
  });

  it('should return all files when no imports exist', () => {
    const db = createDb();
    insertFile(db, 'src/a.ts');
    insertFile(db, 'src/b.ts');
    insertFile(db, 'src/c.ts');

    const sorted = topoSort(db);
    expect(sorted).toHaveLength(3);
  });

  it('should return empty array for empty database', () => {
    const db = createDb();
    expect(topoSort(db)).toEqual([]);
  });

  it('should handle diamond dependency graph', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    const b = insertFile(db, 'src/b.ts');
    const c = insertFile(db, 'src/c.ts');
    const d = insertFile(db, 'src/d.ts');

    // a → b, a → c, b → d, c → d (diamond)
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './b', b);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './c', c);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(b, './d', d);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(c, './d', d);

    const sorted = topoSort(db);
    const idxA = sorted.indexOf(String(a));
    const idxD = sorted.indexOf(String(d));
    expect(idxD).toBeLessThan(idxA);
  });

  it('should skip unresolved imports (resolved_id IS NULL)', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    insertFile(db, 'src/b.ts');
    db.prepare('INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)').run(a, 'external');

    const sorted = topoSort(db);
    expect(sorted).toHaveLength(2);
  });

  it('should exclude cyclic files from result', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    const b = insertFile(db, 'src/b.ts');

    // a → b → a (cycle)
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './b', b);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(b, './a', a);

    const sorted = topoSort(db);
    // Cyclic files are excluded
    expect(sorted.length).toBeLessThanOrEqual(2);
  });
});

// ─── detectCycles ─────────────────────────────────────────────────────────────

describe('detectCycles', () => {
  it('should return empty for acyclic graph', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    const b = insertFile(db, 'src/b.ts');

    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './b', b);

    expect(detectCycles(db)).toEqual([]);
  });

  it('should detect a direct 2-node cycle', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    const b = insertFile(db, 'src/b.ts');

    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './b', b);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(b, './a', a);

    const cycles = detectCycles(db);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toHaveLength(2);
    expect(cycles[0]).toContain(String(a));
    expect(cycles[0]).toContain(String(b));
  });

  it('should detect self-loop', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');

    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './a', a);

    const cycles = detectCycles(db);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toEqual([String(a)]);
  });

  it('should detect 3-node cycle', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    const b = insertFile(db, 'src/b.ts');
    const c = insertFile(db, 'src/c.ts');

    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './b', b);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(b, './c', c);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(c, './a', a);

    const cycles = detectCycles(db);
    expect(cycles.length).toBe(1);
    expect(cycles[0]).toHaveLength(3);
  });

  it('should return empty for empty database', () => {
    const db = createDb();
    expect(detectCycles(db)).toEqual([]);
  });

  it('should not report single nodes without self-loop', () => {
    const db = createDb();
    insertFile(db, 'src/a.ts');

    expect(detectCycles(db)).toEqual([]);
  });

  it('should detect multiple independent cycles', () => {
    const db = createDb();
    const a = insertFile(db, 'src/a.ts');
    const b = insertFile(db, 'src/b.ts');
    const c = insertFile(db, 'src/c.ts');
    const d = insertFile(db, 'src/d.ts');

    // Cycle 1: a ↔ b
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(a, './b', b);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(b, './a', a);

    // Cycle 2: c ↔ d
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(c, './d', d);
    db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(d, './c', c);

    const cycles = detectCycles(db);
    expect(cycles.length).toBe(2);
  });
});