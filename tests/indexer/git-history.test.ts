import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from '../../src/indexer/db.js';

// ─── Mock simple-git ──────────────────────────────────────────────────────────

const mockRaw = vi.fn();

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    raw: mockRaw,
  })),
}));

// ─── Helper: build a raw git log string ──────────────────────────────────────

/**
 * Constructs the raw output that `git log --numstat --format=COMMIT_SEP%n%H%n%an%n%ae%n%at%n%P%n%s`
 * produces, so tests can simulate different scenarios without a real git repo.
 */
function buildLogOutput(
  commits: Array<{
    sha: string;
    author: string;
    authorEmail: string;
    timestamp: number;
    parents: string;
    message: string;
    files: Array<{ ins: string; del: string; path: string }>;
  }>,
): string {
  return commits
    .map(c => {
      const header = `COMMIT_SEP\n${c.sha}\n${c.author}\n${c.authorEmail}\n${c.timestamp}\n${c.parents}\n${c.message}`;
      const numstat = c.files.map(f => `${f.ins}\t${f.del}\t${f.path}`).join('\n');
      return numstat.length > 0 ? `${header}\n\n${numstat}` : header;
    })
    .join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ingestGitHistory', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `lore-gh-test-${Date.now()}.db`);
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('should insert a single commit into the commits table', async () => {
    mockRaw.mockResolvedValue(
      buildLogOutput([
        {
          sha: 'aaa111',
          author: 'Alice',
          authorEmail: 'alice@example.com',
          timestamp: 1700000000,
          parents: '',
          message: 'Initial commit',
          files: [],
        },
      ]),
    );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const row = db.prepare('SELECT * FROM commits WHERE sha = ?').get('aaa111') as
      | { sha: string; author: string; author_email: string; message: string; parents: string }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row?.sha).toBe('aaa111');
    expect(row?.author).toBe('Alice');
    expect(row?.author_email).toBe('alice@example.com');
    expect(row?.message).toBe('Initial commit');
    expect(row?.parents).toBe('[]');
  });

  it('should store parent SHAs as a JSON array string', async () => {
    mockRaw.mockResolvedValue(
      buildLogOutput([
        {
          sha: 'bbb222',
          author: 'Bob',
          authorEmail: 'bob@example.com',
          timestamp: 1700000001,
          parents: 'aaa111 ccc333',
          message: 'Merge commit',
          files: [],
        },
      ]),
    );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const row = db.prepare('SELECT parents FROM commits WHERE sha = ?').get('bbb222') as
      | { parents: string }
      | undefined;
    db.close();

    expect(row?.parents).toBe('["aaa111","ccc333"]');
  });

  it('should insert commit_files rows with correct insertions and deletions', async () => {
    mockRaw.mockResolvedValue(
      buildLogOutput([
        {
          sha: 'ddd444',
          author: 'Carol',
          authorEmail: 'carol@example.com',
          timestamp: 1700000002,
          parents: '',
          message: 'Add files',
          files: [
            { ins: '10', del: '0', path: 'src/new.ts' },
            { ins: '5', del: '3', path: 'src/existing.ts' },
          ],
        },
      ]),
    );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const rows = db.prepare('SELECT * FROM commit_files WHERE commit_sha = ?').all('ddd444') as Array<{
      file_path: string;
      insertions: number | null;
      deletions: number | null;
      change_type: string;
    }>;
    db.close();

    expect(rows).toHaveLength(2);

    const newFile = rows.find(r => r.file_path === 'src/new.ts');
    expect(newFile?.insertions).toBe(10);
    expect(newFile?.deletions).toBe(0);
    expect(newFile?.change_type).toBe('added');

    const existingFile = rows.find(r => r.file_path === 'src/existing.ts');
    expect(existingFile?.insertions).toBe(5);
    expect(existingFile?.deletions).toBe(3);
    expect(existingFile?.change_type).toBe('modified');
  });

  it('should store NULL insertions and deletions for binary files', async () => {
    mockRaw.mockResolvedValue(
      buildLogOutput([
        {
          sha: 'eee555',
          author: 'Dave',
          authorEmail: 'dave@example.com',
          timestamp: 1700000003,
          parents: '',
          message: 'Add binary',
          files: [{ ins: '-', del: '-', path: 'assets/image.png' }],
        },
      ]),
    );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const row = db
      .prepare('SELECT * FROM commit_files WHERE commit_sha = ? AND file_path = ?')
      .get('eee555', 'assets/image.png') as
      | { insertions: null; deletions: null }
      | undefined;
    db.close();

    expect(row?.insertions).toBeNull();
    expect(row?.deletions).toBeNull();
  });

  it('should be idempotent (INSERT OR IGNORE) when called twice', async () => {
    const log = buildLogOutput([
      {
        sha: 'fff666',
        author: 'Eve',
        authorEmail: 'eve@example.com',
        timestamp: 1700000004,
        parents: '',
        message: 'Idempotent test',
        files: [{ ins: '2', del: '1', path: 'src/a.ts' }],
      },
    ]);
    mockRaw.mockResolvedValue(log);

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');
    await ingestGitHistory(db, '/fake/repo');

    const commits = db.prepare('SELECT * FROM commits WHERE sha = ?').all('fff666') as unknown[];
    const files = db.prepare('SELECT * FROM commit_files WHERE commit_sha = ?').all('fff666') as unknown[];
    db.close();

    expect(commits).toHaveLength(1);
    expect(files).toHaveLength(1);
  });

  it('should handle empty log output gracefully', async () => {
    mockRaw.mockResolvedValue('');

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await expect(ingestGitHistory(db, '/fake/repo')).resolves.not.toThrow();

    const commits = db.prepare('SELECT * FROM commits').all() as unknown[];
    db.close();

    expect(commits).toHaveLength(0);
  });

  it('should pass --max-count=500 (default depth) to git raw', async () => {
    mockRaw.mockResolvedValue('');

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');
    db.close();

    expect(mockRaw).toHaveBeenCalledWith(
      expect.arrayContaining(['--all']),
    );
    expect(mockRaw).not.toHaveBeenCalledWith(
      expect.arrayContaining(['--max-count=500']),
    );
  });

  it('should pass --max-count with custom depth when options.depth is provided', async () => {
    mockRaw.mockResolvedValue('');

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo', { depth: 100 });
    db.close();

    expect(mockRaw).toHaveBeenCalledWith(
      expect.arrayContaining(['--max-count=100']),
    );
  });

  it('should skip --all when options.all is false', async () => {
    mockRaw.mockResolvedValue('');

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo', { all: false });
    db.close();

    expect(mockRaw).toHaveBeenCalledWith(
      expect.arrayContaining(['log', '--numstat', '--format=COMMIT_SEP%n%H%n%an%n%ae%n%at%n%P%n%s']),
    );
    expect(mockRaw).not.toHaveBeenCalledWith(
      expect.arrayContaining(['--all']),
    );
  });

  it('should ingest branch and tag refs into commit_refs when available', async () => {
    mockRaw
      .mockResolvedValueOnce(
        buildLogOutput([
          {
            sha: 'ref111',
            author: 'Ivy',
            authorEmail: 'ivy@example.com',
            timestamp: 1700000011,
            parents: '',
            message: 'Ref commit',
            files: [],
          },
        ]),
      )
      .mockResolvedValueOnce(
        [
          'ref111 refs/heads/main',
          'ref111 refs/tags/v1.0.0',
        ].join('\n'),
      );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const refs = db
      .prepare('SELECT commit_sha, ref_name, ref_type FROM commit_refs WHERE commit_sha = ? ORDER BY ref_name')
      .all('ref111') as Array<{ commit_sha: string; ref_name: string; ref_type: string }>;
    db.close();

    expect(refs).toEqual([
      { commit_sha: 'ref111', ref_name: 'refs/heads/main', ref_type: 'branch' },
      { commit_sha: 'ref111', ref_name: 'refs/tags/v1.0.0', ref_type: 'tag' },
    ]);
  });

  it('should detect deleted files (only deletions, no insertions)', async () => {
    mockRaw.mockResolvedValue(
      buildLogOutput([
        {
          sha: 'ggg777',
          author: 'Frank',
          authorEmail: 'frank@example.com',
          timestamp: 1700000005,
          parents: '',
          message: 'Remove file',
          files: [{ ins: '0', del: '5', path: 'src/old.ts' }],
        },
      ]),
    );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const row = db
      .prepare('SELECT change_type FROM commit_files WHERE commit_sha = ? AND file_path = ?')
      .get('ggg777', 'src/old.ts') as { change_type: string } | undefined;
    db.close();

    expect(row?.change_type).toBe('deleted');
  });

  it('should detect renamed files from numstat path format', async () => {
    mockRaw.mockResolvedValue(
      buildLogOutput([
        {
          sha: 'hhh888',
          author: 'Grace',
          authorEmail: 'grace@example.com',
          timestamp: 1700000006,
          parents: '',
          message: 'Rename file',
          files: [{ ins: '2', del: '2', path: 'src/{old => new}.ts' }],
        },
      ]),
    );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const row = db
      .prepare('SELECT change_type FROM commit_files WHERE commit_sha = ?')
      .get('hhh888') as { change_type: string } | undefined;
    db.close();

    expect(row?.change_type).toBe('renamed');
  });

  it('should insert multiple commits in a single call', async () => {
    mockRaw.mockResolvedValue(
      buildLogOutput([
        {
          sha: 'iii111',
          author: 'H',
          authorEmail: 'h@example.com',
          timestamp: 1700000010,
          parents: 'iii000',
          message: 'Commit 1',
          files: [{ ins: '1', del: '0', path: 'a.ts' }],
        },
        {
          sha: 'iii000',
          author: 'H',
          authorEmail: 'h@example.com',
          timestamp: 1700000009,
          parents: '',
          message: 'Commit 0',
          files: [],
        },
      ]),
    );

    const db = openDb(dbPath);
    const { ingestGitHistory } = await import('../../src/indexer/git-history.js');
    await ingestGitHistory(db, '/fake/repo');

    const commits = db.prepare('SELECT sha FROM commits ORDER BY timestamp ASC').all() as Array<{ sha: string }>;
    db.close();

    expect(commits).toHaveLength(2);
    expect(commits.map(c => c.sha)).toContain('iii111');
    expect(commits.map(c => c.sha)).toContain('iii000');
  });
});
