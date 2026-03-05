import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { handler, type WritebackArgs } from '../../../src/lore-server/tools/writeback.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
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
    CREATE TABLE symbol_summaries (
      symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
      summary     TEXT    NOT NULL,
      model       TEXT    NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT 0
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

describe('writeback handler', () => {
  let dbPath: string;
  let setupDb: Database.Database;
  let symbolId: number;
  let mainFileId: number;

  beforeEach(() => {
    // Each test gets a unique temporary database file.
    dbPath = join(tmpdir(), `writeback-test-${randomBytes(8).toString('hex')}.db`);
    setupDb = createTestDb(dbPath);
    mainFileId = insertFile(setupDb, 'src/main.ts', 'main');
    symbolId = insertSymbol(setupDb, mainFileId, 'myFunc');
    setupDb.close();
  });

  it('should insert a summary and return ok=true', () => {
    const result = handler(dbPath, { symbol_id: symbolId, summary: 'Does stuff', model: 'gpt-4' });
    expect(result.ok).toBe(true);
    expect(result.symbol_id).toBe(symbolId);
  });

  it('should persist the summary to the database', () => {
    handler(dbPath, { symbol_id: symbolId, summary: 'My summary', model: 'gpt-4' });
    const db = new Database(dbPath);
    const row = db
      .prepare('SELECT summary FROM symbol_summaries WHERE symbol_id = ?')
      .get(symbolId) as { summary: string } | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row!.summary).toBe('My summary');
  });

  it('should replace (upsert) an existing summary', () => {
    handler(dbPath, { symbol_id: symbolId, summary: 'First', model: 'gpt-4' });
    handler(dbPath, { symbol_id: symbolId, summary: 'Second', model: 'gpt-4' });
    const db = new Database(dbPath);
    const rows = db
      .prepare('SELECT summary FROM symbol_summaries WHERE symbol_id = ?')
      .all(symbolId) as Array<{ summary: string }>;
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].summary).toBe('Second');
  });

  it('should succeed when branch matches the symbol branch', () => {
    const result = handler(dbPath, {
      symbol_id: symbolId,
      summary: 'Branched summary',
      model: 'gpt-4',
      branch: 'main',
    });
    expect(result.ok).toBe(true);
  });

  it('should throw when branch does not match the symbol branch', () => {
    expect(() =>
      handler(dbPath, {
        symbol_id: symbolId,
        summary: 'Should fail',
        model: 'gpt-4',
        branch: 'nonexistent',
      }),
    ).toThrow(`Symbol ${symbolId} not found in branch 'nonexistent'`);
  });

  it('should throw when symbol_id does not exist at all', () => {
    expect(() =>
      handler(dbPath, { symbol_id: 9999, summary: 'No symbol', model: 'gpt-4' }),
    ).toThrow();
  });
});
