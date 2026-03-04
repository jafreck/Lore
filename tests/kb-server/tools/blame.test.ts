import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef } from '../../../src/kb-server/tools/blame.js';

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

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

function insertFile(db: Database.Database, filePath: string, branch: string): void {
  db.prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)').run(
    filePath,
    branch,
    'typescript',
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

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, filePath, 'HEAD');
    vi.clearAllMocks();
  });

  it('should throw if file is not present in the index', () => {
    expect(() => handler(db, { path: '/repo/src/missing.ts', line: 3 })).toThrow(
      'File not found in index: /repo/src/missing.ts',
    );
  });

  it('should parse blame metadata for a single line', () => {
    mockExecFileSync
      .mockReturnValueOnce('/repo\n')
      .mockReturnValueOnce(
        [
          'abcdef1234567890abcdef1234567890abcdef12 7 7 1',
          'author Alice',
          'author-mail <alice@example.com>',
          'author-time 1700000100',
          'summary Add parser',
          '\tconst x = 1;',
        ].join('\n'),
      );

    const result = handler(db, { path: filePath, line: 7, ref: 'HEAD' });

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
  });

  it('should support line ranges and pass -L start,end to git blame', () => {
    mockExecFileSync
      .mockReturnValueOnce('/repo\n')
      .mockReturnValueOnce(
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

    const result = handler(db, { path: filePath, start_line: 10, end_line: 11 });

    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((l) => l.line)).toEqual([10, 11]);
    expect(mockExecFileSync).toHaveBeenLastCalledWith(
      'git',
      expect.arrayContaining(['-L', '10,11', 'HEAD', '--', 'src/main.ts']),
      { encoding: 'utf8' },
    );
  });

  it('should throw if neither line nor range is provided', () => {
    expect(() => handler(db, { path: filePath })).toThrow(
      'Provide either `line` or `start_line`/`end_line`.',
    );
  });
});
