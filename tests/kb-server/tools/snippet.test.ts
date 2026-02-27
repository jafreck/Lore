import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type SnippetArgs } from '../../../src/kb-server/tools/snippet.js';

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
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string): void {
  db.prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)').run(
    path,
    branch,
    'typescript',
  );
}

// ─── handler ──────────────────────────────────────────────────────────────────

describe('snippet handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should throw when path is not found in index', () => {
    expect(() => handler(db, { path: 'nonexistent.ts' })).toThrow(
      'File not found in index: nonexistent.ts',
    );
  });

  it('should throw when path exists in index but branch does not match', () => {
    insertFile(db, 'src/main.ts', 'main');
    expect(() => handler(db, { path: 'src/main.ts', branch: 'nonexistent' })).toThrow(
      'File not found in index: src/main.ts',
    );
  });

  it('should read file contents when path is found in index', () => {
    // Use the actual test file path since it is on disk.
    const realPath = new URL(import.meta.url).pathname;
    insertFile(db, realPath, 'main');
    const result = handler(db, { path: realPath });
    expect(result.path).toBe(realPath);
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('should respect start_line and end_line', () => {
    const realPath = new URL(import.meta.url).pathname;
    insertFile(db, realPath, 'main');
    const full = handler(db, { path: realPath });
    const sliced = handler(db, { path: realPath, start_line: 1, end_line: 3 });
    expect(sliced.start_line).toBe(1);
    expect(sliced.end_line).toBe(3);
    // The sliced text should be shorter than the full file.
    expect(sliced.text.length).toBeLessThan(full.text.length);
  });

  it('should filter by branch when branch is provided', () => {
    const realPath = new URL(import.meta.url).pathname;
    insertFile(db, realPath, 'main');
    insertFile(db, realPath, 'feat');
    // Both branches have the file, but filtering by 'feat' should still return content.
    const result = handler(db, { path: realPath, branch: 'feat' });
    expect(result.path).toBe(realPath);
  });
});
