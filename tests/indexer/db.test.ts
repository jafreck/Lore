import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, setKbMeta, getKbMeta } from '../../src/indexer/db.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('openDb', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `lore-test-${Date.now()}.db`);
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('should create a database file at the given path', () => {
    const db = openDb(dbPath);
    db.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('should create the commits table', () => {
    const db = openDb(dbPath);
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='commits'`)
      .get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe('commits');
  });

  it('should create the commit_files table', () => {
    const db = openDb(dbPath);
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='commit_files'`)
      .get() as { name: string } | undefined;
    db.close();
    expect(row?.name).toBe('commit_files');
  });

  it('should allow inserting a commit into the commits table', () => {
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('abc123', 'Alice', 'alice@example.com', 1700000000, 'Initial commit', '[]');

    const row = db.prepare('SELECT * FROM commits WHERE sha = ?').get('abc123') as
      | { sha: string; author: string; parents: string }
      | undefined;
    db.close();
    expect(row?.sha).toBe('abc123');
    expect(row?.author).toBe('Alice');
    expect(row?.parents).toBe('[]');
  });

  it('should allow inserting a commit_files row', () => {
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('abc123', 'Alice', 'alice@example.com', 1700000000, 'Initial commit', '[]');

    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('abc123', 'src/foo.ts', 'added', 10, 0);

    const row = db
      .prepare('SELECT * FROM commit_files WHERE commit_sha = ?')
      .get('abc123') as { file_path: string; insertions: number } | undefined;
    db.close();
    expect(row?.file_path).toBe('src/foo.ts');
    expect(row?.insertions).toBe(10);
  });

  it('should enforce INSERT OR IGNORE idempotency on commits (sha PRIMARY KEY)', () => {
    const db = openDb(dbPath);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('abc123', 'Alice', 'alice@example.com', 1700000000, 'First', '[]');
    insert.run('abc123', 'Bob', 'bob@example.com', 1700000001, 'Second', '[]');

    const rows = db.prepare('SELECT * FROM commits WHERE sha = ?').all('abc123') as unknown[];
    db.close();
    expect(rows.length).toBe(1);
  });

  it('should allow NULL insertions/deletions in commit_files (binary files)', () => {
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('bin1', 'Alice', 'alice@example.com', 1700000000, 'Binary', '[]');

    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('bin1', 'image.png', 'modified', null, null);

    const row = db
      .prepare('SELECT * FROM commit_files WHERE commit_sha = ?')
      .get('bin1') as { insertions: null; deletions: null } | undefined;
    db.close();
    expect(row?.insertions).toBeNull();
    expect(row?.deletions).toBeNull();
  });

  it('should be idempotent when openDb is called multiple times (CREATE IF NOT EXISTS)', () => {
    const db1 = openDb(dbPath);
    db1.close();
    // Second open should not throw
    const db2 = openDb(dbPath);
    db2.close();
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

describe('setKbMeta / getKbMeta', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `lore-meta-test-${Date.now()}.db`);
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('should write and read a key-value pair', () => {
    const db = openDb(dbPath);
    setKbMeta(db, 'schema_version', '1');
    const value = getKbMeta(db, 'schema_version');
    db.close();
    expect(value).toBe('1');
  });

  it('should return undefined for a missing key', () => {
    const db = openDb(dbPath);
    const value = getKbMeta(db, 'nonexistent');
    db.close();
    expect(value).toBeUndefined();
  });

  it('should overwrite an existing key', () => {
    const db = openDb(dbPath);
    setKbMeta(db, 'key', 'v1');
    setKbMeta(db, 'key', 'v2');
    const value = getKbMeta(db, 'key');
    db.close();
    expect(value).toBe('v2');
  });
});
