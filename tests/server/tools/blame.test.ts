import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { handler, toolDef } from '../../../src/server/tools/blame.js';

const { mockExecFileSync, mockSpawn } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

/** Schedule one spawn call to emit the given stdout then close. */
function mockSpawnOnce(stdout: string, exitCode = 0): void {
  mockSpawn.mockImplementationOnce(() => {
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const childEmitter = new EventEmitter();

    process.nextTick(() => {
      if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout, 'utf8'));
      childEmitter.emit('close', exitCode);
    });

    return {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      on: childEmitter.on.bind(childEmitter),
      once: childEmitter.once.bind(childEmitter),
    };
  });
}

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
      kind        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      signature   TEXT,
      doc_comment TEXT
    );
    CREATE TABLE commits (
      sha          TEXT    PRIMARY KEY,
      author       TEXT    NOT NULL,
      author_email TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message      TEXT    NOT NULL,
      parents      TEXT    NOT NULL DEFAULT '[]'
    );
    CREATE TABLE commit_files (
      commit_sha  TEXT    NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
      file_path   TEXT    NOT NULL,
      change_type TEXT    NOT NULL,
      insertions  INTEGER,
      deletions   INTEGER,
      PRIMARY KEY (commit_sha, file_path)
    );
    CREATE TABLE commit_refs (
      commit_sha TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
      ref_name   TEXT NOT NULL,
      ref_type   TEXT NOT NULL,
      PRIMARY KEY (commit_sha, ref_name)
    );
  `);
  return db;
}

function insertFile(db: Database.Database, filePath: string, branch = 'HEAD'): number {
  const result = db.prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)').run(
    filePath,
    branch,
    'typescript',
  );
  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  startLine: number,
  endLine: number,
  kind = 'function',
): void {
  db.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
  ).run(fileId, name, kind, startLine, endLine);
}

function insertCommit(
  db: Database.Database,
  sha: string,
  author: string,
  authorEmail: string,
  timestamp: number,
  message: string,
): void {
  db.prepare(
    `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
     VALUES (?, ?, ?, ?, ?, '[]')`,
  ).run(sha, author, authorEmail, timestamp, message);
}

function insertCommitFile(
  db: Database.Database,
  commitSha: string,
  filePath: string,
  insertions: number,
  deletions: number,
): void {
  db.prepare(
    `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
     VALUES (?, ?, 'modified', ?, ?)`,
  ).run(commitSha, filePath, insertions, deletions);
}

function insertCommitRef(
  db: Database.Database,
  commitSha: string,
  refName: string,
  refType = 'branch',
): void {
  db.prepare('INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES (?, ?, ?)').run(
    commitSha,
    refName,
    refType,
  );
}

describe('lore_blame toolDef', () => {
  it('should expose the expected MCP tool name', () => {
    expect(toolDef.name).toBe('lore_blame');
  });
});

describe('lore_blame handler', () => {
  let db: Database.Database;
  const filePath = '/repo/src/main.ts';
  const utilPath = '/repo/src/util.ts';

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, filePath);
    insertFile(db, utilPath);
    vi.clearAllMocks();
  });

  it('should throw if file is not present in the index', async () => {
    await expect(handler(db, { path: '/repo/src/missing.ts', line: 3 })).rejects.toThrow(
      'File not found in index: /repo/src/missing.ts',
    );
  });

  it('should parse blame metadata for a single line with commit context and risk signals', async () => {
    insertCommit(
      db,
      'abcdef1234567890abcdef1234567890abcdef12',
      'Alice',
      'alice@example.com',
      1700000100,
      'Add parser',
    );
    insertCommitFile(db, 'abcdef1234567890abcdef1234567890abcdef12', 'src/main.ts', 12, 3);
    insertCommitRef(db, 'abcdef1234567890abcdef1234567890abcdef12', 'refs/heads/main');

    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        [
          'abcdef1234567890abcdef1234567890abcdef12 7 7 1',
          'author Alice',
          'author-mail <alice@example.com>',
          'author-time 1700000100',
          'summary Add parser',
          '\tconst x = 1;',
        ].join('\n'),
    );

    const result = await handler(db, { path: filePath, line: 7, ref: 'HEAD' });

    expect('mode' in result).toBe(false);
    expect(result.path).toBe(filePath);
    expect(result.start_line).toBe(7);
    expect(result.end_line).toBe(7);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      line: 7,
      commit_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      author: 'Alice',
      author_email: 'alice@example.com',
      timestamp: 1700000100,
      summary: 'Add parser',
      text: 'const x = 1;',
    });
    expect(result.commits).toEqual([
      expect.objectContaining({
        sha: 'abcdef1234567890abcdef1234567890abcdef12',
        message: 'Add parser',
        files: [expect.objectContaining({ file_path: 'src/main.ts' })],
        refs: [expect.objectContaining({ ref_name: 'refs/heads/main' })],
      }),
    ]);
    expect(result.risk).toEqual(
      expect.objectContaining({
        recency: expect.objectContaining({ level: expect.any(String) }),
        author_dispersion: expect.objectContaining({ distinct_authors: 1 }),
        churn: expect.objectContaining({ total_churn: 15 }),
        overall: expect.any(String),
      }),
    );
  });

  it('should support line ranges and pass -L start,end to git blame (legacy behavior)', async () => {
    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        [
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 10 10 2',
          'author Bob',
          'author-mail <bob@example.com>',
          'author-time 1700000200',
          'summary Range change',
          '\tline 10',
          '\tline 11',
        ].join('\n'),
    );

    const result = await handler(db, { path: filePath, start_line: 10, end_line: 11 });

    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((l) => l.line)).toEqual([10, 11]);
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'git',
      expect.arrayContaining(['-L', '10,11', 'HEAD', '--', 'src/main.ts']),
    );
  });

  it('should resolve symbol-only requests to a concrete blame line range', async () => {
    const fileId = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number };
    insertSymbol(db, fileId.id, 'handleAuth', 20, 24);
    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        [
          'cccccccccccccccccccccccccccccccccccccccc 20 20 1',
          'author Carol',
          'author-mail <carol@example.com>',
          'author-time 1700000400',
          'summary Add auth handler',
          '\tfunction handleAuth() {}',
        ].join('\n'),
    );

    const result = await handler(db, { symbol: 'handleAuth', branch: 'HEAD' });

    expect(result.path).toBe(filePath);
    expect(result.start_line).toBe(20);
    expect(result.end_line).toBe(24);
    expect(result.resolved_symbol).toEqual(
      expect.objectContaining({
        name: 'handleAuth',
        path: filePath,
        start_line: 20,
        end_line: 24,
      }),
    );
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'git',
      expect.arrayContaining(['-L', '20,24', 'HEAD', '--', 'src/main.ts']),
    );
  });

  it('should throw when symbol resolution yields no indexed match', async () => {
    await expect(handler(db, { symbol: 'missingSymbol' })).rejects.toThrow(
      'Symbol not found in index: missingSymbol',
    );
  });

  it('should throw when symbol resolution is ambiguous', async () => {
    const mainFileId = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number };
    const utilFileId = db.prepare('SELECT id FROM files WHERE path = ?').get(utilPath) as { id: number };
    insertSymbol(db, mainFileId.id, 'duplicateSymbol', 5, 7);
    insertSymbol(db, utilFileId.id, 'duplicateSymbol', 10, 12);

    await expect(handler(db, { symbol: 'duplicateSymbol' })).rejects.toThrow(
      'Symbol is ambiguous: duplicateSymbol.',
    );
  });

  it('should return full line-range history in history mode', async () => {
    insertCommit(db, '1111111111111111111111111111111111111111', 'Alice', 'alice@example.com', 1700000001, 'old impl');
    insertCommit(db, '2222222222222222222222222222222222222222', 'Bob', 'bob@example.com', 1700001000, 'new impl');
    insertCommitFile(db, '1111111111111111111111111111111111111111', 'src/main.ts', 2, 1);
    insertCommitFile(db, '2222222222222222222222222222222222222222', 'src/main.ts', 8, 4);
    insertCommitRef(db, '2222222222222222222222222222222222222222', 'refs/heads/main');

    const historyOutput = [
      '2222222222222222222222222222222222222222\x1fBob\x1fbob@example.com\x1f1700001000\x1fnew impl',
      '',
      'diff --git a/src/main.ts b/src/main.ts',
      '@@ -10,1 +10,1 @@',
      '-old',
      '+new',
      '1111111111111111111111111111111111111111\x1fAlice\x1falice@example.com\x1f1700000001\x1fold impl',
      '',
      'diff --git a/src/main.ts b/src/main.ts',
      '@@ -10,1 +10,1 @@',
      '-very old',
      '+old',
    ].join('\n');

    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(historyOutput);

    const result = await handler(db, { mode: 'history', path: filePath, start_line: 10, end_line: 10 });

    expect(result.mode).toBe('history');
    expect(result.path).toBe(filePath);
    expect(result.count).toBe(2);
    expect(result.history[0]).toEqual(
      expect.objectContaining({
        commit_sha: '2222222222222222222222222222222222222222',
        summary: 'new impl',
        patch: expect.stringContaining('diff --git a/src/main.ts b/src/main.ts'),
        commit_context: expect.objectContaining({
          message: 'new impl',
          files: [expect.objectContaining({ file_path: 'src/main.ts' })],
          refs: [expect.objectContaining({ ref_name: 'refs/heads/main' })],
        }),
      }),
    );
    expect(result.risk).toEqual(
      expect.objectContaining({
        recency: expect.objectContaining({ level: expect.any(String) }),
        author_dispersion: expect.objectContaining({ distinct_authors: 2 }),
        churn: expect.objectContaining({ total_churn: 15 }),
      }),
    );
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'git',
      expect.arrayContaining([
        'log',
        '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s',
        '-L',
        '10,10:src/main.ts',
        'HEAD',
      ]),
    );
  });

  it('should compose symbol targeting with history mode', async () => {
    const fileId = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number };
    insertSymbol(db, fileId.id, 'handleAuth', 20, 24);
    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        '3333333333333333333333333333333333333333\x1fCarol\x1fcarol@example.com\x1f1700001500\x1fauth change\n\n',
    );

    const result = await handler(db, { mode: 'history', symbol: 'handleAuth', branch: 'HEAD' });

    expect(result.mode).toBe('history');
    expect(result.start_line).toBe(20);
    expect(result.end_line).toBe(24);
    expect(result.resolved_symbol).toEqual(
      expect.objectContaining({
        name: 'handleAuth',
        start_line: 20,
        end_line: 24,
      }),
    );
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'git',
      expect.arrayContaining(['-L', '20,24:src/main.ts', 'HEAD']),
    );
  });

  it('should aggregate ownership for file and directory scopes', async () => {
    insertCommit(db, '4444444444444444444444444444444444444444', 'Alice', 'alice@example.com', 1700002000, 'file work');
    insertCommit(db, '5555555555555555555555555555555555555555', 'Bob', 'bob@example.com', 1700003000, 'dir work');
    insertCommitFile(db, '4444444444444444444444444444444444444444', 'src/main.ts', 4, 1);
    insertCommitFile(db, '5555555555555555555555555555555555555555', 'src/util.ts', 10, 2);

    // file ownership call: rev-parse + blame
    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        [
          '4444444444444444444444444444444444444444 1 1 2',
          'author Alice',
          'author-mail <alice@example.com>',
          'author-time 1700002000',
          'summary file work',
          '\tline one',
          '\tline two',
        ].join('\n'),
    );
    // directory ownership call: src/main.ts — rev-parse + blame
    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        [
          '4444444444444444444444444444444444444444 1 1 1',
          'author Alice',
          'author-mail <alice@example.com>',
          'author-time 1700002000',
          'summary file work',
          '\tline one',
        ].join('\n'),
    );
    // directory ownership call: src/util.ts — rev-parse + blame
    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        [
          '5555555555555555555555555555555555555555 1 1 2',
          'author Bob',
          'author-mail <bob@example.com>',
          'author-time 1700003000',
          'summary dir work',
          '\tutil one',
          '\tutil two',
        ].join('\n'),
    );

    const fileOwnership = await handler(db, { mode: 'ownership', path: filePath });
    expect(fileOwnership.mode).toBe('ownership');
    expect(fileOwnership.scope).toBe('file');
    expect(fileOwnership.files_analyzed).toBe(1);
    expect(fileOwnership.total_lines).toBe(2);
    expect(fileOwnership.ownership[0]).toEqual(
      expect.objectContaining({
        author: 'Alice',
        lines: 2,
        commit_count: 1,
      }),
    );

    const dirOwnership = await handler(db, {
      mode: 'ownership',
      path: '/repo/src',
      scope: 'directory',
      branch: 'HEAD',
    });
    expect(dirOwnership.mode).toBe('ownership');
    expect(dirOwnership.scope).toBe('directory');
    expect(dirOwnership.files_analyzed).toBe(2);
    expect(dirOwnership.total_lines).toBe(3);
    expect(dirOwnership.ownership.map((row) => row.author)).toEqual(['Bob', 'Alice']);
    expect(dirOwnership.risk).toEqual(
      expect.objectContaining({
        recency: expect.objectContaining({ level: expect.any(String) }),
        author_dispersion: expect.objectContaining({ distinct_authors: 2 }),
      }),
    );
  });

  it('should force file ownership scope when symbol targeting is provided', async () => {
    const fileId = db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number };
    insertSymbol(db, fileId.id, 'handleAuth', 20, 21);

    mockExecFileSync.mockReturnValueOnce('/repo\n');
    mockSpawnOnce(
        [
          '6666666666666666666666666666666666666666 20 20 2',
          'author Dana',
          'author-mail <dana@example.com>',
          'author-time 1700004000',
          'summary symbol ownership',
          '\tline one',
          '\tline two',
        ].join('\n'),
    );

    const result = await handler(db, {
      mode: 'ownership',
      symbol: 'handleAuth',
      scope: 'directory',
      branch: 'HEAD',
    });

    expect(result.mode).toBe('ownership');
    expect(result.scope).toBe('file');
    expect(result.path).toBe(filePath);
    expect(result.files_analyzed).toBe(1);
    expect(result.start_line).toBe(20);
    expect(result.end_line).toBe(21);
    expect(result.resolved_symbol).toEqual(
      expect.objectContaining({
        name: 'handleAuth',
        path: filePath,
      }),
    );
    expect(mockSpawn).toHaveBeenLastCalledWith(
      'git',
      expect.arrayContaining(['-L', '20,21', 'HEAD', '--', 'src/main.ts']),
    );
  });

  it('should require a path for ownership mode when no symbol or range is provided', async () => {
    await expect(handler(db, { mode: 'ownership' })).rejects.toThrow('`path` is required for ownership mode.');
  });

  it('should throw when ownership is forced to file scope for an unknown file path', async () => {
    await expect(
      handler(db, { mode: 'ownership', path: '/repo/src/missing.ts', scope: 'file', branch: 'HEAD' }),
    ).rejects.toThrow('File not found in index: /repo/src/missing.ts');
  });

  it('should throw if neither line/range nor symbol is provided for default blame mode', async () => {
    await expect(handler(db, { path: filePath })).rejects.toThrow(
      'Provide either `line`, `start_line`/`end_line`, or `symbol`.',
    );
  });
});
