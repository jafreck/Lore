import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef, type HistoryArgs } from '../../../src/kb-server/tools/history.js';

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
  message = 'test commit',
) {
  db.prepare(
    `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
     VALUES (?, ?, ?, ?, ?, '[]')`,
  ).run(sha, author, email, timestamp, message);
}

function insertCommitFile(
  db: Database.Database,
  commitSha: string,
  filePath: string,
  changeType = 'modified',
) {
  db.prepare(
    `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
     VALUES (?, ?, ?, 5, 2)`,
  ).run(commitSha, filePath, changeType);
}

// ─── toolDef ──────────────────────────────────────────────────────────────────

describe('toolDef', () => {
  it('should have the correct name', () => {
    expect(toolDef.name).toBe('kb_history');
  });

  it('should have a description string', () => {
    expect(typeof toolDef.description).toBe('string');
    expect(toolDef.description.length).toBeGreaterThan(0);
  });

  it('should require mode in the input schema', () => {
    expect(toolDef.inputSchema.required).toContain('mode');
  });

  it('should list four enum values for mode', () => {
    const modeEnum = toolDef.inputSchema.properties.mode.enum;
    expect(modeEnum).toContain('file');
    expect(modeEnum).toContain('commit');
    expect(modeEnum).toContain('author');
    expect(modeEnum).toContain('recent');
  });
});

// ─── handler – recent mode ────────────────────────────────────────────────────

describe('handler – recent mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice', 'a@x.com', 1700000001);
    insertCommit(db, 'sha2', 'Bob', 'b@x.com', 1700000003);
    insertCommit(db, 'sha3', 'Carol', 'c@x.com', 1700000002);
  });

  it('should return mode="recent"', () => {
    const result = handler(db, { mode: 'recent' });
    expect(result.mode).toBe('recent');
  });

  it('should return all commits ordered by timestamp DESC', () => {
    const result = handler(db, { mode: 'recent' });
    expect(result.results[0].sha).toBe('sha2');
    expect(result.results[2].sha).toBe('sha1');
  });

  it('should set count equal to results.length', () => {
    const result = handler(db, { mode: 'recent' });
    expect(result.count).toBe(result.results.length);
  });

  it('should default limit to 20', () => {
    // Insert 25 commits and verify only 20 are returned
    for (let i = 4; i <= 25; i++) {
      insertCommit(db, `sha${i}`, 'Extra', 'e@x.com', 1700000000 + i);
    }
    const result = handler(db, { mode: 'recent' });
    expect(result.results.length).toBe(20);
  });

  it('should respect an explicit limit', () => {
    const result = handler(db, { mode: 'recent', limit: 2 });
    expect(result.results.length).toBe(2);
  });

  it('should cap limit at 200', () => {
    for (let i = 4; i <= 210; i++) {
      insertCommit(db, `sha${i}`, 'Extra', 'e@x.com', 1700000000 + i);
    }
    const result = handler(db, { mode: 'recent', limit: 9999 });
    expect(result.results.length).toBeLessThanOrEqual(200);
  });

  it('should enforce minimum limit of 1', () => {
    const result = handler(db, { mode: 'recent', limit: -5 });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should return count 0 when no commits exist', () => {
    const emptyDb = createTestDb();
    const result = handler(emptyDb, { mode: 'recent' });
    expect(result.count).toBe(0);
    emptyDb.close();
  });
});

// ─── handler – file mode ──────────────────────────────────────────────────────

describe('handler – file mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice', 'a@x.com', 1700000001);
    insertCommit(db, 'sha2', 'Bob', 'b@x.com', 1700000002);
    insertCommitFile(db, 'sha1', 'src/foo.ts');
    insertCommitFile(db, 'sha2', 'src/bar.ts');
  });

  it('should return mode="file"', () => {
    const result = handler(db, { mode: 'file', query: 'src/foo.ts' });
    expect(result.mode).toBe('file');
  });

  it('should return commits that touched the queried file', () => {
    const result = handler(db, { mode: 'file', query: 'src/foo.ts' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha1');
  });

  it('should return empty results for a file with no commits', () => {
    const result = handler(db, { mode: 'file', query: 'src/nonexistent.ts' });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('should fall back to listRecentCommits when query is empty string', () => {
    const result = handler(db, { mode: 'file', query: '' });
    expect(result.count).toBe(2);
  });

  it('should fall back to listRecentCommits when query is whitespace only', () => {
    const result = handler(db, { mode: 'file', query: '   ' });
    expect(result.count).toBe(2);
  });

  it('should fall back to listRecentCommits when query is omitted', () => {
    const result = handler(db, { mode: 'file' });
    expect(result.count).toBe(2);
  });
});

// ─── handler – commit mode ────────────────────────────────────────────────────

describe('handler – commit mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'abcdef123456', 'Alice', 'a@x.com', 1700000001);
    insertCommitFile(db, 'abcdef123456', 'src/foo.ts', 'added');
    insertCommitFile(db, 'abcdef123456', 'src/bar.ts', 'modified');
  });

  it('should return mode="commit"', () => {
    const result = handler(db, { mode: 'commit', query: 'abcdef123456' });
    expect(result.mode).toBe('commit');
  });

  it('should find the commit by full SHA', () => {
    const result = handler(db, { mode: 'commit', query: 'abcdef123456' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('abcdef123456');
  });

  it('should find the commit by partial SHA prefix', () => {
    const result = handler(db, { mode: 'commit', query: 'abcdef' });
    expect(result.count).toBe(1);
  });

  it('should attach commit_files to the result', () => {
    const result = handler(db, { mode: 'commit', query: 'abcdef123456' });
    const commit = result.results[0];
    expect(commit.files).toBeDefined();
    expect(commit.files!.length).toBe(2);
    const paths = commit.files!.map((f) => f.file_path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).toContain('src/bar.ts');
  });

  it('should return empty results for a non-matching SHA', () => {
    const result = handler(db, { mode: 'commit', query: 'zzz999' });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('should return empty results when query is empty string', () => {
    const result = handler(db, { mode: 'commit', query: '' });
    expect(result.count).toBe(0);
  });

  it('should return empty results when query is omitted', () => {
    const result = handler(db, { mode: 'commit' });
    expect(result.count).toBe(0);
  });
});

// ─── handler – author mode ────────────────────────────────────────────────────

describe('handler – author mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice Smith', 'alice@example.com', 1700000001);
    insertCommit(db, 'sha2', 'Bob Jones', 'bob@example.com', 1700000002);
    insertCommit(db, 'sha3', 'Alice Smith', 'alice@example.com', 1700000003);
  });

  it('should return mode="author"', () => {
    const result = handler(db, { mode: 'author', query: 'Alice' });
    expect(result.mode).toBe('author');
  });

  it('should return commits matching the author name substring', () => {
    const result = handler(db, { mode: 'author', query: 'Alice' });
    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.sha)).not.toContain('sha2');
  });

  it('should match by email substring', () => {
    const result = handler(db, { mode: 'author', query: 'bob@example' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha2');
  });

  it('should fall back to listRecentCommits when query is empty', () => {
    const result = handler(db, { mode: 'author', query: '' });
    expect(result.count).toBe(3);
  });

  it('should fall back to listRecentCommits when query is omitted', () => {
    const result = handler(db, { mode: 'author' });
    expect(result.count).toBe(3);
  });

  it('should return empty results when no author matches', () => {
    const result = handler(db, { mode: 'author', query: 'Zara' });
    expect(result.count).toBe(0);
  });
});

// ─── limit clamping (cross-mode) ──────────────────────────────────────────────

describe('handler – limit clamping', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    for (let i = 1; i <= 5; i++) {
      insertCommit(db, `sha${i}`, 'User', 'u@x.com', 1700000000 + i);
    }
  });

  it('should floor fractional limits', () => {
    const result = handler(db, { mode: 'recent', limit: 2.9 });
    expect(result.results.length).toBe(2);
  });

  it('should treat limit=0 as limit=1', () => {
    const result = handler(db, { mode: 'recent', limit: 0 });
    expect(result.results.length).toBe(1);
  });
});
