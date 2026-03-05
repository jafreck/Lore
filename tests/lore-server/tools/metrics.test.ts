import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type MetricsResult } from '../../../src/lore-server/tools/metrics.js';

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
    CREATE TABLE commits (
      sha           TEXT PRIMARY KEY,
      author        TEXT    NOT NULL,
      author_email  TEXT    NOT NULL,
      timestamp     INTEGER NOT NULL,
      message       TEXT    NOT NULL,
      parents       TEXT    NOT NULL
    );
    CREATE TABLE coverage_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_sha    TEXT    NOT NULL,
      source_path   TEXT    NOT NULL,
      format        TEXT    NOT NULL,
      ingested_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      source_mtime  INTEGER
    );
    CREATE TABLE coverage_files (
      run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
      file_path     TEXT    NOT NULL,
      lines_found   INTEGER NOT NULL DEFAULT 0,
      lines_hit     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, file_path)
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

// ─── handler ──────────────────────────────────────────────────────────────────

describe('metrics handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertFile(db, 'src/utils.ts', 'main');
    insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
    insertSymbol(db, featId, 'featFunc');
    db.prepare('INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)').run(
      mainId,
      './utils',
    );
    db.prepare('INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)').run(
      featId,
      './shared',
    );
    db.prepare(
      'INSERT INTO commits (sha, author, author_email, timestamp, message, parents) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('abc123', 'A', 'a@example.com', 100, 'old', '');
    db.prepare(
      'INSERT INTO commits (sha, author, author_email, timestamp, message, parents) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('def456', 'A', 'a@example.com', 200, 'new', 'abc123');
    const runId = db
      .prepare(
        'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
      )
      .run('abc123', 'coverage/lcov.info', 'lcov', 150).lastInsertRowid as number;
    db.prepare(
      'INSERT INTO coverage_files (run_id, file_path, lines_found, lines_hit) VALUES (?, ?, ?, ?)',
    ).run(runId, 'src/main.ts', 10, 8);
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
    expect(result.coverage_available).toBe(false);
    expect(result.global_coverage_percent).toBeNull();
    expect(result.per_branch).toEqual([]);
    emptyDb.close();
  });

  it('should include global coverage and staleness metadata fields', () => {
    const result = handler(db, {});
    expect(result.coverage_available).toBe(true);
    expect(result.global_coverage_percent).toBe(80);
    expect(result.coverage_commit).toBe('abc123');
    expect(result.current_commit).toBe('def456');
    expect(result.commits_behind).toBe(1);
    expect(result.stale).toBe(true);
  });
});
