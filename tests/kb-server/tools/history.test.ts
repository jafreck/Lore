import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { handler, toolDef } from '../../../src/kb-server/tools/history.js';
import type { EmbeddingProvider } from '../../../src/indexer/embedder.js';

const esmRequire = createRequire(import.meta.url);

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

function loadCommitEmbeddingsTable(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE commit_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);
}

function insertCommitEmbedding(db: Database.Database, commitSha: string, embedding: number[]): void {
  const row = db
    .prepare('SELECT rowid FROM commits WHERE sha = ?')
    .get(commitSha) as { rowid: number } | undefined;
  if (!row) {
    throw new Error(`Missing commit row for sha ${commitSha}`);
  }
  db.prepare(
    'INSERT OR REPLACE INTO commit_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(row.rowid, JSON.stringify(embedding));
}

// ─── toolDef ──────────────────────────────────────────────────────────────────

describe('toolDef', () => {
  it('should have the correct name', async () => {
    expect(toolDef.name).toBe('kb_history');
  });

  it('should have a description string', async () => {
    expect(typeof toolDef.description).toBe('string');
    expect(toolDef.description.length).toBeGreaterThan(0);
  });

  it('should require mode in the input schema', async () => {
    expect(toolDef.inputSchema.required).toContain('mode');
  });

  it('should list semantic mode in the enum values', async () => {
    const modeEnum = toolDef.inputSchema.properties.mode.enum;
    expect(modeEnum).toContain('file');
    expect(modeEnum).toContain('commit');
    expect(modeEnum).toContain('author');
    expect(modeEnum).toContain('ref');
    expect(modeEnum).toContain('semantic');
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

  it('should return mode="recent"', async () => {
    const result = await handler(db, { mode: 'recent' });
    expect(result.mode).toBe('recent');
  });

  it('should return all commits ordered by timestamp DESC', async () => {
    const result = await handler(db, { mode: 'recent' });
    expect(result.results[0].sha).toBe('sha2');
    expect(result.results[2].sha).toBe('sha1');
  });

  it('should set count equal to results.length', async () => {
    const result = await handler(db, { mode: 'recent' });
    expect(result.count).toBe(result.results.length);
  });

  it('should default limit to 20', async () => {
    // Insert 25 commits and verify only 20 are returned
    for (let i = 4; i <= 25; i++) {
      insertCommit(db, `sha${i}`, 'Extra', 'e@x.com', 1700000000 + i);
    }
    const result = await handler(db, { mode: 'recent' });
    expect(result.results.length).toBe(20);
  });

  it('should respect an explicit limit', async () => {
    const result = await handler(db, { mode: 'recent', limit: 2 });
    expect(result.results.length).toBe(2);
  });

  it('should cap limit at 200', async () => {
    for (let i = 4; i <= 210; i++) {
      insertCommit(db, `sha${i}`, 'Extra', 'e@x.com', 1700000000 + i);
    }
    const result = await handler(db, { mode: 'recent', limit: 9999 });
    expect(result.results.length).toBeLessThanOrEqual(200);
  });

  it('should enforce minimum limit of 1', async () => {
    const result = await handler(db, { mode: 'recent', limit: -5 });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('should return count 0 when no commits exist', async () => {
    const emptyDb = createTestDb();
    const result = await handler(emptyDb, { mode: 'recent' });
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

  it('should return mode="file"', async () => {
    const result = await handler(db, { mode: 'file', query: 'src/foo.ts' });
    expect(result.mode).toBe('file');
  });

  it('should return commits that touched the queried file', async () => {
    const result = await handler(db, { mode: 'file', query: 'src/foo.ts' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha1');
  });

  it('should return commits across rename-linked file history', async () => {
    insertCommit(db, 'sha3', 'Carol', 'c@x.com', 1700000003);
    insertCommitFile(db, 'sha3', 'src/{foo.ts => baz.ts}', 'renamed');

    const result = await handler(db, { mode: 'file', query: 'src/baz.ts' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha3');
  });

  it('should return empty results for a file with no commits', async () => {
    const result = await handler(db, { mode: 'file', query: 'src/nonexistent.ts' });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('should fall back to listRecentCommits when query is empty string', async () => {
    const result = await handler(db, { mode: 'file', query: '' });
    expect(result.count).toBe(2);
  });

  it('should fall back to listRecentCommits when query is whitespace only', async () => {
    const result = await handler(db, { mode: 'file', query: '   ' });
    expect(result.count).toBe(2);
  });

  it('should fall back to listRecentCommits when query is omitted', async () => {
    const result = await handler(db, { mode: 'file' });
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

  it('should return mode="commit"', async () => {
    const result = await handler(db, { mode: 'commit', query: 'abcdef123456' });
    expect(result.mode).toBe('commit');
  });

  it('should find the commit by full SHA', async () => {
    const result = await handler(db, { mode: 'commit', query: 'abcdef123456' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('abcdef123456');
  });

  it('should find the commit by partial SHA prefix', async () => {
    const result = await handler(db, { mode: 'commit', query: 'abcdef' });
    expect(result.count).toBe(1);
  });

  it('should attach commit_files to the result', async () => {
    const result = await handler(db, { mode: 'commit', query: 'abcdef123456' });
    const commit = result.results[0];
    expect(commit.files).toBeDefined();
    expect(commit.files!.length).toBe(2);
    const paths = commit.files!.map((f) => f.file_path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).toContain('src/bar.ts');
  });

  it('should attach commit_refs to the result when available', async () => {
    const result = await handler(db, { mode: 'commit', query: 'abcdef123456' });
    const commit = result.results[0];
    expect(commit.refs).toBeDefined();
    expect(commit.refs!.map((r) => r.ref_name)).toContain('refs/heads/main');
    expect(commit.refs!.map((r) => r.ref_name)).toContain('refs/tags/v1.0.0');
  });

  it('should return empty results for a non-matching SHA', async () => {
    const result = await handler(db, { mode: 'commit', query: 'zzz999' });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('should return empty results when query is empty string', async () => {
    const result = await handler(db, { mode: 'commit', query: '' });
    expect(result.count).toBe(0);
  });

  it('should return empty results when query is omitted', async () => {
    const result = await handler(db, { mode: 'commit' });
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

  it('should return mode="author"', async () => {
    const result = await handler(db, { mode: 'author', query: 'Alice' });
    expect(result.mode).toBe('author');
  });

  it('should return commits matching the author name substring', async () => {
    const result = await handler(db, { mode: 'author', query: 'Alice' });
    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.sha)).not.toContain('sha2');
  });

  it('should match by email substring', async () => {
    const result = await handler(db, { mode: 'author', query: 'bob@example' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha2');
  });

  it('should fall back to listRecentCommits when query is empty', async () => {
    const result = await handler(db, { mode: 'author', query: '' });
    expect(result.count).toBe(3);
  });

  it('should fall back to listRecentCommits when query is omitted', async () => {
    const result = await handler(db, { mode: 'author' });
    expect(result.count).toBe(3);
  });

  it('should return empty results when no author matches', async () => {
    const result = await handler(db, { mode: 'author', query: 'Zara' });
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

  it('should return mode="ref"', async () => {
    const result = await handler(db, { mode: 'ref', query: 'main' });
    expect(result.mode).toBe('ref');
  });

  it('should return commits matching a ref substring', async () => {
    const result = await handler(db, { mode: 'ref', query: 'main' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha-main');
  });

  it('should return commits matching a full ref name', async () => {
    const result = await handler(db, { mode: 'ref', query: 'refs/tags/v1.0.0' });
    expect(result.count).toBe(1);
    expect(result.results[0].sha).toBe('sha-tag');
  });

  it('should fall back to recent commits when query is empty', async () => {
    const result = await handler(db, { mode: 'ref', query: '' });
    expect(result.count).toBe(2);
  });

  it('should exclude commits without current refs when query is empty', async () => {
    insertCommit(db, 'sha-unreferenced', 'Carol', 'carol@example.com', 1700000012);
    const result = await handler(db, { mode: 'ref', query: '' });

    expect(result.results.map((row) => row.sha)).not.toContain('sha-unreferenced');
    expect(result.count).toBe(2);
  });
});

describe('handler – semantic mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertCommit(db, 'sha1', 'Alice', 'alice@example.com', 1700000001, 'refactor parser');
    insertCommit(db, 'sha2', 'Bob', 'bob@example.com', 1700000003, 'fix cache invalidation');
    insertCommit(db, 'sha3', 'Carol', 'carol@example.com', 1700000002, 'improve index speed');
  });

  it('should return ranked semantic commit matches when embedder and vectors are available', async () => {
    loadCommitEmbeddingsTable(db, 3);
    insertCommitEmbedding(db, 'sha1', [0, 1, 0]);
    insertCommitEmbedding(db, 'sha2', [1, 0, 0]);
    insertCommitEmbedding(db, 'sha3', [0.8, 0.2, 0]);

    const embed = vi.fn<EmbeddingProvider['embed']>().mockResolvedValue([[1, 0, 0]]);
    const embedder: EmbeddingProvider = {
      modelName: 'test-model',
      get dims() { return 3; },
      embed,
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const result = await handler(db, { mode: 'semantic', query: 'cache bug', limit: 3 }, embedder);
    expect(embed).toHaveBeenCalledWith(['cache bug']);
    expect(result.mode).toBe('semantic');
    expect(result.results.map((row) => row.sha)).toEqual(['sha2', 'sha3', 'sha1']);
  });

  it('should fall back to recent commits when no embedder is available', async () => {
    const result = await handler(db, { mode: 'semantic', query: 'cache bug', limit: 2 });
    expect(result.mode).toBe('semantic');
    expect(result.results.map((row) => row.sha)).toEqual(['sha2', 'sha3']);
  });

  it('should fall back to recent commits when commit vectors are unavailable', async () => {
    const embed = vi.fn<EmbeddingProvider['embed']>().mockResolvedValue([[1, 0, 0]]);
    const embedder: EmbeddingProvider = {
      modelName: 'test-model',
      get dims() { return 3; },
      embed,
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const result = await handler(db, { mode: 'semantic', query: 'cache bug', limit: 2 }, embedder);
    expect(embed).not.toHaveBeenCalled();
    expect(result.mode).toBe('semantic');
    expect(result.results.map((row) => row.sha)).toEqual(['sha2', 'sha3']);
  });

  it('should fall back to recent commits for semantic mode when query is blank', async () => {
    loadCommitEmbeddingsTable(db, 3);
    insertCommitEmbedding(db, 'sha2', [1, 0, 0]);

    const embed = vi.fn<EmbeddingProvider['embed']>().mockResolvedValue([[1, 0, 0]]);
    const embedder: EmbeddingProvider = {
      modelName: 'test-model',
      get dims() { return 3; },
      embed,
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const result = await handler(db, { mode: 'semantic', query: '   ', limit: 2 }, embedder);
    expect(embed).not.toHaveBeenCalled();
    expect(result.mode).toBe('semantic');
    expect(result.results.map((row) => row.sha)).toEqual(['sha2', 'sha3']);
  });

  it('should fall back to recent commits when semantic embedding returns an empty vector', async () => {
    loadCommitEmbeddingsTable(db, 3);
    insertCommitEmbedding(db, 'sha2', [1, 0, 0]);

    const embed = vi.fn<EmbeddingProvider['embed']>().mockResolvedValue([[]]);
    const embedder: EmbeddingProvider = {
      modelName: 'test-model',
      get dims() { return 3; },
      embed,
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const result = await handler(db, { mode: 'semantic', query: 'cache bug', limit: 2 }, embedder);
    expect(embed).toHaveBeenCalledWith(['cache bug']);
    expect(result.mode).toBe('semantic');
    expect(result.results.map((row) => row.sha)).toEqual(['sha2', 'sha3']);
  });

  it('should fall back to recent commits when semantic embedding throws', async () => {
    loadCommitEmbeddingsTable(db, 3);
    insertCommitEmbedding(db, 'sha2', [1, 0, 0]);

    const embed = vi.fn<EmbeddingProvider['embed']>().mockRejectedValue(new Error('embedder unavailable'));
    const embedder: EmbeddingProvider = {
      modelName: 'test-model',
      get dims() { return 3; },
      embed,
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const result = await handler(db, { mode: 'semantic', query: 'cache bug', limit: 2 }, embedder);
    expect(embed).toHaveBeenCalledWith(['cache bug']);
    expect(result.mode).toBe('semantic');
    expect(result.results.map((row) => row.sha)).toEqual(['sha2', 'sha3']);
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

  it('should floor fractional limits', async () => {
    const result = await handler(db, { mode: 'recent', limit: 2.9 });
    expect(result.results.length).toBe(2);
  });

  it('should treat limit=0 as limit=1', async () => {
    const result = await handler(db, { mode: 'recent', limit: 0 });
    expect(result.results.length).toBe(1);
  });
});
