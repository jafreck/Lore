import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef } from '../../../src/kb-server/tools/routes.js';

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
    CREATE TABLE api_routes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      method       TEXT    NOT NULL,
      path         TEXT    NOT NULL,
      handler_id   INTEGER,
      handler_name TEXT    NOT NULL,
      framework    TEXT    NOT NULL,
      line         INTEGER NOT NULL,
      middleware   TEXT
    );
  `);
  return db;
}

function seedRoutes(db: Database.Database): void {
  const apiFileId = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run('src/api.ts', 'main', 'typescript').lastInsertRowid as number;
  const userFileId = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run('src/users.py', 'main', 'python').lastInsertRowid as number;

  db.prepare(
    `INSERT INTO api_routes (file_id, method, path, handler_name, framework, line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(apiFileId, 'GET', '/api/health', 'healthHandler', 'express', 12);
  db.prepare(
    `INSERT INTO api_routes (file_id, method, path, handler_name, framework, line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(apiFileId, 'POST', '/api/users', 'createUser', 'express', 20);
  db.prepare(
    `INSERT INTO api_routes (file_id, method, path, handler_name, framework, line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userFileId, 'GET', '/v1/users', 'list_users', 'fastapi', 8);
}

describe('routes toolDef', () => {
  it('should expose the lore_routes tool name', () => {
    expect(toolDef.name).toBe('lore_routes');
  });
});

describe('routes handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedRoutes(db);
  });

  it('returns method/path/handler/file/line/framework for unfiltered queries', () => {
    const result = handler(db, {});
    expect(result.results.length).toBe(3);
    expect(result.results[0]).toHaveProperty('method');
    expect(result.results[0]).toHaveProperty('path');
    expect(result.results[0]).toHaveProperty('handler');
    expect(result.results[0]).toHaveProperty('file');
    expect(result.results[0]).toHaveProperty('line');
    expect(result.results[0]).toHaveProperty('framework');
  });

  it('filters by method', () => {
    const result = handler(db, { method: 'POST' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].method).toBe('POST');
    expect(result.results[0].path).toBe('/api/users');
  });

  it('filters by path_prefix', () => {
    const result = handler(db, { path_prefix: '/api' });
    expect(result.results.length).toBe(2);
    expect(result.results.every((row) => row.path.startsWith('/api'))).toBe(true);
  });

  it('filters by framework', () => {
    const result = handler(db, { framework: 'fastapi' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].framework).toBe('fastapi');
    expect(result.results[0].handler).toBe('list_users');
  });
});
