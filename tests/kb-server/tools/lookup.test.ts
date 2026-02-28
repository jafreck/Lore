import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type LookupArgs } from '../../../src/kb-server/tools/lookup.js';

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
      symbol_id    INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
      line_count   INTEGER NOT NULL,
      param_count  INTEGER NOT NULL,
      cyclomatic   INTEGER NOT NULL,
      max_nesting  INTEGER NOT NULL
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

function insertSymbolMetrics(db: Database.Database, symbolId: number): void {
  db.prepare(
    'INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (?, ?, ?, ?, ?)',
  ).run(symbolId, 20, 3, 8, 4);
}

// ─── handler (kind=symbol) ────────────────────────────────────────────────────

describe('lookup handler – kind=symbol', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    const parseConfigId = insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, featId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
    insertSymbolMetrics(db, parseConfigId);
  });

  it('should return matching symbols by name', () => {
    const result = handler(db, { kind: 'symbol', query: 'parseConfig' });
    expect(result.results.length).toBe(2);
    expect(result.results[0]).toHaveProperty('line_count');
    expect(result.results[0]).toHaveProperty('param_count');
    expect(result.results[0]).toHaveProperty('cyclomatic');
    expect(result.results[0]).toHaveProperty('max_nesting');
  });

  it('should filter symbols by branch when branch is provided', () => {
    const result = handler(db, { kind: 'symbol', query: 'parseConfig', branch: 'main' });
    expect(result.results.length).toBe(1);
  });

  it('should list symbols when query is empty and no branch filter', () => {
    const result = handler(db, { kind: 'symbol', query: '' });
    expect(result.results.length).toBe(3);
  });

  it('should list symbols filtered by branch when query is empty', () => {
    const result = handler(db, { kind: 'symbol', query: '', branch: 'main' });
    expect(result.results.length).toBe(2);
  });

  it('should return empty array when no symbols match the query', () => {
    const result = handler(db, { kind: 'symbol', query: 'nonexistent' });
    expect(result.results).toEqual([]);
  });

  it('should return empty array when branch has no matching symbol', () => {
    const result = handler(db, { kind: 'symbol', query: 'parseConfig', branch: 'nonexistent' });
    expect(result.results).toEqual([]);
  });
});

// ─── handler (kind=file) ──────────────────────────────────────────────────────

describe('lookup handler – kind=file', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, 'src/main.ts', 'main');
    insertFile(db, 'src/main.ts', 'feat');
    insertFile(db, 'src/other.ts', 'main');
  });

  it('should return a file row when path matches', () => {
    const result = handler(db, { kind: 'file', query: 'src/main.ts' });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).not.toHaveProperty('cyclomatic');
  });

  it('should filter file by branch when branch is provided', () => {
    const result = handler(db, { kind: 'file', query: 'src/main.ts', branch: 'feat' });
    expect(result.results.length).toBe(1);
    expect((result.results[0] as { branch: string }).branch).toBe('feat');
  });

  it('should return empty array when file path not found', () => {
    const result = handler(db, { kind: 'file', query: 'nonexistent.ts' });
    expect(result.results).toEqual([]);
  });

  it('should return empty array when branch does not match', () => {
    const result = handler(db, { kind: 'file', query: 'src/main.ts', branch: 'nonexistent' });
    expect(result.results).toEqual([]);
  });

  it('should list files when query is empty', () => {
    const result = handler(db, { kind: 'file', query: '' });
    expect(result.results.length).toBe(3);
  });

  it('should list files filtered by branch when query is empty', () => {
    const result = handler(db, { kind: 'file', query: '', branch: 'main' });
    expect(result.results.length).toBe(2);
  });
});
