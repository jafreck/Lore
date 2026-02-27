import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getCommitBySha,
  listRecentCommits,
  listCommitsByFile,
  listCommitsByAuthor,
  listCommitFiles,
  type CommitRow,
  type CommitFileRow,
} from '../../src/kb-server/db.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS commits (
      sha          TEXT    PRIMARY KEY,
      author       TEXT    NOT NULL,
      author_email TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message      TEXT    NOT NULL,
      parents      TEXT    NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS commit_files (
      commit_sha  TEXT    NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
      file_path   TEXT    NOT NULL,
      change_type TEXT    NOT NULL,
      insertions  INTEGER,
      deletions   INTEGER,
      PRIMARY KEY (commit_sha, file_path)
    );
  `);
  return db;
}

function insertCommit(
  db: Database.Database,
  sha: string,
  author: string,
  email: string,
  timestamp: number,
  message = 'msg',
  parents = '[]',
) {
  db.prepare(
    `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sha, author, email, timestamp, message, parents);
}

function insertCommitFile(
  db: Database.Database,
  commitSha: string,
  filePath: string,
  changeType = 'modified',
  insertions: number | null = 5,
  deletions: number | null = 2,
) {
  db.prepare(
    `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(commitSha, filePath, changeType, insertions, deletions);
}

// ─── getCommitBySha ───────────────────────────────────────────────────────────

describe('getCommitBySha', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'abc123def456', 'Alice', 'alice@example.com', 1700000000);
  });

  it('should return the commit for an exact SHA match', () => {
    const row = getCommitBySha(db, 'abc123def456');
    expect(row?.sha).toBe('abc123def456');
    expect(row?.author).toBe('Alice');
  });

  it('should return the commit for a prefix SHA match', () => {
    const row = getCommitBySha(db, 'abc123');
    expect(row?.sha).toBe('abc123def456');
  });

  it('should return undefined for a non-matching SHA', () => {
    const row = getCommitBySha(db, 'zzz999');
    expect(row).toBeUndefined();
  });

  it('should return undefined when the database has no commits', () => {
    const emptyDb = createTestDb();
    const row = getCommitBySha(emptyDb, 'abc123');
    expect(row).toBeUndefined();
    emptyDb.close();
  });
});

// ─── listRecentCommits ────────────────────────────────────────────────────────

describe('listRecentCommits', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice', 'a@x.com', 1700000001);
    insertCommit(db, 'sha2', 'Bob', 'b@x.com', 1700000003);
    insertCommit(db, 'sha3', 'Carol', 'c@x.com', 1700000002);
  });

  it('should return commits ordered by timestamp DESC', () => {
    const rows = listRecentCommits(db);
    expect(rows[0].sha).toBe('sha2'); // timestamp 3
    expect(rows[1].sha).toBe('sha3'); // timestamp 2
    expect(rows[2].sha).toBe('sha1'); // timestamp 1
  });

  it('should respect the limit parameter', () => {
    const rows = listRecentCommits(db, 2);
    expect(rows.length).toBe(2);
  });

  it('should default limit to 50 and return all rows when count < 50', () => {
    const rows = listRecentCommits(db);
    expect(rows.length).toBe(3);
  });

  it('should return empty array when no commits exist', () => {
    const emptyDb = createTestDb();
    expect(listRecentCommits(emptyDb)).toEqual([]);
    emptyDb.close();
  });
});

// ─── listCommitsByFile ────────────────────────────────────────────────────────

describe('listCommitsByFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice', 'a@x.com', 1700000001);
    insertCommit(db, 'sha2', 'Bob', 'b@x.com', 1700000002);
    insertCommit(db, 'sha3', 'Carol', 'c@x.com', 1700000003);
    insertCommitFile(db, 'sha1', 'src/foo.ts');
    insertCommitFile(db, 'sha2', 'src/foo.ts');
    insertCommitFile(db, 'sha3', 'src/bar.ts');
  });

  it('should return only commits that touched the given file', () => {
    const rows = listCommitsByFile(db, 'src/foo.ts');
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r)).toBeTruthy();
    const shas = rows.map((r) => r.sha);
    expect(shas).toContain('sha1');
    expect(shas).toContain('sha2');
  });

  it('should order results by timestamp DESC', () => {
    const rows = listCommitsByFile(db, 'src/foo.ts');
    expect(rows[0].sha).toBe('sha2');
    expect(rows[1].sha).toBe('sha1');
  });

  it('should return empty array for a file with no commits', () => {
    const rows = listCommitsByFile(db, 'src/nonexistent.ts');
    expect(rows).toEqual([]);
  });

  it('should respect the limit parameter', () => {
    const rows = listCommitsByFile(db, 'src/foo.ts', 1);
    expect(rows.length).toBe(1);
  });
});

// ─── listCommitsByAuthor ──────────────────────────────────────────────────────

describe('listCommitsByAuthor', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice Smith', 'alice@example.com', 1700000001);
    insertCommit(db, 'sha2', 'Bob Jones', 'bob@example.com', 1700000002);
    insertCommit(db, 'sha3', 'Alice Smith', 'alice@example.com', 1700000003);
  });

  it('should match commits by author name substring', () => {
    const rows = listCommitsByAuthor(db, 'Alice');
    const shas = rows.map((r) => r.sha);
    expect(shas).toContain('sha1');
    expect(shas).toContain('sha3');
    expect(shas).not.toContain('sha2');
  });

  it('should match commits by author email substring', () => {
    const rows = listCommitsByAuthor(db, 'bob@example');
    expect(rows.length).toBe(1);
    expect(rows[0].sha).toBe('sha2');
  });

  it('should return commits ordered by timestamp DESC', () => {
    const rows = listCommitsByAuthor(db, 'Alice');
    expect(rows[0].sha).toBe('sha3');
    expect(rows[1].sha).toBe('sha1');
  });

  it('should return empty array when no author matches', () => {
    const rows = listCommitsByAuthor(db, 'Zara');
    expect(rows).toEqual([]);
  });

  it('should respect the limit parameter', () => {
    const rows = listCommitsByAuthor(db, 'Alice', 1);
    expect(rows.length).toBe(1);
  });
});

// ─── listCommitFiles ──────────────────────────────────────────────────────────

describe('listCommitFiles', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice', 'a@x.com', 1700000001);
    insertCommitFile(db, 'sha1', 'src/foo.ts', 'added', 10, 0);
    insertCommitFile(db, 'sha1', 'src/bar.ts', 'modified', 5, 3);
  });

  it('should return all files touched by the given commit', () => {
    const rows = listCommitFiles(db, 'sha1');
    expect(rows.length).toBe(2);
    const paths = rows.map((r) => r.file_path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).toContain('src/bar.ts');
  });

  it('should return CommitFileRow with correct shape', () => {
    const rows = listCommitFiles(db, 'sha1');
    const foo = rows.find((r) => r.file_path === 'src/foo.ts')!;
    expect(foo.commit_sha).toBe('sha1');
    expect(foo.change_type).toBe('added');
    expect(foo.insertions).toBe(10);
    expect(foo.deletions).toBe(0);
  });

  it('should allow null insertions/deletions for binary files', () => {
    insertCommitFile(db, 'sha1', 'image.png', 'modified', null, null);
    const rows = listCommitFiles(db, 'sha1');
    const img = rows.find((r) => r.file_path === 'image.png')!;
    expect(img.insertions).toBeNull();
    expect(img.deletions).toBeNull();
  });

  it('should return empty array for a commit with no files', () => {
    insertCommit(db, 'sha2', 'Bob', 'b@x.com', 1700000002);
    const rows = listCommitFiles(db, 'sha2');
    expect(rows).toEqual([]);
  });

  it('should return empty array for a non-existent commit SHA', () => {
    const rows = listCommitFiles(db, 'nonexistent');
    expect(rows).toEqual([]);
  });
});
