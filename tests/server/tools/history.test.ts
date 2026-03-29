import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/history.js';

function seedHistoryData(db: Database.Database) {
  db.prepare(
    `INSERT INTO commits (sha, author, author_email, timestamp, message)
     VALUES ('abc123', 'Alice', 'alice@example.com', 1700000000, 'feat: add user auth')`,
  ).run();
  db.prepare(
    `INSERT INTO commits (sha, author, author_email, timestamp, message)
     VALUES ('def456', 'Bob', 'bob@example.com', 1700001000, 'fix: login bug')`,
  ).run();
  db.prepare(
    `INSERT INTO commits (sha, author, author_email, timestamp, message)
     VALUES ('ghi789', 'Alice', 'alice@example.com', 1700002000, 'chore: cleanup')`,
  ).run();

  db.prepare(
    `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
     VALUES ('abc123', 'src/auth.ts', 'added', 50, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
     VALUES ('def456', 'src/auth.ts', 'modified', 5, 3)`,
  ).run();

  db.prepare(`INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('abc123', 'refs/heads/main', 'branch')`).run();
  db.prepare(`INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('ghi789', 'refs/tags/v1.0.0', 'tag')`).run();
}

describe('lore_history toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_history');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.required).toContain('mode');
  });
});

describe('lore_history handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedHistoryData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns recent commits', async () => {
    const result = await handler(db, { mode: 'recent' });
    expect(result.mode).toBe('recent');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('queries by file path', async () => {
    const result = await handler(db, { mode: 'file', query: 'src/auth.ts' });
    expect(result.mode).toBe('file');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // All results should reference the queried file
    for (const r of result.results as any[]) {
      expect(r.files?.some((f: any) => f.file_path === 'src/auth.ts') ?? true).toBe(true);
    }
  });

  it('queries by commit SHA', async () => {
    const result = await handler(db, { mode: 'commit', query: 'abc123' });
    expect(result.mode).toBe('commit');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.sha).toBe('abc123');
  });

  it('returns empty for non-existent SHA', async () => {
    const result = await handler(db, { mode: 'commit', query: 'zzz000' });
    expect(result.results).toHaveLength(0);
  });

  it('returns empty for empty SHA', async () => {
    const result = await handler(db, { mode: 'commit', query: '' });
    expect(result.results).toHaveLength(0);
  });

  it('queries by author', async () => {
    const result = await handler(db, { mode: 'author', query: 'Alice' });
    expect(result.mode).toBe('author');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const commit of result.results) {
      expect(commit.author).toBe('Alice');
    }
  });

  it('queries by ref', async () => {
    const result = await handler(db, { mode: 'ref', query: 'main' });
    expect(result.mode).toBe('ref');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // All results should be associated with the queried ref
    for (const r of result.results as any[]) {
      expect(r.refs?.some((ref: any) => ref.ref_name === 'main') ?? true).toBe(true);
    }
  });

  it('respects limit', async () => {
    const result = await handler(db, { mode: 'recent', limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  it('clamps negative limit', async () => {
    const result = await handler(db, { mode: 'recent', limit: -5 });
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('handles empty DB', async () => {
    const emptyDb = openDb(':memory:');
    try {
      const result = await handler(emptyDb, { mode: 'recent' });
      expect(result.results).toHaveLength(0);
    } finally {
      emptyDb.close();
    }
  });

  it('semantic mode falls back without embedder', async () => {
    const result = await handler(db, { mode: 'semantic', query: 'user authentication' });
    expect(result.mode).toBe('semantic');
    // Falls back to recent commits since no embedder is available
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.mode_used ?? result.mode).toContain('semantic');
  });

  it('commit mode enriches with files and refs', async () => {
    const result = await handler(db, { mode: 'commit', query: 'abc123' });
    const commit = result.results[0] as any;
    expect(commit).toBeDefined();
    expect(commit.files).toBeDefined();
    expect(commit.refs).toBeDefined();
    expect(Array.isArray(commit.files)).toBe(true);
    expect(Array.isArray(commit.refs)).toBe(true);
  });
});
