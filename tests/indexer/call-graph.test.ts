import { describe, it, expect } from 'vitest';
import { resolveSymbolEdges } from '../../src/indexer/call-graph.js';
import { openDb } from '../../src/indexer/db.js';
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

describe('resolveSymbolEdges – definition_path + definition_line', () => {
  it('should resolve type_refs by exact definition_path and definition_line', () => {
    const db = createDb();
    const fileA = insertFile(db, '/src/a.ts');
    const fileB = insertFile(db, '/src/b.ts');
    const widgetId = insertSymbol(db, fileB, 'Widget', 'struct', 10);
    insertSymbol(db, fileB, 'Other', 'struct', 20);

    db.prepare(
      `INSERT INTO type_refs (file_id, type_name, ref_kind, ref_line, definition_path, definition_line)
       VALUES (?, 'Widget', 'parameter', 3, '/src/b.ts', 10)`,
    ).run(fileA);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id FROM type_refs WHERE file_id = ?').get(fileA) as { type_id: number | null };
    expect(row.type_id).toBe(widgetId);
  });

  it('should pick closest symbol when definition_line does not exactly match start_line', () => {
    const db = createDb();
    const fileA = insertFile(db, '/src/a.ts');
    const fileB = insertFile(db, '/src/b.ts');
    insertSymbol(db, fileB, 'Alpha', 'struct', 5);
    const betaId = insertSymbol(db, fileB, 'Beta', 'struct', 20);
    insertSymbol(db, fileB, 'Gamma', 'struct', 50);

    // LSP reports line 18 — closest to Beta at line 20
    db.prepare(
      `INSERT INTO type_refs (file_id, type_name, ref_kind, ref_line, definition_path, definition_line)
       VALUES (?, 'Beta', 'variable', 1, '/src/b.ts', 18)`,
    ).run(fileA);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id FROM type_refs WHERE file_id = ?').get(fileA) as { type_id: number | null };
    expect(row.type_id).toBe(betaId);
  });

  it('should fall back to first symbol when definition_line is null', () => {
    const db = createDb();
    const fileA = insertFile(db, '/src/a.ts');
    const fileB = insertFile(db, '/src/b.ts');
    const firstId = insertSymbol(db, fileB, 'First', 'struct', 5);
    insertSymbol(db, fileB, 'Second', 'struct', 20);

    db.prepare(
      `INSERT INTO type_refs (file_id, type_name, ref_kind, ref_line, definition_path)
       VALUES (?, 'First', 'variable', 1, '/src/b.ts')`,
    ).run(fileA);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id FROM type_refs WHERE file_id = ?').get(fileA) as { type_id: number | null };
    expect(row.type_id).toBe(firstId);
  });

  it('should leave type_id null when definition_path is null', () => {
    const db = createDb();
    const fileA = insertFile(db, '/src/a.ts');

    db.prepare(
      `INSERT INTO type_refs (file_id, type_name, ref_kind, ref_line)
       VALUES (?, 'Unknown', 'variable', 1)`,
    ).run(fileA);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT type_id FROM type_refs WHERE file_id = ?').get(fileA) as { type_id: number | null };
    expect(row.type_id).toBeNull();
  });

  it('should resolve symbol_refs by definition_path + definition_line', () => {
    const db = createDb();
    const fileA = insertFile(db, '/src/a.ts');
    const fileB = insertFile(db, '/src/b.ts');
    const callerId = insertSymbol(db, fileA, 'caller');
    const calleeId = insertSymbol(db, fileB, 'callee', 'function', 15);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line, definition_path, definition_line)
       VALUES (?, 'callee', 10, '/src/b.ts', 15)`,
    ).run(callerId);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT callee_id FROM symbol_refs').get() as { callee_id: number | null };
    expect(row.callee_id).toBe(calleeId);
  });

  it('should resolve symbol_relationships by definition_path + definition_line', () => {
    const db = createDb();
    const fileA = insertFile(db, '/src/a.ts');
    const fileB = insertFile(db, '/src/b.ts');
    const derivedId = insertSymbol(db, fileA, 'Derived', 'class');
    const baseId = insertSymbol(db, fileB, 'Base', 'class', 10);

    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, definition_path, definition_line)
       VALUES (?, ?, 'Base', 'extends', 5, '/src/b.ts', 10)`,
    ).run(fileA, derivedId);

    resolveSymbolEdges(db);

    const row = db.prepare('SELECT target_symbol_id FROM symbol_relationships WHERE file_id = ?').get(fileA) as { target_symbol_id: number | null };
    expect(row.target_symbol_id).toBe(baseId);
  });
});
