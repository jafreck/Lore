import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type AnnotationsArgs } from '../../../src/lore-server/tools/annotations.js';

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
    CREATE TABLE annotations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL,
      line        INTEGER NOT NULL,
      text        TEXT    NOT NULL,
      symbol_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      author      TEXT,
      created_at  INTEGER
    );
  `);
  return db;
}

describe('annotations handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const fileId = db.prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)').run(
      'src/main.ts',
      'main',
      'typescript',
    ).lastInsertRowid as number;
    const symbolId = db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    ).run(fileId, 'parseConfig', 'function').lastInsertRowid as number;
    db.prepare(
      'INSERT INTO annotations (file_id, kind, line, text, symbol_id) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'TODO', 4, 'TODO: parse env vars', symbolId);
  });

  it('should return annotation query results with file and optional symbol context', () => {
    const result = handler(db, { kind: 'TODO' });
    expect(result.results.length).toBe(1);
    expect(result.results[0]).toMatchObject({
      file_path: 'src/main.ts',
      line: 4,
      kind: 'TODO',
      text: 'TODO: parse env vars',
      symbol_name: 'parseConfig',
      symbol_kind: 'function',
    });
  });

  it('should return empty results when filters do not match', () => {
    const args: AnnotationsArgs = { kind: 'TODO', path: 'src/missing.ts', limit: 5 };
    const result = handler(db, args);
    expect(result.results).toEqual([]);
  });

  it('should apply a default limit of 20 when limit is omitted', () => {
    const insert = db.prepare(
      'INSERT INTO annotations (file_id, kind, line, text, symbol_id) VALUES (?, ?, ?, ?, ?)',
    );
    const fileId = db.prepare('SELECT id FROM files WHERE path = ?').get('src/main.ts') as { id: number };
    for (let i = 0; i < 25; i += 1) {
      insert.run(fileId.id, 'TODO', 10 + i, `TODO item ${i}`, null);
    }

    const result = handler(db, { kind: 'TODO' });
    expect(result.results.length).toBe(20);
  });
});
