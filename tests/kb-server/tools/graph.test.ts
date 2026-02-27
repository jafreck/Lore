import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type GraphArgs, type GraphEdge } from '../../../src/kb-server/tools/graph.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT '',
      language    TEXT    NOT NULL DEFAULT 'typescript',
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      last_hash   TEXT,
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'function',
      start_line  INTEGER NOT NULL DEFAULT 1,
      end_line    INTEGER NOT NULL DEFAULT 10,
      signature   TEXT,
      doc_comment TEXT
    );
    CREATE TABLE symbol_refs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      callee_id   INTEGER,
      callee_name TEXT    NOT NULL
    );
    CREATE TABLE file_imports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      raw_import  TEXT    NOT NULL,
      resolved_id INTEGER REFERENCES files(id)
    );
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, 'typescript');
  return result.lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, fileId: number, name: string): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    )
    .run(fileId, name, 'function');
  return result.lastInsertRowid as number;
}

function insertCallEdge(
  db: Database.Database,
  callerId: number,
  calleeId: number | null,
  calleeName: string,
): void {
  db.prepare('INSERT INTO symbol_refs (caller_id, callee_id, callee_name) VALUES (?, ?, ?)').run(
    callerId,
    calleeId,
    calleeName,
  );
}

function insertImportEdge(
  db: Database.Database,
  fileId: number,
  rawImport: string,
  resolvedId: number | null,
): void {
  db.prepare(
    'INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)',
  ).run(fileId, rawImport, resolvedId);
}

// ─── handler (kind=call) ──────────────────────────────────────────────────────

describe('graph handler – kind=call', () => {
  let db: Database.Database;
  let mainSymbolId: number;
  let featSymbolId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main');
    const featFileId = insertFile(db, 'src/feat.ts', 'feat');
    mainSymbolId = insertSymbol(db, mainFileId, 'caller');
    featSymbolId = insertSymbol(db, featFileId, 'featCaller');
    insertCallEdge(db, mainSymbolId, null, 'callee');
    insertCallEdge(db, featSymbolId, null, 'featCallee');
  });

  it('should return all call edges when no filter', () => {
    const result = handler(db, { kind: 'call' });
    expect(result.edges.length).toBe(2);
  });

  it('should include source_branch on each edge', () => {
    const result = handler(db, { kind: 'call' });
    result.edges.forEach((e) => expect(typeof e.source_branch).toBe('string'));
  });

  it('should filter call edges by source_id', () => {
    const result = handler(db, { kind: 'call', source_id: mainSymbolId });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('caller');
  });

  it('should filter call edges by branch', () => {
    const result = handler(db, { kind: 'call', branch: 'main' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('main');
  });

  it('should filter call edges by source_id and branch', () => {
    const result = handler(db, { kind: 'call', source_id: mainSymbolId, branch: 'main' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('main');
  });

  it('should return empty edges when branch does not match', () => {
    const result = handler(db, { kind: 'call', branch: 'nonexistent' });
    expect(result.edges).toEqual([]);
  });

  it('should respect the limit parameter', () => {
    const result = handler(db, { kind: 'call', limit: 1 });
    expect(result.edges.length).toBeLessThanOrEqual(1);
  });
});

// ─── handler (kind=import) ────────────────────────────────────────────────────

describe('graph handler – kind=import', () => {
  let db: Database.Database;
  let mainFileId: number;
  let featFileId: number;

  beforeEach(() => {
    db = createTestDb();
    mainFileId = insertFile(db, 'src/main.ts', 'main');
    featFileId = insertFile(db, 'src/feat.ts', 'feat');
    const utilsFileId = insertFile(db, 'src/utils.ts', 'main');
    insertImportEdge(db, mainFileId, './utils', utilsFileId);
    insertImportEdge(db, featFileId, './utils', null);
  });

  it('should return all import edges when no filter', () => {
    const result = handler(db, { kind: 'import' });
    expect(result.edges.length).toBe(2);
  });

  it('should include source_branch on each edge', () => {
    const result = handler(db, { kind: 'import' });
    result.edges.forEach((e) => expect(typeof e.source_branch).toBe('string'));
  });

  it('should filter import edges by source_id', () => {
    const result = handler(db, { kind: 'import', source_id: mainFileId });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('main');
  });

  it('should filter import edges by branch', () => {
    const result = handler(db, { kind: 'import', branch: 'feat' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('feat');
  });

  it('should return empty edges when branch does not match', () => {
    const result = handler(db, { kind: 'import', branch: 'nonexistent' });
    expect(result.edges).toEqual([]);
  });

  it('should use raw_import when resolved_id is null', () => {
    const result = handler(db, { kind: 'import', branch: 'feat' });
    expect(result.edges[0].target_name).toBe('./utils');
  });
});
