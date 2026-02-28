import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openReadOnly,
  getFileById,
  getFileByPath,
  listFiles,
  getSymbolsByName,
  listSymbols,
  getSymbolById,
  type FileRow,
  type SymbolRow,
} from '../../src/kb-server/db.js';

// Helper: create an in-memory DB with the minimal schema needed for tests.
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT '',
      language    TEXT    NOT NULL,
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      last_hash   TEXT,
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      signature   TEXT,
      doc_comment TEXT
    );
  `);
  return db;
}

function insertFile(
  db: Database.Database,
  path: string,
  branch: string,
  language = 'typescript'
): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, language);
  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function'
): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)'
    )
    .run(fileId, name, kind);
  return result.lastInsertRowid as number;
}

// ─── openReadOnly ──────────────────────────────────────────────────────────────

describe('openReadOnly', () => {
  it('should open the database in read-only mode with foreign keys enabled', () => {
    const dbPath = path.join(os.tmpdir(), `lore-db-test-${Date.now()}.sqlite`);
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE files (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT    NOT NULL,
        branch      TEXT    NOT NULL DEFAULT '',
        language    TEXT    NOT NULL,
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        last_hash   TEXT,
        indexed_at  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(path, branch)
      );
    `);
    seedDb.close();

    const db = openReadOnly(dbPath);
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    expect(foreignKeys).toBe(1);
    expect(() => db.prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)').run('a.ts', 'main', 'typescript')).toThrow();

    db.close();
    fs.rmSync(dbPath);
  });
});

// ─── FileRow interface ────────────────────────────────────────────────────────

describe('FileRow interface', () => {
  it('should include a branch field', () => {
    const db = createTestDb();
    const id = insertFile(db, 'src/foo.ts', 'main');
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow;
    expect(row).toHaveProperty('branch');
    expect(typeof row.branch).toBe('string');
    db.close();
  });
});

// ─── getFileById ──────────────────────────────────────────────────────────────

describe('getFileById', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertFile(db, 'src/index.ts', 'main');
  });

  it('should return the file row when id exists', () => {
    const row = getFileById(db, fileId);
    expect(row).toBeDefined();
    expect(row!.path).toBe('src/index.ts');
    expect(row!.branch).toBe('main');
  });

  it('should return undefined when id does not exist', () => {
    expect(getFileById(db, 9999)).toBeUndefined();
  });

  it('should filter by branch when branch is provided and matches', () => {
    const row = getFileById(db, fileId, 'main');
    expect(row).toBeDefined();
    expect(row!.branch).toBe('main');
  });

  it('should return undefined when branch does not match', () => {
    expect(getFileById(db, fileId, 'other-branch')).toBeUndefined();
  });

  it('should return the row regardless of branch when branch is omitted', () => {
    insertFile(db, 'src/other.ts', 'feat');
    const row = getFileById(db, fileId);
    expect(row).toBeDefined();
  });
});

// ─── getFileByPath ────────────────────────────────────────────────────────────

describe('getFileByPath', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, 'src/utils.ts', 'main');
    insertFile(db, 'src/utils.ts', 'feat');
  });

  it('should return a row when path matches and no branch filter', () => {
    // Without branch there may be multiple rows; SQLite returns first match.
    const row = getFileByPath(db, 'src/utils.ts');
    expect(row).toBeDefined();
    expect(row!.path).toBe('src/utils.ts');
  });

  it('should filter by branch when provided', () => {
    const row = getFileByPath(db, 'src/utils.ts', 'feat');
    expect(row).toBeDefined();
    expect(row!.branch).toBe('feat');
  });

  it('should return undefined when path does not exist', () => {
    expect(getFileByPath(db, 'nonexistent.ts')).toBeUndefined();
  });

  it('should return undefined when branch does not match', () => {
    expect(getFileByPath(db, 'src/utils.ts', 'nonexistent-branch')).toBeUndefined();
  });
});

// ─── listFiles ────────────────────────────────────────────────────────────────

describe('listFiles', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, 'a.ts', 'main');
    insertFile(db, 'b.ts', 'main');
    insertFile(db, 'c.ts', 'feat');
  });

  it('should return all files when no branch filter', () => {
    const rows = listFiles(db, 100);
    expect(rows.length).toBe(3);
  });

  it('should filter by branch when branch is provided', () => {
    const rows = listFiles(db, 100, 'main');
    expect(rows.length).toBe(2);
    rows.forEach((r) => expect(r.branch).toBe('main'));
  });

  it('should respect the limit parameter', () => {
    const rows = listFiles(db, 1);
    expect(rows.length).toBe(1);
  });

  it('should respect the limit parameter when filtering by branch', () => {
    const rows = listFiles(db, 1, 'main');
    expect(rows.length).toBe(1);
  });

  it('should return an empty array when branch has no files', () => {
    const rows = listFiles(db, 100, 'nonexistent');
    expect(rows).toEqual([]);
  });
});

// ─── getSymbolsByName ─────────────────────────────────────────────────────────

describe('getSymbolsByName', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, featId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
  });

  it('should return symbols matching name across all branches when no branch filter', () => {
    const rows = getSymbolsByName(db, 'parseConfig');
    expect(rows.length).toBe(2);
  });

  it('should be case-insensitive', () => {
    const rows = getSymbolsByName(db, 'PARSECONFIG');
    expect(rows.length).toBe(2);
  });

  it('should filter by branch when provided', () => {
    const rows = getSymbolsByName(db, 'parseConfig', 'main');
    expect(rows.length).toBe(1);
  });

  it('should return empty array when name does not match', () => {
    expect(getSymbolsByName(db, 'nonexistent')).toEqual([]);
  });

  it('should return empty array when branch has no matching symbol', () => {
    expect(getSymbolsByName(db, 'parseConfig', 'nonexistent-branch')).toEqual([]);
  });
});

// ─── listSymbols ──────────────────────────────────────────────────────────────

describe('listSymbols', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertSymbol(db, mainId, 'foo');
    insertSymbol(db, mainId, 'bar');
    insertSymbol(db, featId, 'baz');
  });

  it('should return all symbols when no branch filter', () => {
    const rows = listSymbols(db);
    expect(rows.length).toBe(3);
  });

  it('should filter by branch when provided', () => {
    const rows = listSymbols(db, 100, 'main');
    expect(rows.length).toBe(2);
  });

  it('should respect the default limit of 100', () => {
    const rows = listSymbols(db);
    expect(rows.length).toBeLessThanOrEqual(100);
  });

  it('should respect a custom limit', () => {
    const rows = listSymbols(db, 1);
    expect(rows.length).toBe(1);
  });

  it('should return empty array when branch has no symbols', () => {
    expect(listSymbols(db, 100, 'nonexistent')).toEqual([]);
  });
});

// ─── getSymbolById ────────────────────────────────────────────────────────────

describe('getSymbolById', () => {
  let db: Database.Database;
  let symbolId: number;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertFile(db, 'src/a.ts', 'main');
    symbolId = insertSymbol(db, fileId, 'myFunc');
  });

  it('should return the symbol row when id exists', () => {
    const row = getSymbolById(db, symbolId);
    expect(row).toBeDefined();
    expect(row!.name).toBe('myFunc');
  });

  it('should return undefined when id does not exist', () => {
    expect(getSymbolById(db, 9999)).toBeUndefined();
  });
});
