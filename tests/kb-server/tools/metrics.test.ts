import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type MetricsResult } from '../../../src/kb-server/tools/metrics.js';

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
    CREATE TABLE file_imports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      raw_import  TEXT    NOT NULL,
      resolved_id INTEGER REFERENCES files(id)
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

function insertSymbolMetrics(db: Database.Database, symbolId: number, cyclomatic: number): void {
  db.prepare(
    'INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (?, ?, ?, ?, ?)',
  ).run(symbolId, 14, 2, cyclomatic, 3);
}

// ─── handler ──────────────────────────────────────────────────────────────────

describe('metrics handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertFile(db, 'src/utils.ts', 'main');
    const parseConfigId = insertSymbol(db, mainId, 'parseConfig');
    const renderPageId = insertSymbol(db, mainId, 'renderPage');
    const featFuncId = insertSymbol(db, featId, 'featFunc');
    insertSymbolMetrics(db, parseConfigId, 3);
    insertSymbolMetrics(db, renderPageId, 8);
    insertSymbolMetrics(db, featFuncId, 5);
    db.prepare('INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)').run(
      mainId,
      './utils',
    );
    db.prepare('INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)').run(
      featId,
      './shared',
    );
  });

  it('should return total symbol count', () => {
    const result = handler(db, {});
    expect(result.symbol_count).toBe(3);
  });

  it('should return total file count', () => {
    const result = handler(db, {});
    expect(result.file_count).toBe(3);
  });

  it('should return total import edge count', () => {
    const result = handler(db, {});
    expect(result.import_edge_count).toBe(2);
  });

  it('should include per_branch array in result', () => {
    const result = handler(db, {});
    expect(Array.isArray(result.per_branch)).toBe(true);
    expect(result.per_branch.length).toBe(2);
  });

  it('should include branch, file_count and symbol_count in each per_branch entry', () => {
    const result = handler(db, {});
    result.per_branch.forEach((entry) => {
      expect(typeof entry.branch).toBe('string');
      expect(typeof entry.file_count).toBe('number');
      expect(typeof entry.symbol_count).toBe('number');
    });
  });

  it('should correctly count files and symbols per branch', () => {
    const result = handler(db, {});
    const mainEntry = result.per_branch.find((e) => e.branch === 'main');
    const featEntry = result.per_branch.find((e) => e.branch === 'feat');
    expect(mainEntry).toBeDefined();
    expect(mainEntry!.file_count).toBe(2);
    expect(mainEntry!.symbol_count).toBe(2);
    expect(featEntry).toBeDefined();
    expect(featEntry!.file_count).toBe(1);
    expect(featEntry!.symbol_count).toBe(1);
  });

  it('should return zeros when database is empty', () => {
    const emptyDb = createTestDb();
    const result = handler(emptyDb, {});
    expect(result.symbol_count).toBe(0);
    expect(result.file_count).toBe(0);
    expect(result.import_edge_count).toBe(0);
    expect(result.per_branch).toEqual([]);
    emptyDb.close();
  });

  it('should return complexity-ranked symbols ordered by cyclomatic desc', () => {
    const result = handler(db, { mode: 'complexity' });
    expect('symbols' in result).toBe(true);
    if ('symbols' in result) {
      expect(result.symbols.map((row) => row.cyclomatic)).toEqual([8, 5, 3]);
    }
  });

  it('should apply min_cyclomatic and limit in complexity mode', () => {
    const result = handler(db, { mode: 'complexity', min_cyclomatic: 4, limit: 1 });
    expect('symbols' in result).toBe(true);
    if ('symbols' in result) {
      expect(result.symbols.length).toBe(1);
      expect(result.symbols[0].cyclomatic).toBe(8);
      expect(result.symbols[0].line_count).toBe(14);
      expect(result.symbols[0].param_count).toBe(2);
      expect(result.symbols[0].max_nesting).toBe(3);
    }
  });

  it('should clamp negative min_cyclomatic and low limit values in complexity mode', () => {
    const result = handler(db, { mode: 'complexity', min_cyclomatic: -10, limit: 0 });
    expect('symbols' in result).toBe(true);
    if ('symbols' in result) {
      expect(result.symbols.length).toBe(1);
      expect(result.symbols[0].cyclomatic).toBe(8);
    }
  });

  it('should cap complexity mode limit at 200', () => {
    const result = handler(db, { mode: 'complexity', limit: 999 });
    expect('symbols' in result).toBe(true);
    if ('symbols' in result) {
      expect(result.symbols.length).toBe(3);
    }
  });
});
