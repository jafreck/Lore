import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler } from '../../../src/lore-server/tools/coverage.js';

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
    CREATE TABLE coverage_lines (
      run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
      file_path     TEXT    NOT NULL,
      line_number   INTEGER NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, file_path, line_number)
    );
  `);
  return db;
}

describe('coverage handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns symbol-level coverage with uncovered lines and staleness fields', () => {
    const fileId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('src/main.ts', 'main', 'typescript').lastInsertRowid as number;
    const symbolId = db
      .prepare(
        'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
      )
      .run(fileId, 'render', 'function', 1, 3).lastInsertRowid as number;
    expect(symbolId).toBeGreaterThan(0);

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
    ).run(runId, 'src/main.ts', 3, 2);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 1, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 2, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 3, 1);

    const result = handler(db, { path: 'src/main.ts' });
    expect(result.coverage_commit).toBe('abc123');
    expect(result.current_commit).toBe('def456');
    expect(result.commits_behind).toBe(1);
    expect(result.stale).toBe(true);
    expect(result.symbols.length).toBe(1);
    expect(result.symbols[0]?.coverage_percent).toBeCloseTo(66.666, 2);
    expect(result.symbols[0]?.uncovered_lines).toEqual([2]);
  });

  it('returns null coverage metadata when no coverage run exists', () => {
    const result = handler(db, {});
    expect(result.coverage_available).toBe(false);
    expect(result.coverage_commit).toBeNull();
    expect(result.symbols).toEqual([]);
  });

  it('should return empty symbols when symbol_name has no matches', () => {
    const fileId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('src/main.ts', 'main', 'typescript').lastInsertRowid as number;
    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'render', 'function', 1, 3);
    db.prepare(
      'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
    ).run('abc123', 'coverage/lcov.info', 'lcov', 150);

    const result = handler(db, { symbol_name: 'doesNotExist' });
    expect(result.coverage_available).toBe(true);
    expect(result.symbols).toEqual([]);
  });

  it('should clamp limit to at least one symbol', () => {
    const fileId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('src/main.ts', 'main', 'typescript').lastInsertRowid as number;
    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'render', 'function', 1, 3);
    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'paint', 'function', 4, 6);
    const runId = db
      .prepare(
        'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
      )
      .run('abc123', 'coverage/lcov.info', 'lcov', 150).lastInsertRowid as number;
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 1, 1);

    const result = handler(db, { limit: 0 });
    expect(result.symbols).toHaveLength(1);
  });
});
