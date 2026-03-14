import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef } from '../../../src/server/tools/diff.js';

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
      doc_comment TEXT,
      is_exported INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string, indexedAt = 0): number {
  const result = db.prepare(
    'INSERT INTO files (path, branch, language, indexed_at) VALUES (?, ?, ?, ?)',
  ).run(path, branch, 'typescript', indexedAt);
  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind: string,
  signature: string | null,
  isExported: number,
): void {
  db.prepare(
    'INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, is_exported) VALUES (?, ?, ?, 1, 10, ?, ?)',
  ).run(fileId, name, kind, signature, isExported);
}

describe('lore_diff toolDef', () => {
  it('should expose the expected MCP tool name', () => {
    expect(toolDef.name).toBe('lore_diff');
  });

  it('should require old_branch', () => {
    expect(toolDef.inputSchema.required).toContain('old_branch');
  });
});

describe('lore_diff handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should detect a symbol added in new_branch', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, oldFileId, 'existingFn', 'function', 'fn existingFn(): void', 1);
    insertSymbol(db, newFileId, 'existingFn', 'function', 'fn existingFn(): void', 1);
    insertSymbol(db, newFileId, 'newFn', 'function', 'fn newFn(): string', 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]).toMatchObject({
      name: 'newFn',
      kind: 'function',
      file_path: '/src/main.ts',
      signature: 'fn newFn(): string',
    });
    expect(result.summary.added_count).toBe(1);
  });

  it('should detect a symbol removed from old_branch', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, oldFileId, 'oldFn', 'function', 'fn oldFn(): void', 1);
    insertSymbol(db, oldFileId, 'sharedFn', 'function', 'fn sharedFn(): void', 1);
    insertSymbol(db, newFileId, 'sharedFn', 'function', 'fn sharedFn(): void', 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatchObject({
      name: 'oldFn',
      kind: 'function',
      file_path: '/src/main.ts',
    });
    expect(result.summary.removed_count).toBe(1);
  });

  it('should detect a changed symbol (same name/kind/path, different signature)', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, oldFileId, 'myFunc', 'function', 'fn myFunc(a: string): void', 1);
    insertSymbol(db, newFileId, 'myFunc', 'function', 'fn myFunc(a: string, b: number): void', 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({
      name: 'myFunc',
      kind: 'function',
      file_path: '/src/main.ts',
      old_signature: 'fn myFunc(a: string): void',
      new_signature: 'fn myFunc(a: string, b: number): void',
    });
    expect(result.summary.changed_count).toBe(1);
    // Should not appear in added or removed
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('should filter by path_prefix', () => {
    const oldSrcFileId = insertFile(db, '/src/main.ts', 'v1');
    const newSrcFileId = insertFile(db, '/src/main.ts', 'v2');
    const oldLibFileId = insertFile(db, '/lib/util.ts', 'v1');
    const newLibFileId = insertFile(db, '/lib/util.ts', 'v2');

    insertSymbol(db, newSrcFileId, 'srcFn', 'function', 'fn srcFn(): void', 1);
    insertSymbol(db, newLibFileId, 'libFn', 'function', 'fn libFn(): void', 1);
    // Keep old branches with some content so file exists
    insertSymbol(db, oldSrcFileId, 'oldStub', 'function', null, 1);
    insertSymbol(db, oldLibFileId, 'oldStub', 'function', null, 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2', path_prefix: '/src' });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.name).toBe('srcFn');
  });

  it('should filter by kind', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, newFileId, 'MyClass', 'class', 'class MyClass', 1);
    insertSymbol(db, newFileId, 'myFunc', 'function', 'fn myFunc(): void', 1);
    insertSymbol(db, oldFileId, 'placeholder', 'function', null, 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2', kind: 'class' });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.name).toBe('MyClass');
  });

  it('should cap result arrays at the specified limit', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, oldFileId, 'placeholder', 'function', null, 1);
    for (let i = 0; i < 10; i++) {
      insertSymbol(db, newFileId, `fn${i}`, 'function', `fn fn${i}(): void`, 1);
    }

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2', limit: 3 });

    expect(result.added).toHaveLength(3);
    expect(result.summary.added_count).toBe(3);
  });

  it('should return empty diff for identical branches', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, oldFileId, 'sharedFn', 'function', 'fn sharedFn(): void', 1);
    insertSymbol(db, newFileId, 'sharedFn', 'function', 'fn sharedFn(): void', 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
    expect(result.summary).toEqual({ added_count: 0, removed_count: 0, changed_count: 0 });
  });

  it('should return empty diff when no exported symbols exist', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    // Insert non-exported symbols
    insertSymbol(db, oldFileId, 'privateFn', 'function', 'fn privateFn(): void', 0);
    insertSymbol(db, newFileId, 'newPrivateFn', 'function', 'fn newPrivateFn(): void', 0);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it('should fall back to the most recently indexed branch when new_branch is omitted', () => {
    insertFile(db, '/src/main.ts', 'v1', 100);
    const newFileId = insertFile(db, '/src/main.ts', 'v2', 200);

    insertSymbol(db, newFileId, 'addedFn', 'function', 'fn addedFn(): void', 1);

    const result = handler(db, { old_branch: 'v1' });

    expect(result.new_branch).toBe('v2');
    expect(result.added).toHaveLength(1);
  });

  it('should throw when new_branch cannot be resolved', () => {
    insertFile(db, '/src/main.ts', 'v1', 100);

    expect(() => handler(db, { old_branch: 'v1' })).toThrow(
      /Cannot resolve new_branch/,
    );
  });

  it('should populate old_branch and new_branch in the result', () => {
    insertFile(db, '/src/main.ts', 'v1');
    insertFile(db, '/src/main.ts', 'v2');

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.old_branch).toBe('v1');
    expect(result.new_branch).toBe('v2');
  });

  it('should clamp limit to valid range (min 1, max 500)', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, oldFileId, 'placeholder', 'function', null, 1);
    for (let i = 0; i < 5; i++) {
      insertSymbol(db, newFileId, `fn${i}`, 'function', `fn fn${i}(): void`, 1);
    }

    // limit below minimum should be clamped to 1
    const resultMin = handler(db, { old_branch: 'v1', new_branch: 'v2', limit: -10 });
    expect(resultMin.added).toHaveLength(1);

    // limit above max should be clamped to 500
    const resultMax = handler(db, { old_branch: 'v1', new_branch: 'v2', limit: 9999 });
    expect(resultMax.added).toHaveLength(5);
  });

  it('should combine path_prefix and kind filters', () => {
    const oldSrcId = insertFile(db, '/src/main.ts', 'v1');
    const newSrcId = insertFile(db, '/src/main.ts', 'v2');
    const newLibId = insertFile(db, '/lib/util.ts', 'v2');
    insertFile(db, '/lib/util.ts', 'v1');

    insertSymbol(db, oldSrcId, 'stub', 'function', null, 1);
    insertSymbol(db, newSrcId, 'MyClass', 'class', 'class MyClass', 1);
    insertSymbol(db, newSrcId, 'myFunc', 'function', 'fn myFunc(): void', 1);
    insertSymbol(db, newLibId, 'LibClass', 'class', 'class LibClass', 1);

    const result = handler(db, {
      old_branch: 'v1',
      new_branch: 'v2',
      path_prefix: '/src',
      kind: 'class',
    });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.name).toBe('MyClass');
  });

  it('should escape special LIKE characters in path_prefix', () => {
    const oldId = insertFile(db, '/src/100%_done.ts', 'v1');
    const newId = insertFile(db, '/src/100%_done.ts', 'v2');

    insertSymbol(db, oldId, 'stub', 'function', null, 1);
    insertSymbol(db, newId, 'specialFn', 'function', 'fn specialFn(): void', 1);

    // The % and _ in path_prefix should be escaped and not treated as wildcards
    const result = handler(db, {
      old_branch: 'v1',
      new_branch: 'v2',
      path_prefix: '/src/100%_done',
    });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.name).toBe('specialFn');
  });

  it('should detect changes when signature goes from null to non-null', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    insertSymbol(db, oldFileId, 'evolving', 'function', null, 1);
    insertSymbol(db, newFileId, 'evolving', 'function', 'fn evolving(): string', 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({
      name: 'evolving',
      old_signature: null,
      new_signature: 'fn evolving(): string',
    });
  });

  it('should treat a symbol becoming non-exported as removed', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    // Exported in v1, non-exported in v2
    insertSymbol(db, oldFileId, 'demotedFn', 'function', 'fn demotedFn(): void', 1);
    insertSymbol(db, newFileId, 'demotedFn', 'function', 'fn demotedFn(): void', 0);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]!.name).toBe('demotedFn');
    expect(result.added).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it('should treat a symbol becoming exported as added', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    // Non-exported in v1, exported in v2
    insertSymbol(db, oldFileId, 'promotedFn', 'function', 'fn promotedFn(): void', 0);
    insertSymbol(db, newFileId, 'promotedFn', 'function', 'fn promotedFn(): void', 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.added).toHaveLength(1);
    expect(result.added[0]!.name).toBe('promotedFn');
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
  });

  it('should ignore non-exported symbols when detecting signature changes', () => {
    const oldFileId = insertFile(db, '/src/main.ts', 'v1');
    const newFileId = insertFile(db, '/src/main.ts', 'v2');

    // Non-exported in both branches, but signature differs
    insertSymbol(db, oldFileId, 'internalFn', 'function', 'fn internalFn(): void', 0);
    insertSymbol(db, newFileId, 'internalFn', 'function', 'fn internalFn(x: number): void', 0);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.changed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('should return empty arrays when both branches have no files', () => {
    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.changed).toHaveLength(0);
    expect(result.old_branch).toBe('v1');
    expect(result.new_branch).toBe('v2');
  });

  it('should handle multiple files with mixed add/remove/change', () => {
    const oldFile1 = insertFile(db, '/src/a.ts', 'v1');
    const newFile1 = insertFile(db, '/src/a.ts', 'v2');
    const oldFile2 = insertFile(db, '/src/b.ts', 'v1');
    const newFile2 = insertFile(db, '/src/b.ts', 'v2');

    // a.ts: removedFn removed, sharedFn changed signature
    insertSymbol(db, oldFile1, 'removedFn', 'function', 'fn removedFn(): void', 1);
    insertSymbol(db, oldFile1, 'sharedFn', 'function', 'fn sharedFn(a: string): void', 1);
    insertSymbol(db, newFile1, 'sharedFn', 'function', 'fn sharedFn(a: string, b: number): void', 1);

    // b.ts: addedFn added
    insertSymbol(db, oldFile2, 'stableFn', 'function', 'fn stableFn(): void', 1);
    insertSymbol(db, newFile2, 'stableFn', 'function', 'fn stableFn(): void', 1);
    insertSymbol(db, newFile2, 'addedFn', 'function', 'fn addedFn(): void', 1);

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });

    expect(result.summary.removed_count).toBe(1);
    expect(result.summary.added_count).toBe(1);
    expect(result.summary.changed_count).toBe(1);
    expect(result.removed[0]!.name).toBe('removedFn');
    expect(result.added[0]!.name).toBe('addedFn');
    expect(result.changed[0]!.name).toBe('sharedFn');
  });
});
