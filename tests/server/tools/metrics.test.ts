import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type MetricsResult } from '../../../src/server/tools/metrics.js';

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
    CREATE TABLE symbol_metrics (
      symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
      line_count  INTEGER NOT NULL,
      param_count INTEGER NOT NULL,
      cyclomatic  INTEGER NOT NULL,
      max_nesting INTEGER NOT NULL
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

function insertSymbolWithMetrics(
  db: Database.Database,
  fileId: number,
  name: string,
  cyclomatic: number,
  lineCount = 10,
  paramCount = 0,
  maxNesting = 0,
): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, ?)',
    )
    .run(fileId, name, 'function', lineCount);
  const symId = result.lastInsertRowid as number;
  db.prepare(
    'INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (?, ?, ?, ?, ?)',
  ).run(symId, lineCount, paramCount, cyclomatic, maxNesting);
  return symId;
}

// ─── complexity ranking ───────────────────────────────────────────────────────

describe('metrics handler — complexity ranking', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    insertSymbolWithMetrics(db, fileId, 'complexFunc', 12, 50, 4, 5);
    insertSymbolWithMetrics(db, fileId, 'simpleFunc', 4, 20, 2, 2);
    insertSymbolWithMetrics(db, fileId, 'trivialFunc', 1, 5, 0, 0);
  });

  it('should return complexity-ranked symbols', () => {
    const result = handler(db, {});
    expect(result.symbols).toBeDefined();
    expect(result.symbols.length).toBe(3);
    expect(result.symbols[0]!.name).toBe('complexFunc');
    expect(result.symbols[0]!.cyclomatic).toBe(12);
  });

  it('should respect min_cyclomatic filter', () => {
    const result = handler(db, { min_cyclomatic: 5 });
    expect(result.symbols.length).toBe(1);
    expect(result.symbols[0]!.name).toBe('complexFunc');
  });

  it('should respect limit parameter', () => {
    const result = handler(db, { limit: 2 });
    expect(result.symbols.length).toBe(2);
  });

  it('should clamp limit to maximum of 200', () => {
    const result = handler(db, { limit: 500 });
    expect(result.symbols.length).toBe(3);
  });

  it('should default limit to 20 and min_cyclomatic to 0', () => {
    const result = handler(db, {});
    expect(result.symbols.length).toBe(3);
  });

  it('should return empty array when no metrics exist', () => {
    const emptyDb = createTestDb();
    const result = handler(emptyDb, {});
    expect(result.symbols).toEqual([]);
    emptyDb.close();
  });
});