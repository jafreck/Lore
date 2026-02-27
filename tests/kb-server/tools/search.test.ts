import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type SearchArgs, type SearchResult } from '../../../src/kb-server/tools/search.js';

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
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, kind, content=symbols, content_rowid=id);
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, 'typescript');
  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function',
): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    )
    .run(fileId, name, kind);
  const rowid = result.lastInsertRowid as number;
  db.prepare('INSERT INTO symbols_fts(rowid, name, kind) VALUES (?, ?, ?)').run(rowid, name, kind);
  return rowid;
}

// ─── handler (structural mode) ────────────────────────────────────────────────

describe('search handler – structural mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, featId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
  });

  it('should return results matching query in structural mode', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    expect(result.mode_used).toBe('structural');
    expect(result.results.length).toBeGreaterThan(0);
    result.results.forEach((r) => expect(r.name).toBe('parseConfig'));
  });

  it('should default to structural mode when mode is omitted', async () => {
    const result = await handler(db, { query: 'renderPage' });
    expect(result.mode_used).toBe('structural');
  });

  it('should include branch field on each result', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    result.results.forEach((r) => expect(typeof r.branch).toBe('string'));
  });

  it('should filter results by branch when branch is provided', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural', branch: 'main' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].branch).toBe('main');
  });

  it('should return empty results when branch does not match', async () => {
    const result = await handler(db, {
      query: 'parseConfig',
      mode: 'structural',
      branch: 'nonexistent',
    });
    expect(result.results).toEqual([]);
  });

  it('should respect the limit parameter', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural', limit: 1 });
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it('should return empty results for an unmatched query', async () => {
    const result = await handler(db, { query: 'zzz_no_match_zzz', mode: 'structural' });
    expect(result.results).toEqual([]);
  });
});

// ─── handler (semantic / fused fallback) ──────────────────────────────────────

describe('search handler – semantic/fused fallback without embedder', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/index.ts', 'main');
    insertSymbol(db, mainId, 'myFunc');
  });

  it('should fall back to structural when mode=semantic and no embedder provided', async () => {
    const result = await handler(db, { query: 'myFunc', mode: 'semantic' });
    expect(result.mode_used).toBe('structural (no query-time embedder)');
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('should fall back to structural when mode=fused and no embedder provided', async () => {
    const result = await handler(db, { query: 'myFunc', mode: 'fused' });
    expect(result.mode_used).toBe('structural (no query-time embedder)');
  });
});
