import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef } from '../../../src/server/tools/snippet.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
      source      TEXT    NOT NULL DEFAULT '',
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL
    );
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string, source: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language, source) VALUES (?, ?, ?, ?)')
    .run(path, branch, 'typescript', source) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
): void {
  db.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
  ).run(fileId, name, kind, startLine, endLine);
}

// ─── handler ──────────────────────────────────────────────────────────────────

describe('snippet toolDef', () => {
  it('should define symbol-aware indexed snippet schema', () => {
    expect(toolDef.name).toBe('lore_snippet');
    expect(toolDef.inputSchema.required).toEqual(['path']);
    expect(toolDef.inputSchema.properties.symbol).toEqual(
      expect.objectContaining({
        type: 'string',
      }),
    );
  });
});

describe('snippet handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should throw when path is not found in index', () => {
    expect(() => handler(db, { path: 'nonexistent.ts' })).toThrow(
      'File not found in index: nonexistent.ts',
    );
  });

  it('should throw when path exists in index but branch does not match', () => {
    insertFile(db, 'src/main.ts', 'main', 'line one');
    expect(() => handler(db, { path: 'src/main.ts', branch: 'nonexistent' })).toThrow(
      'File not found in index: src/main.ts',
    );
  });

  it('should read source from indexed snapshot data', () => {
    const path = '/virtual/main.ts';
    const source = ['const a = 1;', 'const b = 2;'].join('\n');
    insertFile(db, path, 'main', source);

    const result = handler(db, { path });
    expect(result.path).toBe(path);
    expect(result.text).toBe(source);
    expect(result.start_line).toBe(1);
    expect(result.end_line).toBe(2);
  });

  it('should respect start_line and end_line', () => {
    const path = '/virtual/range.ts';
    const source = ['one', 'two', 'three', 'four'].join('\n');
    insertFile(db, path, 'main', source);

    const result = handler(db, { path, start_line: 2, end_line: 3 });
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(3);
    expect(result.text).toBe(['two', 'three'].join('\n'));
  });

  it('should resolve line bounds from symbol metadata', () => {
    const path = '/virtual/symbol.ts';
    const source = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const fileId = insertFile(db, path, 'main', source);
    insertSymbol(db, fileId, 'doWork', 'function', 2, 4);

    const result = handler(db, { path, symbol: 'doWork' });
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(4);
    expect(result.text).toBe(['line2', 'line3', 'line4'].join('\n'));
    expect(result.containing_symbol).toEqual({
      name: 'doWork',
      kind: 'function',
      start_line: 2,
      end_line: 4,
    });
  });

  it('should include deepest containing symbol metadata for explicit ranges', () => {
    const path = '/virtual/containing.ts';
    const source = ['1', '2', '3', '4', '5', '6'].join('\n');
    const fileId = insertFile(db, path, 'main', source);
    insertSymbol(db, fileId, 'Container', 'class', 1, 6);
    insertSymbol(db, fileId, 'inner', 'method', 3, 5);

    const result = handler(db, { path, start_line: 3, end_line: 4 });
    expect(result.containing_symbol).toEqual({
      name: 'inner',
      kind: 'method',
      start_line: 3,
      end_line: 5,
    });
  });

  it('should reject mixed symbol and explicit line range inputs', () => {
    const path = '/virtual/mixed.ts';
    const fileId = insertFile(db, path, 'main', ['a', 'b', 'c'].join('\n'));
    insertSymbol(db, fileId, 'fn', 'function', 1, 3);

    expect(() => handler(db, { path, symbol: 'fn', start_line: 1, end_line: 2 })).toThrow(
      'Provide either `symbol` or `start_line`/`end_line`, not both.',
    );
  });

  it('should throw when symbol name has no match in the file', () => {
    const path = '/virtual/missing-symbol.ts';
    insertFile(db, path, 'main', ['a', 'b'].join('\n'));

    expect(() => handler(db, { path, symbol: 'missing' })).toThrow(
      'Symbol not found in indexed file: missing (/virtual/missing-symbol.ts)',
    );
  });

  it('should reject symbol values that are empty after trimming', () => {
    const path = '/virtual/empty-symbol.ts';
    insertFile(db, path, 'main', ['a', 'b'].join('\n'));

    expect(() => handler(db, { path, symbol: '   ' })).toThrow('`symbol` must be a non-empty string.');
  });

  it('should throw when symbol name is ambiguous in the file', () => {
    const path = '/virtual/ambiguous.ts';
    const fileId = insertFile(db, path, 'main', ['a', 'b', 'c', 'd'].join('\n'));
    insertSymbol(db, fileId, 'dup', 'function', 1, 2);
    insertSymbol(db, fileId, 'dup', 'function', 3, 4);

    expect(() => handler(db, { path, symbol: 'dup' })).toThrow(
      'Symbol is ambiguous in indexed file: dup (/virtual/ambiguous.ts)',
    );
  });

  it('should filter symbol and source lookup by branch when provided', () => {
    const path = '/virtual/branch.ts';
    const mainFileId = insertFile(db, path, 'main', ['main-1', 'main-2', 'main-3'].join('\n'));
    insertSymbol(db, mainFileId, 'target', 'function', 1, 2);

    const featFileId = insertFile(db, path, 'feat', ['feat-1', 'feat-2', 'feat-3'].join('\n'));
    insertSymbol(db, featFileId, 'target', 'function', 2, 3);

    const result = handler(db, { path, branch: 'feat', symbol: 'target' });
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(3);
    expect(result.text).toBe(['feat-2', 'feat-3'].join('\n'));
  });

  it('should resolve symbols case-insensitively', () => {
    const path = '/virtual/case-insensitive.ts';
    const fileId = insertFile(db, path, 'main', ['zero', 'one', 'two'].join('\n'));
    insertSymbol(db, fileId, 'BuildThing', 'function', 2, 3);

    const result = handler(db, { path, symbol: 'buildthing' });
    expect(result.start_line).toBe(2);
    expect(result.end_line).toBe(3);
    expect(result.text).toBe(['one', 'two'].join('\n'));
  });

  it('should normalize explicit line bounds to in-range integer values', () => {
    const path = '/virtual/clamp.ts';
    insertFile(db, path, 'main', ['one', 'two', 'three'].join('\n'));

    const result = handler(db, { path, start_line: 3.9, end_line: 2.1 });
    expect(result.start_line).toBe(3);
    expect(result.end_line).toBe(3);
    expect(result.text).toBe('three');
    expect(result.containing_symbol).toBeUndefined();
  });
});
