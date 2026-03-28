import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import {
  normalizeTypeName,
  extractBareName,
  resolveSymbolEdges,
  topoSort,
  detectCycles,
} from '../../src/resolution/call-graph.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function insertFile(db: Database.Database, opts: { path: string; language?: string; branch?: string; layer?: string }): number {
  return db.prepare(
    `INSERT INTO files (path, language, branch, layer) VALUES (?, ?, ?, ?)`,
  ).run(opts.path, opts.language ?? 'typescript', opts.branch ?? '', opts.layer ?? 'baseline').lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, opts: {
  fileId: number; name: string; kind?: string; startLine?: number; endLine?: number; layer?: string;
}): number {
  return db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.fileId, opts.name, opts.kind ?? 'function', opts.startLine ?? 1, opts.endLine ?? 10, opts.layer ?? 'baseline').lastInsertRowid as number;
}

function insertSymbolRef(db: Database.Database, opts: {
  callerId: number; fileId: number; calleeName: string; callLine?: number;
  calleeId?: number | null; resolutionMethod?: string; layer?: string;
  definitionPath?: string | null; definitionLine?: number | null;
}): number {
  return db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, callee_id, resolution_method, layer, definition_path, definition_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.callerId, opts.fileId, opts.calleeName, opts.callLine ?? 5,
    opts.calleeId ?? null, opts.resolutionMethod ?? 'unresolved', opts.layer ?? 'baseline',
    opts.definitionPath ?? null, opts.definitionLine ?? null,
  ).lastInsertRowid as number;
}

function insertTypeRef(db: Database.Database, opts: {
  fileId: number; symbolId: number | null; typeName: string; typeNameBare: string;
  refLine?: number; typeId?: number | null; resolutionMethod?: string; layer?: string;
  definitionPath?: string | null; definitionLine?: number | null;
}): number {
  return db.prepare(
    `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, type_id, resolution_method, layer, definition_path, definition_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.fileId, opts.symbolId, opts.typeName, opts.typeNameBare,
    opts.refLine ?? 3, opts.typeId ?? null, opts.resolutionMethod ?? 'unresolved',
    opts.layer ?? 'baseline', opts.definitionPath ?? null, opts.definitionLine ?? null,
  ).lastInsertRowid as number;
}

function insertFileImport(db: Database.Database, fileId: number, rawImport: string, resolvedId: number | null): number {
  return db.prepare(
    `INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)`,
  ).run(fileId, rawImport, resolvedId).lastInsertRowid as number;
}

// ─── normalizeTypeName ────────────────────────────────────────────────────────

describe('normalizeTypeName', () => {
  it('returns bare name from simple identifier', () => {
    expect(normalizeTypeName('MyClass')).toBe('MyClass');
  });

  it('strips const/volatile qualifiers', () => {
    expect(normalizeTypeName('const int')).toBe('int');
    expect(normalizeTypeName('volatile double')).toBe('double');
  });

  it('strips struct/enum/union/class keywords', () => {
    expect(normalizeTypeName('struct Node')).toBe('Node');
    expect(normalizeTypeName('enum Color')).toBe('Color');
    expect(normalizeTypeName('class Widget')).toBe('Widget');
    expect(normalizeTypeName('union Data')).toBe('Data');
  });

  it('strips generics (angle brackets)', () => {
    expect(normalizeTypeName('List<String>')).toBe('List');
    expect(normalizeTypeName('Map<String, Integer>')).toBe('Map');
    expect(normalizeTypeName('std::vector<int>')).toBe('vector');
  });

  it('takes last segment after :: or .', () => {
    expect(normalizeTypeName('std::string')).toBe('string');
    expect(normalizeTypeName('com.example.MyClass')).toBe('MyClass');
    expect(normalizeTypeName('a::b::c')).toBe('c');
  });

  it('strips pointer/reference suffixes', () => {
    expect(normalizeTypeName('int*')).toBe('int');
    expect(normalizeTypeName('Node&')).toBe('Node');
    expect(normalizeTypeName('int[]')).toBe('int');
  });

  it('strips nullable suffix', () => {
    expect(normalizeTypeName('String?')).toBe('String');
  });

  it('strips Rust reference/lifetime syntax', () => {
    expect(normalizeTypeName("&'a str")).toBe('str');
    expect(normalizeTypeName('&mut Vec')).toBe('Vec');
    expect(normalizeTypeName('&str')).toBe('str');
  });

  it('returns empty for function pointer syntax', () => {
    expect(normalizeTypeName('void (*)(int)')).toBe('');
  });

  it('handles combined qualifiers', () => {
    expect(normalizeTypeName('const struct Node*')).toBe('Node');
  });

  it('trims whitespace', () => {
    expect(normalizeTypeName('  int  ')).toBe('int');
  });
});

// ─── extractBareName ──────────────────────────────────────────────────────────

describe('extractBareName', () => {
  it('returns the name unchanged when no dot', () => {
    expect(extractBareName('simpleName')).toBe('simpleName');
  });

  it('extracts last segment after dot', () => {
    expect(extractBareName('db.prepare')).toBe('prepare');
    expect(extractBareName('JSON.stringify')).toBe('stringify');
    expect(extractBareName('Math.max')).toBe('max');
  });

  it('handles chained member access', () => {
    expect(extractBareName('node.namedChildren.find')).toBe('find');
  });

  it('handles multiline callee', () => {
    expect(extractBareName('db\n    .prepare')).toBe('prepare');
  });
});

// ─── resolveSymbolEdges ───────────────────────────────────────────────────────

describe('resolveSymbolEdges', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('resolves by containment (lsp_definition) when definition_path/line match', () => {
    const fid = insertFile(db, { path: 'src/foo.ts' });
    const targetSym = insertSymbol(db, { fileId: fid, name: 'targetFn', startLine: 10, endLine: 20 });
    const callerSym = insertSymbol(db, { fileId: fid, name: 'callerFn', startLine: 25, endLine: 35 });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid, calleeName: 'targetFn',
      definitionPath: 'src/foo.ts', definitionLine: 15,
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.callee_id).toBe(targetSym);
    expect(ref.resolution_method).toBe('lsp_definition');
  });

  it('marks external_definition when definition_path not in files', () => {
    const fid = insertFile(db, { path: 'src/foo.ts' });
    const callerSym = insertSymbol(db, { fileId: fid, name: 'callerFn' });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid, calleeName: 'externalFn',
      definitionPath: 'node_modules/lib/index.ts', definitionLine: 5,
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.resolution_method).toBe('external_definition');
  });

  it('resolves by name_same_file when exactly one match in same file', () => {
    const fid = insertFile(db, { path: 'src/foo.ts' });
    const targetSym = insertSymbol(db, { fileId: fid, name: 'helperFn', startLine: 1, endLine: 5 });
    const callerSym = insertSymbol(db, { fileId: fid, name: 'mainFn', startLine: 10, endLine: 20 });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid, calleeName: 'helperFn',
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.callee_id).toBe(targetSym);
    expect(ref.resolution_method).toBe('name_same_file');
  });

  it('resolves by name_unique when exactly one match globally', () => {
    const fid1 = insertFile(db, { path: 'src/a.ts' });
    const fid2 = insertFile(db, { path: 'src/b.ts' });
    const targetSym = insertSymbol(db, { fileId: fid2, name: 'uniqueHelper' });
    const callerSym = insertSymbol(db, { fileId: fid1, name: 'callerFn' });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid1, calleeName: 'uniqueHelper',
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.callee_id).toBe(targetSym);
    expect(ref.resolution_method).toBe('name_unique');
  });

  it('leaves unresolved when multiple cross-file candidates exist', () => {
    const fid1 = insertFile(db, { path: 'src/a.ts' });
    const fid2 = insertFile(db, { path: 'src/b.ts' });
    const fid3 = insertFile(db, { path: 'src/c.ts' });
    insertSymbol(db, { fileId: fid2, name: 'ambiguousFn' });
    insertSymbol(db, { fileId: fid3, name: 'ambiguousFn' });
    const callerSym = insertSymbol(db, { fileId: fid1, name: 'callerFn' });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid1, calleeName: 'ambiguousFn',
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.callee_id).toBeNull();
  });

  it('resolves by name_single_file when multiple matches but all in same target file', () => {
    const fid1 = insertFile(db, { path: 'src/a.ts' });
    const fid2 = insertFile(db, { path: 'src/b.ts' });
    // Two overloads in same file
    const sym1 = insertSymbol(db, { fileId: fid2, name: 'overloaded', startLine: 1, endLine: 5 });
    insertSymbol(db, { fileId: fid2, name: 'overloaded', startLine: 10, endLine: 15 });
    const callerSym = insertSymbol(db, { fileId: fid1, name: 'callerFn' });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid1, calleeName: 'overloaded',
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.callee_id).toBe(sym1);
    expect(ref.resolution_method).toBe('name_single_file');
  });

  it('excludes macro/constant/enum_member from cross-file name_unique', () => {
    const fid1 = insertFile(db, { path: 'src/a.ts' });
    const fid2 = insertFile(db, { path: 'src/b.ts' });
    insertSymbol(db, { fileId: fid2, name: 'MAX', kind: 'constant' });
    const callerSym = insertSymbol(db, { fileId: fid1, name: 'callerFn' });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid1, calleeName: 'MAX',
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.callee_id).toBeNull();
  });

  it('resolves type_refs by containment', () => {
    const fid = insertFile(db, { path: 'src/types.ts' });
    const targetSym = insertSymbol(db, { fileId: fid, name: 'MyInterface', kind: 'interface', startLine: 1, endLine: 10 });
    const usingSym = insertSymbol(db, { fileId: fid, name: 'MyClass', kind: 'class', startLine: 15, endLine: 30 });

    insertTypeRef(db, {
      fileId: fid, symbolId: usingSym, typeName: 'MyInterface', typeNameBare: 'MyInterface',
      definitionPath: 'src/types.ts', definitionLine: 5,
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = ?').get(usingSym) as any;
    expect(ref.type_id).toBe(targetSym);
    expect(ref.resolution_method).toBe('lsp_definition');
  });

  it('resolves type_refs by bare name fallback', () => {
    const fid1 = insertFile(db, { path: 'src/a.ts' });
    const fid2 = insertFile(db, { path: 'src/b.ts' });
    const targetSym = insertSymbol(db, { fileId: fid2, name: 'Widget', kind: 'class' });
    const usingSym = insertSymbol(db, { fileId: fid1, name: 'Consumer', kind: 'function' });

    insertTypeRef(db, {
      fileId: fid1, symbolId: usingSym, typeName: 'com.example.Widget', typeNameBare: 'Widget',
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = ?').get(usingSym) as any;
    expect(ref.type_id).toBe(targetSym);
    expect(ref.resolution_method).toBe('name_unique');
  });

  it('respects overlayOnly option', () => {
    const fid = insertFile(db, { path: 'src/foo.ts', layer: 'baseline' });
    const fidOverlay = insertFile(db, { path: 'src/bar.ts', layer: 'overlay' });
    const targetSym = insertSymbol(db, { fileId: fidOverlay, name: 'overlayFn' });
    const callerBaseline = insertSymbol(db, { fileId: fid, name: 'baselineCaller' });
    const callerOverlay = insertSymbol(db, { fileId: fidOverlay, name: 'overlayCaller' });

    // Baseline ref
    insertSymbolRef(db, {
      callerId: callerBaseline, fileId: fid, calleeName: 'overlayFn', layer: 'baseline',
    });
    // Overlay ref
    insertSymbolRef(db, {
      callerId: callerOverlay, fileId: fidOverlay, calleeName: 'overlayFn', layer: 'overlay',
    });

    resolveSymbolEdges(db, { overlayOnly: true });

    // Overlay ref should be resolved
    const overlayRef = db.prepare('SELECT callee_id FROM symbol_refs WHERE caller_id = ?').get(callerOverlay) as any;
    expect(overlayRef.callee_id).toBe(targetSym);

    // Baseline ref should NOT have been processed (still unresolved)
    const baselineRef = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerBaseline) as any;
    expect(baselineRef.callee_id).toBeNull();
    expect(baselineRef.resolution_method).toBe('unresolved');
  });

  it('resolves bare-name fallback for member-access callee (foo.bar → bar)', () => {
    const fid1 = insertFile(db, { path: 'src/a.ts' });
    const fid2 = insertFile(db, { path: 'src/b.ts' });
    const targetSym = insertSymbol(db, { fileId: fid2, name: 'prepare' });
    const callerSym = insertSymbol(db, { fileId: fid1, name: 'caller' });

    insertSymbolRef(db, {
      callerId: callerSym, fileId: fid1, calleeName: 'db.prepare',
    });

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?').get(callerSym) as any;
    expect(ref.callee_id).toBe(targetSym);
    expect(ref.resolution_method).toBe('name_unique');
  });

  it('resolves symbol_relationships by containment', () => {
    const fid = insertFile(db, { path: 'src/types.ts' });
    const parentSym = insertSymbol(db, { fileId: fid, name: 'BaseClass', kind: 'class', startLine: 1, endLine: 20 });
    const childSym = insertSymbol(db, { fileId: fid, name: 'DerivedClass', kind: 'class', startLine: 25, endLine: 40 });

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, definition_path, definition_line, resolution_method)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fid, childSym, 'BaseClass', 'extends', 'src/types.ts', 10, 'unresolved');

    resolveSymbolEdges(db);

    const rel = db.prepare('SELECT target_symbol_id, resolution_method FROM symbol_relationships WHERE source_symbol_id = ?').get(childSym) as any;
    expect(rel.target_symbol_id).toBe(parentSym);
    expect(rel.resolution_method).toBe('lsp_definition');
  });
});

// ─── topoSort ─────────────────────────────────────────────────────────────────

describe('topoSort', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('returns empty for empty DB', () => {
    const result = topoSort(db);
    expect(result).toEqual([]);
  });

  it('returns single file when no imports', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const result = topoSort(db);
    expect(result).toEqual([String(fid)]);
  });

  it('sorts dependencies before dependents', () => {
    const fid1 = insertFile(db, { path: 'utils.ts' });
    const fid2 = insertFile(db, { path: 'app.ts' });
    insertFileImport(db, fid2, './utils', fid1);

    const result = topoSort(db);
    const idx1 = result.indexOf(String(fid1));
    const idx2 = result.indexOf(String(fid2));
    expect(idx1).toBeLessThan(idx2);
  });

  it('handles diamond dependency', () => {
    const a = insertFile(db, { path: 'a.ts' });
    const b = insertFile(db, { path: 'b.ts' });
    const c = insertFile(db, { path: 'c.ts' });
    const d = insertFile(db, { path: 'd.ts' });
    // d depends on b and c, both depend on a
    insertFileImport(db, b, './a', a);
    insertFileImport(db, c, './a', a);
    insertFileImport(db, d, './b', b);
    insertFileImport(db, d, './c', c);

    const result = topoSort(db);
    expect(result.indexOf(String(a))).toBeLessThan(result.indexOf(String(b)));
    expect(result.indexOf(String(a))).toBeLessThan(result.indexOf(String(c)));
    expect(result.indexOf(String(b))).toBeLessThan(result.indexOf(String(d)));
    expect(result.indexOf(String(c))).toBeLessThan(result.indexOf(String(d)));
  });

  it('excludes cyclic files from sorted output', () => {
    const a = insertFile(db, { path: 'a.ts' });
    const b = insertFile(db, { path: 'b.ts' });
    // Cycle: a → b → a
    insertFileImport(db, a, './b', b);
    insertFileImport(db, b, './a', a);

    const result = topoSort(db);
    // Both should be excluded (they have non-zero in-degree in the cycle)
    expect(result).not.toContain(String(a));
    expect(result).not.toContain(String(b));
  });
});

// ─── detectCycles ─────────────────────────────────────────────────────────────

describe('detectCycles', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('returns empty for acyclic graph', () => {
    const a = insertFile(db, { path: 'a.ts' });
    const b = insertFile(db, { path: 'b.ts' });
    insertFileImport(db, a, './b', b);

    const sccs = detectCycles(db);
    expect(sccs).toEqual([]);
  });

  it('detects simple two-file cycle', () => {
    const a = insertFile(db, { path: 'a.ts' });
    const b = insertFile(db, { path: 'b.ts' });
    insertFileImport(db, a, './b', b);
    insertFileImport(db, b, './a', a);

    const sccs = detectCycles(db);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toHaveLength(2);
    expect(sccs[0]!.sort()).toEqual([String(a), String(b)].sort());
  });

  it('detects self-loop', () => {
    const a = insertFile(db, { path: 'a.ts' });
    insertFileImport(db, a, './a', a);

    const sccs = detectCycles(db);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toEqual([String(a)]);
  });

  it('returns no SCC for single node without self-loop', () => {
    insertFile(db, { path: 'a.ts' });
    const sccs = detectCycles(db);
    expect(sccs).toEqual([]);
  });

  it('detects three-file cycle', () => {
    const a = insertFile(db, { path: 'a.ts' });
    const b = insertFile(db, { path: 'b.ts' });
    const c = insertFile(db, { path: 'c.ts' });
    insertFileImport(db, a, './b', b);
    insertFileImport(db, b, './c', c);
    insertFileImport(db, c, './a', a);

    const sccs = detectCycles(db);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]!.sort()).toEqual([String(a), String(b), String(c)].sort());
  });
});
