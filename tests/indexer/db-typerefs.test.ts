/**
 * DB integration tests for type_refs and symbol_relationships tables,
 * resolveSymbolEdges resolution, and stale cleanup.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/indexer/db.js';
import { resolveSymbolEdges, normalizeTypeName } from '../../src/indexer/call-graph.js';
import type { Database } from '../../src/indexer/db.js';

function createDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string, branch = 'main'): number {
  return Number(
    db.prepare("INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, ?, 'typescript', 0, NULL, '')")
      .run(path, branch).lastInsertRowid,
  );
}

function insertSymbol(db: Database.Database, fileId: number, name: string, kind = 'function', startLine = 1): number {
  return Number(
    db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, name, kind, startLine, startLine + 5, `${kind} ${name}`).lastInsertRowid,
  );
}

// ─── type_refs table ──────────────────────────────────────────────────────────

describe('type_refs table', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createDb();
    fileId = insertFile(db, 'src/main.ts');
  });

  it('should create type_refs table in production DDL', () => {
    const rows = db.pragma('table_info(type_refs)') as Array<{ name: string }>;
    const columns = rows.map(r => r.name);
    expect(columns).toContain('file_id');
    expect(columns).toContain('symbol_id');
    expect(columns).toContain('type_id');
    expect(columns).toContain('type_name');
    expect(columns).toContain('type_name_bare');
    expect(columns).toContain('ref_kind');
    expect(columns).toContain('ref_line');
    expect(columns).toContain('ref_character');
    expect(columns).toContain('resolved_type_signature');
    expect(columns).toContain('definition_uri');
    expect(columns).toContain('definition_path');
  });

  it('should insert type ref with file_id and null symbol_id for file-scope refs', () => {
    const bare = normalizeTypeName('MyType');
    db.prepare(
      'INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(fileId, 'MyType', bare, 'variable', 5);

    const row = db.prepare('SELECT * FROM type_refs WHERE file_id = ?').get(fileId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.symbol_id).toBeNull();
    expect(row.type_name).toBe('MyType');
    expect(row.type_name_bare).toBe('MyType');
    expect(row.ref_kind).toBe('variable');
    expect(row.ref_line).toBe(5);
  });

  it('should insert type ref with symbol_id for function-scoped refs', () => {
    const symId = insertSymbol(db, fileId, 'process');
    db.prepare(
      'INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(fileId, symId, 'Widget', 'Widget', 'parameter', 3);

    const row = db.prepare('SELECT * FROM type_refs WHERE symbol_id = ?').get(symId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.symbol_id).toBe(symId);
  });

  it('should store both type_name (qualified) and type_name_bare (normalized)', () => {
    const qualified = 'std::vector<int>';
    const bare = normalizeTypeName(qualified);
    db.prepare(
      'INSERT INTO type_refs (file_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, qualified, bare, 'variable', 1);

    const row = db.prepare('SELECT type_name, type_name_bare FROM type_refs WHERE file_id = ?').get(fileId) as Record<string, unknown>;
    expect(row.type_name).toBe('std::vector<int>');
    expect(row.type_name_bare).toBe('vector');
  });

  it('should cascade-delete type_refs when file is deleted', () => {
    db.prepare(
      'INSERT INTO type_refs (file_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'Foo', 'Foo', 'variable', 1);

    expect((db.prepare('SELECT COUNT(*) AS c FROM type_refs').get() as { c: number }).c).toBe(1);
    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM type_refs').get() as { c: number }).c).toBe(0);
  });

  it('should cascade-delete type_refs when enclosing symbol is deleted', () => {
    const symId = insertSymbol(db, fileId, 'fn1');
    db.prepare(
      'INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(fileId, symId, 'Baz', 'Baz', 'parameter', 2);

    expect((db.prepare('SELECT COUNT(*) AS c FROM type_refs').get() as { c: number }).c).toBe(1);
    db.prepare('DELETE FROM symbols WHERE id = ?').run(symId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM type_refs').get() as { c: number }).c).toBe(0);
  });
});

// ─── symbol_relationships table ───────────────────────────────────────────────

describe('symbol_relationships table', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createDb();
    fileId = insertFile(db, 'src/main.ts');
  });

  it('should create symbol_relationships table in production DDL', () => {
    const rows = db.pragma('table_info(symbol_relationships)') as Array<{ name: string }>;
    const columns = rows.map(r => r.name);
    expect(columns).toContain('file_id');
    expect(columns).toContain('source_symbol_id');
    expect(columns).toContain('target_symbol_id');
    expect(columns).toContain('target_symbol_name');
    expect(columns).toContain('relationship_type');
    expect(columns).toContain('line');
    expect(columns).toContain('definition_uri');
    expect(columns).toContain('definition_path');
  });

  it('should insert relationship with file_id and line', () => {
    const srcId = insertSymbol(db, fileId, 'Derived', 'class');
    db.prepare(
      'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, srcId, 'Base', 'extends', 5);

    const row = db.prepare('SELECT * FROM symbol_relationships WHERE file_id = ?').get(fileId) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.source_symbol_id).toBe(srcId);
    expect(row.target_symbol_name).toBe('Base');
    expect(row.relationship_type).toBe('extends');
    expect(row.line).toBe(5);
  });

  it('should allow null source_symbol_id for file-scope relationships', () => {
    db.prepare(
      'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line) VALUES (?, NULL, ?, ?, ?)',
    ).run(fileId, 'SomeTrait', 'implements', 10);

    const row = db.prepare('SELECT * FROM symbol_relationships WHERE file_id = ?').get(fileId) as Record<string, unknown>;
    expect(row.source_symbol_id).toBeNull();
  });

  it('should cascade-delete when file is deleted', () => {
    const srcId = insertSymbol(db, fileId, 'MyClass', 'class');
    db.prepare(
      'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, srcId, 'IFace', 'implements', 1);

    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM symbol_relationships').get() as { c: number }).c).toBe(0);
  });
});

// ─── resolveSymbolEdges ───────────────────────────────────────────────────────

describe('resolveSymbolEdges', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it('should resolve type_refs.type_id via containment when definition_path and definition_line match a symbol', () => {
    const fileId = insertFile(db, 'src/a.ts');
    const widgetId = insertSymbol(db, fileId, 'Widget', 'struct', 1);
    const processId = insertSymbol(db, fileId, 'process', 'function', 10);

    db.prepare(
      'INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, definition_path, definition_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(fileId, processId, 'Widget', 'Widget', 'parameter', 12, 'src/a.ts', 3);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE file_id = ?').get(fileId) as { type_id: number | null; resolution_method: string };
    expect(row.type_id).toBe(widgetId);
    expect(row.resolution_method).toBe('lsp_definition');
  });

  it('should resolve type_refs.type_id via containment with narrowest match', () => {
    const fileId = insertFile(db, 'src/a.ts');
    // OuterModule spans lines 1-50 (wide), Foo spans lines 3-8 (narrow)
    db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, 'OuterModule', 'module', 1, 50, 'module OuterModule');
    const fooId = insertSymbol(db, fileId, 'Foo', 'struct', 3);

    db.prepare(
      'INSERT INTO type_refs (file_id, type_name, type_name_bare, ref_kind, ref_line, definition_path, definition_line) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(fileId, 'crate::types::Foo', 'Foo', 'variable', 1, 'src/a.ts', 4);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE file_id = ?').get(fileId) as { type_id: number | null; resolution_method: string };
    expect(row.type_id).toBe(fooId);
    expect(row.resolution_method).toBe('lsp_definition');
  });

  it('should resolve symbol_relationships.target_symbol_id via containment', () => {
    const fileId = insertFile(db, 'src/a.ts');
    const baseId = insertSymbol(db, fileId, 'Base', 'class', 1);
    const derivedId = insertSymbol(db, fileId, 'Derived', 'class', 10);

    db.prepare(
      'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, definition_path, definition_line) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(fileId, derivedId, 'Base', 'extends', 10, 'src/a.ts', 3);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT target_symbol_id, resolution_method FROM symbol_relationships WHERE file_id = ?').get(fileId) as { target_symbol_id: number | null; resolution_method: string };
    expect(row.target_symbol_id).toBe(baseId);
    expect(row.resolution_method).toBe('lsp_definition');
  });

  it('should resolve symbol_refs.callee_id via containment', () => {
    const fileId = insertFile(db, 'src/a.ts');
    const callerId = insertSymbol(db, fileId, 'caller', 'function', 10);
    const calleeId = insertSymbol(db, fileId, 'callee', 'function', 1);

    db.prepare(
      'INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, definition_path, definition_line) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(callerId, fileId, 'callee', 12, 'src/a.ts', 3);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT callee_id, resolution_method FROM symbol_refs').get() as { callee_id: number | null; resolution_method: string };
    expect(row.callee_id).toBe(calleeId);
    expect(row.resolution_method).toBe('lsp_definition');
  });

  it('should leave type_id null and mark unresolved when no definition data is present', () => {
    const fileId = insertFile(db, 'src/a.ts');
    insertSymbol(db, fileId, 'process');

    db.prepare(
      'INSERT INTO type_refs (file_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'ExternalType', 'ExternalType', 'parameter', 1);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE file_id = ?').get(fileId) as { type_id: number | null; resolution_method: string };
    expect(row.type_id).toBeNull();
    expect(row.resolution_method).toBe('unresolved');
  });

  it('should mark external_definition when definition_path is not in index', () => {
    const fileA = insertFile(db, 'src/a.ts');
    const processId = insertSymbol(db, fileA, 'process');

    db.prepare(
      'INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, definition_path, definition_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(fileA, processId, 'Widget', 'Widget', 'parameter', 3, 'node_modules/widget/index.d.ts', 10);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = ?').get(processId) as { type_id: number | null; resolution_method: string };
    expect(row.type_id).toBeNull();
    expect(row.resolution_method).toBe('external_definition');
  });
});

// ─── Stale cleanup ────────────────────────────────────────────────────────────

describe('stale cleanup for type_refs and symbol_relationships', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it('should delete type_refs by file_id on re-index', () => {
    const fileId = insertFile(db, 'src/a.ts');
    db.prepare(
      'INSERT INTO type_refs (file_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'OldType', 'OldType', 'variable', 1);

    // Simulate stale cleanup (as processFile does)
    db.prepare('DELETE FROM type_refs WHERE file_id = ?').run(fileId);

    expect((db.prepare('SELECT COUNT(*) AS c FROM type_refs WHERE file_id = ?').get(fileId) as { c: number }).c).toBe(0);
  });

  it('should delete symbol_relationships by file_id on re-index', () => {
    const fileId = insertFile(db, 'src/a.ts');
    const symId = insertSymbol(db, fileId, 'MyClass', 'class');
    db.prepare(
      'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, symId, 'OldBase', 'extends', 1);

    db.prepare('DELETE FROM symbol_relationships WHERE file_id = ?').run(fileId);

    expect((db.prepare('SELECT COUNT(*) AS c FROM symbol_relationships WHERE file_id = ?').get(fileId) as { c: number }).c).toBe(0);
  });

  it('should null out type_refs.type_id when referenced symbol file is deleted (update path)', () => {
    const fileA = insertFile(db, 'src/a.ts');
    const fileB = insertFile(db, 'src/b.ts');
    const widgetId = insertSymbol(db, fileB, 'Widget', 'struct');

    db.prepare(
      'INSERT INTO type_refs (file_id, type_name, type_name_bare, ref_kind, ref_line, type_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(fileA, 'Widget', 'Widget', 'parameter', 1, widgetId);

    // Simulate update() stale cleanup for file B
    db.prepare('UPDATE type_refs SET type_id = NULL WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileB);

    const row = db.prepare('SELECT type_id FROM type_refs WHERE file_id = ?').get(fileA) as { type_id: number | null };
    expect(row.type_id).toBeNull();
  });

  it('should null out symbol_relationships.target_symbol_id when referenced symbol file is deleted', () => {
    const fileA = insertFile(db, 'src/a.ts');
    const fileB = insertFile(db, 'src/b.ts');
    const baseId = insertSymbol(db, fileB, 'Base', 'class');
    const derivedId = insertSymbol(db, fileA, 'Derived', 'class');

    db.prepare(
      'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(fileA, derivedId, baseId, 'Base', 'extends', 1);

    // Simulate update() stale cleanup for file B
    db.prepare('UPDATE symbol_relationships SET target_symbol_id = NULL WHERE target_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileB);

    const row = db.prepare('SELECT target_symbol_id FROM symbol_relationships WHERE file_id = ?').get(fileA) as { target_symbol_id: number | null };
    expect(row.target_symbol_id).toBeNull();
  });
});

// ─── call_character column ────────────────────────────────────────────────────

describe('call_character column on symbol_refs', () => {
  it('should exist in the symbol_refs DDL', () => {
    const db = createDb();
    const rows = db.pragma('table_info(symbol_refs)') as Array<{ name: string }>;
    const columns = rows.map(r => r.name);
    expect(columns).toContain('call_character');
  });
});
