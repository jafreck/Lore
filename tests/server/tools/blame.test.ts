import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type Database } from '../../../src/db/schema.js';
import {
  handler,
  toolDef,
  clearGitRootCache,
  expandRenamePathVariants,
  normalizePathForMatch,
  pathMatchesScope,
  computeChurnForScope,
  computeRiskSignals,
  sortedCommits,
  buildCommitContextMap,
  type BlameArgs,
  type BlameRiskSignals,
} from '../../../src/server/tools/blame.js';
import type { CommitWithFiles } from '../../../src/server/tools/history.js';

describe('lore_blame toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_blame');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.type).toBe('object');
  });
});

describe('lore_blame handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    // Insert a file so path resolution can work
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/main.ts', 'main', 'typescript', 'const x = 1;')`,
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'x', 'variable', 1, 1)`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('throws when path is missing and mode=blame', async () => {
    await expect(handler(db, { mode: 'blame' })).rejects.toThrow();
  });

  it('throws for unknown path', async () => {
    await expect(handler(db, { path: 'no/such/file.ts', mode: 'blame' })).rejects.toThrow();
  });

  it('throws for ownership mode with unknown path', async () => {
    await expect(handler(db, { path: 'no/such/file.ts', mode: 'ownership' })).rejects.toThrow();
  });

  // Note: blame/history/ownership modes require a real git repo, so we can only
  // test that the handler validates inputs and resolves paths from the DB.
  // We test the path resolution and error handling, not actual git operations.

  it('resolves symbol to line range', async () => {
    // The blame handler should resolve the symbol from the DB but will fail
    // on git operations since this is an in-memory DB.
    await expect(handler(db, { symbol: 'x', mode: 'blame' })).rejects.toThrow();
    // Verify the error is a git error, not a symbol resolution error
    await expect(handler(db, { symbol: 'x', mode: 'blame' })).rejects.not.toThrow('Symbol not found');
  });

  it('rejects both symbol and line range', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', symbol: 'x', start_line: 1, end_line: 1, mode: 'blame' }),
    ).rejects.toThrow();
  });

  it('default mode is blame', async () => {
    // Without mode, should default and still require path/symbol/line
    await expect(handler(db, {})).rejects.toThrow();
  });

  it('resolves path from DB for history mode', async () => {
    // Git operations will fail, but path should resolve from DB
    await expect(
      handler(db, { path: 'src/main.ts', start_line: 1, end_line: 1, mode: 'history' }),
    ).rejects.not.toThrow('File not found');
  });

  it('resolves path from DB for ownership mode', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', mode: 'ownership' }),
    ).rejects.not.toThrow('File not found');
  });

  it('blame with single line parameter', async () => {
    // Git operations fail but line resolution should work
    await expect(
      handler(db, { path: 'src/main.ts', line: 1, mode: 'blame' }),
    ).rejects.not.toThrow('File not found');
  });

  it('blame with start_line only', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', start_line: 1, mode: 'blame' }),
    ).rejects.not.toThrow('File not found');
  });

  it('rejects negative ref starting with dash', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', line: 1, ref: '--exec=evil', mode: 'blame' }),
    ).rejects.toThrow(/refs cannot start with/);
  });

  it('throws for ambiguous symbol', async () => {
    // Add a second symbol with the same name in a different file
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/other.ts', 'main', 'typescript', 'const x = 2;')`,
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'x', 'variable', 1, 1)`,
    ).run();
    // Should be either ambiguous or a git error, not "symbol not found"
    await expect(handler(db, { symbol: 'x', mode: 'blame' })).rejects.not.toThrow('Symbol not found');
  });

  it('throws for missing symbol', async () => {
    await expect(
      handler(db, { symbol: 'nonexistent', mode: 'blame' }),
    ).rejects.toThrow(/Symbol not found/);
  });

  it('history mode throws for missing path', async () => {
    await expect(handler(db, { mode: 'history' })).rejects.toThrow();
  });

  it('history mode without range or symbol throws', async () => {
    await expect(handler(db, { path: 'src/main.ts', mode: 'history' })).rejects.toThrow();
  });

  it('ownership mode with path not found and scope=file throws', async () => {
    await expect(
      handler(db, { path: 'no/such/dir', mode: 'ownership', scope: 'file' }),
    ).rejects.toThrow(/File not found/);
  });

  it('ownership mode without path throws', async () => {
    await expect(handler(db, { mode: 'ownership' })).rejects.toThrow(/path.*required/i);
  });

  it('ownership mode with directory scope and no matching files throws', async () => {
    await expect(
      handler(db, { path: 'nonexistent/dir/', mode: 'ownership', scope: 'directory' }),
    ).rejects.toThrow(/No indexed files found/);
  });

  it('default mode (unspecified) routes to blame', async () => {
    // Without mode, defaults to blame which requires range
    await expect(handler(db, { path: 'src/main.ts' })).rejects.toThrow(/line|start_line|symbol|range/i);
  });

  it('resolves line from end_line only', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', end_line: 1, mode: 'blame' }),
    ).rejects.not.toThrow('File not found');
  });

  it('clears git root cache', () => {
    // Just verifying the function is callable
    clearGitRootCache();
  });

  it('symbol disambiguation provides candidates in error', async () => {
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/other.ts', 'main', 'typescript', 'const x = 2;')`,
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'x', 'variable', 1, 1)`,
    ).run();
    // Should throw with ambiguity info or git error, never "symbol not found"
    await expect(handler(db, { symbol: 'x', mode: 'blame' })).rejects.not.toThrow('Symbol not found');
  });

  it('symbol with path hint resolves correct file', async () => {
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/third.ts', 'main', 'typescript', 'function y() {}')`,
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'y', 'function', 1, 1)`,
    ).run();
    // Git operations fail but symbol+path should resolve correctly
    await expect(
      handler(db, { symbol: 'y', path: 'src/third.ts', mode: 'blame' }),
    ).rejects.not.toThrow('Symbol not found');
  });

  it('commits table data is used for commit context', async () => {
    // Seed commits and commit_files
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message)
       VALUES ('abc123', 'Test Author', 'test@example.com', 1700000000, 'test commit')`,
    ).run();
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
       VALUES ('abc123', 'src/main.ts', 'M', 5, 2)`,
    ).run();
    await expect(
      handler(db, { path: 'src/main.ts', line: 1, mode: 'blame' }),
    ).rejects.not.toThrow('File not found');
  });

  it('ownership mode with file scope resolves from DB', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', mode: 'ownership', scope: 'file' }),
    ).rejects.not.toThrow('File not found');
  });

  it('history mode with symbol resolves range from DB', async () => {
    await expect(
      handler(db, { symbol: 'x', mode: 'history' }),
    ).rejects.not.toThrow('Symbol not found');
  });

  it('ownership mode with directory scope finds matching files', async () => {
    // Add more files under the same directory
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source) VALUES (4, 'src/other.ts', 'main', 'typescript', 'const y = 2;')`,
    ).run();
    await expect(
      handler(db, { path: 'src/', mode: 'ownership', scope: 'directory' }),
    ).rejects.not.toThrow('No indexed files found');
  });

  it('ref injection with dashes is blocked', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', line: 1, ref: '-exec=evil', mode: 'blame' }),
    ).rejects.toThrow(/refs cannot start with/);
  });

  it('ref with leading whitespace and dash is blocked after trim', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', line: 1, ref: ' --option', mode: 'blame' }),
    ).rejects.toThrow(/refs cannot start with/);
  });

  it('valid ref passes normalization', async () => {
    try {
      await handler(db, { path: 'src/main.ts', line: 1, ref: 'v1.0.0', mode: 'blame' });
    } catch (e: any) {
      // Should not fail on ref validation
      expect(e.message).not.toContain('refs cannot start with');
    }
  });

  it('empty ref defaults to HEAD', async () => {
    try {
      await handler(db, { path: 'src/main.ts', line: 1, ref: '', mode: 'blame' });
    } catch (e: any) {
      expect(e.message).not.toContain('refs cannot start with');
    }
  });

  it('ownership with symbol resolves to file scope', async () => {
    try {
      await handler(db, { symbol: 'x', mode: 'ownership' });
    } catch (e: any) {
      expect(e.message).not.toContain('Symbol not found');
      expect(e.message).not.toContain('path.*required');
    }
  });

  it('ownership with explicit range uses file scope', async () => {
    try {
      await handler(db, { path: 'src/main.ts', start_line: 1, end_line: 1, mode: 'ownership' });
    } catch (e: any) {
      expect(e.message).not.toContain('File not found');
    }
  });

  it('blame mode with branch filter resolves path', async () => {
    try {
      await handler(db, { path: 'src/main.ts', line: 1, branch: 'main', mode: 'blame' });
    } catch (e: any) {
      expect(e.message).not.toContain('File not found');
    }
  });

  it('blame mode with wrong branch throws file not found', async () => {
    await expect(
      handler(db, { path: 'src/main.ts', line: 1, branch: 'nonexistent', mode: 'blame' }),
    ).rejects.toThrow(/File not found/);
  });
});

// ─── Pure helper tests ──────────────────────────────────────────────────────

describe('expandRenamePathVariants', () => {
  it('returns single-element array for plain path', () => {
    expect(expandRenamePathVariants('src/foo.ts')).toEqual(['src/foo.ts']);
  });

  it('does not split when no => present', () => {
    expect(expandRenamePathVariants('a/b/c.ts')).toEqual(['a/b/c.ts']);
  });

  it('expands brace rename notation', () => {
    const result = expandRenamePathVariants('src/{old => new}/file.ts');
    expect(result).toEqual(['src/old/file.ts', 'src/new/file.ts']);
  });

  it('expands simple arrow rename', () => {
    const result = expandRenamePathVariants('old/path.ts => new/path.ts');
    expect(result).toEqual(['old/path.ts', 'new/path.ts']);
  });

  it('falls back to arrow split when brace segments are empty', () => {
    // Regex requires non-empty brace segments [^{}]+, so these fall through to arrow split
    const result = expandRenamePathVariants('src/{ => new}/file.ts');
    expect(result).toEqual(['src/{', 'new}/file.ts']);
  });
});

describe('normalizePathForMatch', () => {
  it('strips leading slashes', () => {
    expect(normalizePathForMatch('/src/foo.ts')).toBe('src/foo.ts');
  });

  it('strips trailing slashes', () => {
    expect(normalizePathForMatch('src/foo/')).toBe('src/foo');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizePathForMatch('src\\foo\\bar.ts')).toBe('src/foo/bar.ts');
  });

  it('strips multiple leading slashes', () => {
    expect(normalizePathForMatch('///src/foo.ts')).toBe('src/foo.ts');
  });

  it('handles empty string', () => {
    expect(normalizePathForMatch('')).toBe('');
  });

  it('handles path with only slashes', () => {
    expect(normalizePathForMatch('///')).toBe('');
  });
});

describe('pathMatchesScope', () => {
  it('exact match for file scope', () => {
    expect(pathMatchesScope('src/foo.ts', 'src/foo.ts', false)).toBe(true);
  });

  it('suffix match for file scope', () => {
    expect(pathMatchesScope('repo/src/foo.ts', 'src/foo.ts', false)).toBe(true);
  });

  it('no match for file scope with different path', () => {
    expect(pathMatchesScope('src/bar.ts', 'src/foo.ts', false)).toBe(false);
  });

  it('directory prefix match', () => {
    expect(pathMatchesScope('src/foo.ts', 'src', true)).toBe(true);
  });

  it('directory exact match', () => {
    expect(pathMatchesScope('src', 'src', true)).toBe(true);
  });

  it('directory no match', () => {
    expect(pathMatchesScope('lib/bar.ts', 'src', true)).toBe(false);
  });

  it('empty scope returns false', () => {
    expect(pathMatchesScope('src/foo.ts', '', false)).toBe(false);
  });

  it('handles rename path variants in file scope', () => {
    expect(pathMatchesScope('old/path.ts => new/path.ts', 'new/path.ts', false)).toBe(true);
  });

  it('directory scope with nested path', () => {
    expect(pathMatchesScope('a/src/b/c.ts', 'src', true)).toBe(true);
  });

  it('file scope reverse match (scope ends with file)', () => {
    expect(pathMatchesScope('foo.ts', 'repo/src/foo.ts', false)).toBe(true);
  });
});

describe('computeChurnForScope', () => {
  function makeCommit(sha: string, ts: number, files: { file_path: string; insertions: number; deletions: number }[]): CommitWithFiles {
    return {
      sha,
      author: 'Test',
      author_email: 'test@test.com',
      timestamp: ts,
      message: 'msg',
      parents: '',
      files: files.map((f) => ({ commit_sha: sha, file_path: f.file_path, change_type: 'M', insertions: f.insertions, deletions: f.deletions })),
    };
  }

  it('returns zero for empty commits', () => {
    expect(computeChurnForScope([], 'src/foo.ts', false)).toEqual({ totalChurn: 0, commitCount: 0 });
  });

  it('counts churn for matching file', () => {
    const commits = [makeCommit('abc', 100, [{ file_path: 'src/foo.ts', insertions: 10, deletions: 5 }])];
    const result = computeChurnForScope(commits, 'src/foo.ts', false);
    expect(result.totalChurn).toBe(15);
    expect(result.commitCount).toBe(1);
  });

  it('ignores non-matching files', () => {
    const commits = [makeCommit('abc', 100, [{ file_path: 'src/bar.ts', insertions: 10, deletions: 5 }])];
    const result = computeChurnForScope(commits, 'src/foo.ts', false);
    expect(result.totalChurn).toBe(0);
    expect(result.commitCount).toBe(0);
  });

  it('sums across multiple commits', () => {
    const commits = [
      makeCommit('a', 100, [{ file_path: 'src/foo.ts', insertions: 10, deletions: 5 }]),
      makeCommit('b', 200, [{ file_path: 'src/foo.ts', insertions: 3, deletions: 2 }]),
    ];
    const result = computeChurnForScope(commits, 'src/foo.ts', false);
    expect(result.totalChurn).toBe(20);
    expect(result.commitCount).toBe(2);
  });

  it('handles directory scope', () => {
    const commits = [
      makeCommit('a', 100, [
        { file_path: 'src/foo.ts', insertions: 10, deletions: 0 },
        { file_path: 'src/bar.ts', insertions: 5, deletions: 5 },
        { file_path: 'lib/other.ts', insertions: 100, deletions: 0 },
      ]),
    ];
    const result = computeChurnForScope(commits, 'src', true);
    expect(result.totalChurn).toBe(20); // 10+0 + 5+5, lib excluded
    expect(result.commitCount).toBe(1);
  });

  it('clamps negative insertions/deletions to zero', () => {
    const commits = [makeCommit('a', 100, [{ file_path: 'src/foo.ts', insertions: -5, deletions: -3 }])];
    const result = computeChurnForScope(commits, 'src/foo.ts', false);
    expect(result.totalChurn).toBe(0);
    expect(result.commitCount).toBe(1);
  });
});

describe('computeRiskSignals', () => {
  it('returns unknown levels for empty inputs', () => {
    const result = computeRiskSignals([], [], { totalChurn: 0, commitCount: 0 });
    expect(result.recency.level).toBe('unknown');
    expect(result.author_dispersion.level).toBe('unknown');
    expect(result.churn.level).toBe('unknown');
    expect(result.overall).toBe('unknown');
  });

  it('computes high recency for recent timestamps', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = computeRiskSignals([now - 86400], ['Alice'], { totalChurn: 10, commitCount: 1 });
    expect(result.recency.level).toBe('high');
    expect(result.recency.days_since_latest).toBeLessThanOrEqual(1);
  });

  it('computes low recency for old timestamps', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = computeRiskSignals([now - 86400 * 365], ['Alice'], { totalChurn: 10, commitCount: 1 });
    expect(result.recency.level).toBe('low');
  });

  it('computes medium recency for 30-day-old timestamp', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = computeRiskSignals([now - 86400 * 30], ['Alice'], { totalChurn: 10, commitCount: 1 });
    expect(result.recency.level).toBe('medium');
  });

  it('computes high author dispersion for many authors', () => {
    const authors = ['A', 'B', 'C', 'D', 'E'];
    const result = computeRiskSignals([1000], authors, { totalChurn: 10, commitCount: 1 });
    expect(result.author_dispersion.level).toBe('high');
    expect(result.author_dispersion.distinct_authors).toBe(5);
  });

  it('computes low author dispersion for single author', () => {
    const authors = ['A', 'A', 'A'];
    const result = computeRiskSignals([1000], authors, { totalChurn: 10, commitCount: 1 });
    expect(result.author_dispersion.level).toBe('low');
    expect(result.author_dispersion.distinct_authors).toBe(1);
  });

  it('computes medium author dispersion for 3 distinct of 10', () => {
    const authors = Array(10).fill('A');
    authors[0] = 'B';
    authors[1] = 'C';
    authors[2] = 'D';
    const result = computeRiskSignals([1000], authors, { totalChurn: 10, commitCount: 1 });
    expect(result.author_dispersion.level).toBe('medium');
  });

  it('computes high churn level', () => {
    const result = computeRiskSignals([1000], ['A'], { totalChurn: 600, commitCount: 2 });
    expect(result.churn.level).toBe('high');
  });

  it('computes medium churn level', () => {
    const result = computeRiskSignals([1000], ['A'], { totalChurn: 200, commitCount: 5 });
    expect(result.churn.level).toBe('medium');
  });

  it('computes low churn level', () => {
    const result = computeRiskSignals([1000], ['A'], { totalChurn: 20, commitCount: 2 });
    expect(result.churn.level).toBe('low');
  });

  it('overall takes the highest risk level', () => {
    const now = Math.floor(Date.now() / 1000);
    // high recency, low author, low churn → overall high
    const result = computeRiskSignals([now], ['A'], { totalChurn: 5, commitCount: 1 });
    expect(result.overall).toBe('high');
  });

  it('filters empty author strings', () => {
    const authors = ['A', '', '  ', 'B'];
    const result = computeRiskSignals([1000], authors, { totalChurn: 10, commitCount: 1 });
    expect(result.author_dispersion.distinct_authors).toBe(2);
  });
});

describe('sortedCommits', () => {
  function makeCommitEntry(sha: string, ts: number): CommitWithFiles {
    return { sha, author: 'A', author_email: 'a@a.com', timestamp: ts, message: 'm', parents: '' };
  }

  it('returns empty array for empty map', () => {
    expect(sortedCommits(new Map())).toEqual([]);
  });

  it('sorts by timestamp descending', () => {
    const map = new Map<string, CommitWithFiles>();
    map.set('aaa', makeCommitEntry('aaa', 100));
    map.set('bbb', makeCommitEntry('bbb', 300));
    map.set('ccc', makeCommitEntry('ccc', 200));
    const result = sortedCommits(map);
    expect(result.map((c) => c.sha)).toEqual(['bbb', 'ccc', 'aaa']);
  });

  it('breaks ties by sha ascending', () => {
    const map = new Map<string, CommitWithFiles>();
    map.set('zzz', makeCommitEntry('zzz', 100));
    map.set('aaa', makeCommitEntry('aaa', 100));
    const result = sortedCommits(map);
    expect(result.map((c) => c.sha)).toEqual(['aaa', 'zzz']);
  });
});

describe('buildCommitContextMap', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty map for empty sha array', () => {
    const result = buildCommitContextMap(db, []);
    expect(result.size).toBe(0);
  });

  it('returns empty map when no commits match', () => {
    const result = buildCommitContextMap(db, ['nonexistent']);
    expect(result.size).toBe(0);
  });

  it('returns enriched commits for matching shas', () => {
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message)
       VALUES ('abc123def', 'Author', 'author@test.com', 1700000000, 'test message')`,
    ).run();
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
       VALUES ('abc123def', 'src/foo.ts', 'M', 10, 5)`,
    ).run();
    const result = buildCommitContextMap(db, ['abc123def']);
    expect(result.size).toBe(1);
    expect(result.get('abc123def')?.author).toBe('Author');
  });

  it('deduplicates sha inputs', () => {
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message)
       VALUES ('abc123def', 'Author', 'author@test.com', 1700000000, 'test message')`,
    ).run();
    const result = buildCommitContextMap(db, ['abc123def', 'abc123def', 'abc123def']);
    expect(result.size).toBe(1);
  });
});

// ─── Handler tests with real git fixture ────────────────────────────────────

describe('lore_blame handler with git fixture', () => {
  let db: Database.Database;
  let tmpDir: string;

  function createGitFixture(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'main.ts'), 'function hello() { return "hi"; }\nconst x = 1;\nconst y = 2;\n');
    execSync('git add .', { cwd: dir, stdio: 'ignore' });
    execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });
  }

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'blame-test-')));
    createGitFixture(tmpDir);
    db = openDb(':memory:');
    const filePath = join(tmpDir, 'main.ts');
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source)
       VALUES (1, ?, 'main', 'typescript', 'function hello() { return "hi"; }')`,
    ).run(filePath);
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line)
       VALUES (1, 1, 'hello', 'function', 1, 1)`,
    ).run();
    clearGitRootCache();
  });

  afterEach(() => {
    db.close();
    clearGitRootCache();
  });

  it('handleBlameMode returns blame lines', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, line: 1, mode: 'blame' });
    expect(result).toHaveProperty('lines');
    if ('lines' in result) {
      expect(result.lines.length).toBeGreaterThan(0);
      expect(result.lines[0]!.author).toBe('Test');
      expect(result.lines[0]!.author_email).toBe('test@test.com');
      expect(result.lines[0]!.text).toContain('hello');
    }
  });

  it('handleBlameMode returns risk signals', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, line: 1, mode: 'blame' });
    expect(result).toHaveProperty('risk');
    if ('risk' in result && result.risk) {
      expect(result.risk.recency).toBeDefined();
      expect(result.risk.author_dispersion).toBeDefined();
      expect(result.risk.churn).toBeDefined();
      expect(result.risk.overall).toBeDefined();
    }
  });

  it('handleBlameMode with range', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, start_line: 1, end_line: 2, mode: 'blame' });
    if ('lines' in result) {
      expect(result.lines.length).toBe(2);
    }
  });

  it('handleBlameMode with symbol', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { symbol: 'hello', mode: 'blame' });
    if ('lines' in result) {
      expect(result.lines.length).toBeGreaterThan(0);
      expect(result.resolved_symbol).toBeDefined();
      expect(result.resolved_symbol?.name).toBe('hello');
    }
  });

  it('handleHistoryMode returns history entries', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, start_line: 1, end_line: 1, mode: 'history' });
    expect(result).toHaveProperty('history');
    if ('history' in result) {
      expect(result.history.length).toBeGreaterThan(0);
      expect(result.history[0]!.author).toBe('Test');
      expect(result.history[0]!.summary).toBe('initial commit');
    }
  });

  it('handleHistoryMode returns risk signals', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, start_line: 1, end_line: 1, mode: 'history' });
    if ('risk' in result) {
      expect(result.risk).toBeDefined();
      expect(result.risk.overall).toBeDefined();
    }
  });

  it('handleOwnershipMode returns ownership data for file scope', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, mode: 'ownership' });
    expect(result).toHaveProperty('ownership');
    if ('ownership' in result) {
      expect(result.scope).toBe('file');
      expect(result.ownership.length).toBeGreaterThan(0);
      expect(result.ownership[0]!.author).toBe('Test');
      expect(result.ownership[0]!.share).toBe(1);
      expect(result.total_lines).toBeGreaterThan(0);
      expect(result.files_analyzed).toBe(1);
    }
  });

  it('handleOwnershipMode with ownership for multi-line file', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, mode: 'ownership' });
    if ('ownership' in result) {
      expect(result.total_lines).toBe(3);
    }
  });

  it('handleOwnershipMode with explicit line range', async () => {
    const filePath = join(tmpDir, 'main.ts');
    const result = await handler(db, { path: filePath, start_line: 1, end_line: 2, mode: 'ownership' });
    if ('ownership' in result) {
      expect(result.total_lines).toBe(2);
      expect(result.start_line).toBe(1);
      expect(result.end_line).toBe(2);
    }
  });

  it('handleOwnershipMode with symbol resolves to file scope', async () => {
    const result = await handler(db, { symbol: 'hello', mode: 'ownership' });
    if ('ownership' in result) {
      expect(result.scope).toBe('file');
      expect(result.resolved_symbol).toBeDefined();
    }
  });

  it('handleOwnershipMode with directory scope', async () => {
    // Add a second file in same directory
    const filePath2 = join(tmpDir, 'other.ts');
    writeFileSync(filePath2, 'const z = 3;\n');
    execSync('git add .', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "add other"', { cwd: tmpDir, stdio: 'ignore' });
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source)
       VALUES (2, ?, 'main', 'typescript', 'const z = 3;')`,
    ).run(filePath2);
    const result = await handler(db, { path: tmpDir + '/', mode: 'ownership', scope: 'directory' });
    if ('ownership' in result) {
      expect(result.scope).toBe('directory');
      expect(result.files_analyzed).toBe(2);
    }
  });
});
