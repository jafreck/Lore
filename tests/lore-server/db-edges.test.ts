import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/indexer/db.js';
import {
  listResolvedEdges,
  listTypeRefs,
  listSymbolRelationships,
} from '../../src/lore-server/db.js';
import type { Database } from '../../src/indexer/db.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string): number {
  return Number(
    db.prepare("INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, 'HEAD', 'typescript', 0, NULL, '')")
      .run(path).lastInsertRowid,
  );
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function',
  startLine = 1,
  endLine?: number,
): number {
  return Number(
    db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, name, kind, startLine, endLine ?? startLine + 10, `${kind} ${name}`).lastInsertRowid,
  );
}

// ─── listResolvedEdges with methods filter ────────────────────────────────────

describe('listResolvedEdges – methods filter', () => {
  it('should filter edges by resolution method when methods option is set', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'caller');
    const b = insertSymbol(db, f, 'callee1');
    const c = insertSymbol(db, f, 'callee2');

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
       VALUES (?, ?, ?, 'callee1', 5, 'lsp_definition')`,
    ).run(a, f, b);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
       VALUES (?, ?, ?, 'callee2', 10, 'name_unique')`,
    ).run(a, f, c);

    // Without filter: both edges
    const all = listResolvedEdges(db);
    expect(all).toHaveLength(2);

    // With lsp_definition only
    const lspOnly = listResolvedEdges(db, { methods: ['lsp_definition'] });
    expect(lspOnly).toHaveLength(1);
    expect(lspOnly[0]!.callee_id).toBe(b);

    // With name_unique only
    const nameOnly = listResolvedEdges(db, { methods: ['name_unique'] });
    expect(nameOnly).toHaveLength(1);
    expect(nameOnly[0]!.callee_id).toBe(c);
  });

  it('should return all edges when methods is not set', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'caller');
    const b = insertSymbol(db, f, 'callee');

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
       VALUES (?, ?, ?, 'callee', 5, 'lsp_definition')`,
    ).run(a, f, b);

    const edges = listResolvedEdges(db);
    expect(edges).toHaveLength(1);
  });
});

// ─── listTypeRefs ─────────────────────────────────────────────────────────────

describe('listTypeRefs', () => {
  it('should return type-ref edges with denormalized metadata', () => {
    const db = createDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const sym = insertSymbol(db, f1, 'render', 'function');
    const typeTarget = insertSymbol(db, f2, 'Widget', 'class');

    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (?, ?, ?, 'Widget', 'Widget', 'parameter', 5, 'lsp_definition')`,
    ).run(f1, sym, typeTarget);

    const edges = listTypeRefs(db);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.symbol_id).toBe(sym);
    expect(edges[0]!.type_id).toBe(typeTarget);
    expect(edges[0]!.type_name).toBe('Widget');
    expect(edges[0]!.ref_kind).toBe('parameter');
    expect(edges[0]!.resolution_method).toBe('lsp_definition');
    expect(edges[0]!.symbol_file_path).toBe('src/a.ts');
    expect(edges[0]!.type_file_path).toBe('src/b.ts');
  });

  it('should filter by resolvedOnly', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const sym = insertSymbol(db, f, 'func');

    // Resolved
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (?, ?, ?, 'Widget', 'Widget', 'parameter', 5, 'lsp_definition')`,
    ).run(f, sym, sym);

    // Unresolved
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (?, ?, 'Unknown', 'Unknown', 'parameter', 10, 'unresolved')`,
    ).run(f, sym);

    const all = listTypeRefs(db);
    expect(all).toHaveLength(2);

    const resolved = listTypeRefs(db, { resolvedOnly: true });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.type_id).toBe(sym);
  });

  it('should filter by methods', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const sym = insertSymbol(db, f, 'func');

    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (?, ?, ?, 'A', 'A', 'parameter', 5, 'lsp_definition')`,
    ).run(f, sym, sym);

    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (?, ?, ?, 'B', 'B', 'return', 10, 'name_same_file')`,
    ).run(f, sym, sym);

    const lspOnly = listTypeRefs(db, { methods: ['lsp_definition'] });
    expect(lspOnly).toHaveLength(1);
    expect(lspOnly[0]!.type_name).toBe('A');
  });
});

// ─── listSymbolRelationships ──────────────────────────────────────────────────

describe('listSymbolRelationships', () => {
  it('should return symbol-relationship edges with denormalized metadata', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const parent = insertSymbol(db, f, 'BaseClass', 'class');
    const child = insertSymbol(db, f, 'ChildClass', 'class');

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
       VALUES (?, ?, ?, 'BaseClass', 'extends', 1, 'name_same_file')`,
    ).run(f, child, parent);

    const edges = listSymbolRelationships(db);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source_symbol_id).toBe(child);
    expect(edges[0]!.target_symbol_id).toBe(parent);
    expect(edges[0]!.relationship_type).toBe('extends');
    expect(edges[0]!.source_file_path).toBe('src/a.ts');
  });

  it('should filter by relationshipType', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const parent = insertSymbol(db, f, 'Base', 'class');
    const iface = insertSymbol(db, f, 'IFace', 'interface');
    const child = insertSymbol(db, f, 'Child', 'class');

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
       VALUES (?, ?, ?, 'Base', 'extends', 1, 'name_same_file')`,
    ).run(f, child, parent);

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
       VALUES (?, ?, ?, 'IFace', 'implements', 2, 'name_same_file')`,
    ).run(f, child, iface);

    const extendsOnly = listSymbolRelationships(db, { relationshipType: 'extends' });
    expect(extendsOnly).toHaveLength(1);

    const implementsOnly = listSymbolRelationships(db, { relationshipType: 'implements' });
    expect(implementsOnly).toHaveLength(1);
  });

  it('should filter by methods', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const parent = insertSymbol(db, f, 'Base', 'class');
    const child = insertSymbol(db, f, 'Child', 'class');

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
       VALUES (?, ?, ?, 'Base', 'extends', 1, 'lsp_definition')`,
    ).run(f, child, parent);

    const noMatch = listSymbolRelationships(db, { methods: ['name_unique'] });
    expect(noMatch).toHaveLength(0);

    const match = listSymbolRelationships(db, { methods: ['lsp_definition'] });
    expect(match).toHaveLength(1);
  });
});
