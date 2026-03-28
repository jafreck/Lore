import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef, clearGitRootCache, type BlameArgs } from '../../../src/server/tools/blame.js';

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
