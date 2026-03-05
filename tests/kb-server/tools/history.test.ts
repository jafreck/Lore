import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  handler,
  toolDef,
  enrichCommitsWithContext,
  type HistoryArgs,
} from '../../../src/kb-server/tools/history.js';

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
    CREATE TABLE IF NOT EXISTS commit_refs (
      commit_sha TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
      ref_name   TEXT NOT NULL,
      ref_type   TEXT NOT NULL,
      PRIMARY KEY (commit_sha, ref_name)
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

function insertCommitRef(
  db: Database.Database,
  commitSha: string,
  refName: string,
  refType = 'branch',
) {
  db.prepare(
    `INSERT INTO commit_refs (commit_sha, ref_name, ref_type)
     VALUES (?, ?, ?)`,
  ).run(commitSha, refName, refType);
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
    expect(modeEnum).toContain('ref');
    expect(modeEnum).toContain('recent');
  });
});

describe('enrichCommitsWithContext', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'ctx-sha', 'Alice', 'alice@example.com', 1700000001, 'context commit');
    insertCommitFile(db, 'ctx-sha', 'src/foo.ts', 'modified');
    insertCommitRef(db, 'ctx-sha', 'refs/heads/main', 'branch');
  });

  it('should include commit files and refs by default', () => {
    const baseCommit = handler(db, { mode: 'recent' }).results[0];
    const enriched = enrichCommitsWithContext(db, [baseCommit]);

    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.files).toEqual([
      expect.objectContaining({
        commit_sha: 'ctx-sha',
        file_path: 'src/foo.ts',
      }),
    ]);
    expect(enriched[0]?.refs).toEqual([
      expect.objectContaining({
        commit_sha: 'ctx-sha',
        ref_name: 'refs/heads/main',
      }),
    ]);
  });

  it('should allow callers to disable files and refs enrichment', () => {
    const baseCommit = handler(db, { mode: 'recent' }).results[0];
    const enriched = enrichCommitsWithContext(db, [baseCommit], {
      includeFiles: false,
      includeRefs: false,
    });

    expect(enriched[0]?.files).toBeUndefined();
    expect(enriched[0]?.refs).toBeUndefined();
  });

  it('should allow callers to disable only file enrichment', () => {
    const baseCommit = handler(db, { mode: 'recent' }).results[0];
    const enriched = enrichCommitsWithContext(db, [baseCommit], {
      includeFiles: false,
    });

    expect(enriched[0]?.files).toBeUndefined();
    expect(enriched[0]?.refs).toEqual([
      expect.objectContaining({
        commit_sha: 'ctx-sha',
        ref_name: 'refs/heads/main',
      }),
    ]);
  });

  it('should allow callers to disable only ref enrichment', () => {
    const baseCommit = handler(db, { mode: 'recent' }).results[0];
    const enriched = enrichCommitsWithContext(db, [baseCommit], {
      includeRefs: false,
    });

    expect(enriched[0]?.files).toEqual([
      expect.objectContaining({
        commit_sha: 'ctx-sha',
        file_path: 'src/foo.ts',
      }),
    ]);
    expect(enriched[0]?.refs).toBeUndefined();
  });

  it('should return an empty array when no commits are provided', () => {
    const enriched = enrichCommitsWithContext(db, []);
    expect(enriched).toEqual([]);
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

  it('should preserve recent mode shape without automatic commit enrichment', () => {
    insertCommitFile(db, 'sha2', 'src/recent.ts');
    insertCommitRef(db, 'sha2', 'refs/heads/main');
    const result = handler(db, { mode: 'recent' });

    expect(result.results[0]?.files).toBeUndefined();
    expect(result.results[0]?.refs).toBeUndefined();
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

  it('should return commits across rename-linked file history', () => {
    insertCommit(db, 'sha3', 'Carol', 'c@x.com', 1700000003);
    insertCommitFile(db, 'sha3', 'src/{foo.ts => baz.ts}', 'renamed');

    const result = handler(db, { mode: 'file', query: 'src/baz.ts' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha3');
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
    insertCommitRef(db, 'abcdef123456', 'refs/heads/main', 'branch');
    insertCommitRef(db, 'abcdef123456', 'refs/tags/v1.0.0', 'tag');
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

  it('should trim commit query whitespace before lookup', () => {
    const result = handler(db, { mode: 'commit', query: '  abcdef123456  ' });
    expect(result.count).toBe(1);
    expect(result.results[0]?.sha).toBe('abcdef123456');
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

  it('should attach commit_refs to the result when available', () => {
    const result = handler(db, { mode: 'commit', query: 'abcdef123456' });
    const commit = result.results[0];
    expect(commit.refs).toBeDefined();
    expect(commit.refs!.map((r) => r.ref_name)).toContain('refs/heads/main');
    expect(commit.refs!.map((r) => r.ref_name)).toContain('refs/tags/v1.0.0');
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

// ─── handler – ref mode ─────────────────────────────────────────────────────

describe('handler – ref mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha-main', 'Alice', 'alice@example.com', 1700000010);
    insertCommit(db, 'sha-tag', 'Bob', 'bob@example.com', 1700000011);
    insertCommitRef(db, 'sha-main', 'refs/heads/main', 'branch');
    insertCommitRef(db, 'sha-tag', 'refs/tags/v1.0.0', 'tag');
  });

  it('should return mode="ref"', () => {
    const result = handler(db, { mode: 'ref', query: 'main' });
    expect(result.mode).toBe('ref');
  });

  it('should return commits matching a ref substring', () => {
    const result = handler(db, { mode: 'ref', query: 'main' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha-main');
  });

  it('should return commits matching a full ref name', () => {
    const result = handler(db, { mode: 'ref', query: 'refs/tags/v1.0.0' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha-tag');
  });

  it('should fall back to recent commits when query is empty', () => {
    const result = handler(db, { mode: 'ref', query: '' });
    expect(result.count).toBe(2);
  });

  it('should exclude commits without current refs when query is empty', () => {
    insertCommit(db, 'sha-unreferenced', 'Carol', 'carol@example.com', 1700000012);
    const result = handler(db, { mode: 'ref', query: '' });

    expect(result.results.map((row) => row.sha)).not.toContain('sha-unreferenced');
    expect(result.count).toBe(2);
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
