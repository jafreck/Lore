import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from '../../../src/db/schema.js';
import { openPromotedTestDb as openDb } from '../../helpers/promotedDb.js';
import { handler, toolDef } from '../../../src/server/tools/diff.js';

function seedDiffData(db: Database.Database) {
  // Files on old_branch
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/api.ts', 'v1', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/api.ts', 'v2', 'typescript', '')`).run();

  // Symbols on v1 branch
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported) VALUES (1, 1, 'getUser', 'function', 1, 5, '(id: number): User', 1)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported) VALUES (2, 1, 'deleteUser', 'function', 6, 10, '(id: number): void', 1)`).run();

  // Symbols on v2 branch — getUser signature changed, deleteUser removed, createUser added
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported) VALUES (3, 2, 'getUser', 'function', 1, 5, '(id: string): User', 1)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported) VALUES (4, 2, 'createUser', 'function', 6, 10, '(data: CreateUserInput): User', 1)`).run();
}

describe('lore_diff toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_diff');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.required).toContain('old_branch');
  });
});

describe('lore_diff handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDiffData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('detects added symbols', () => {
    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });
    expect(result.old_branch).toBe('v1');
    expect(result.new_branch).toBe('v2');
    const addedNames = result.added.map((a) => a.name);
    expect(addedNames).toContain('createUser');
    expect(result.added.find((entry) => entry.name === 'createUser')!.start_line).toBe(7);
  });

  it('detects removed symbols', () => {
    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });
    const removedNames = result.removed.map((r) => r.name);
    expect(removedNames).toContain('deleteUser');
  });

  it('detects changed signatures', () => {
    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });
    const changedNames = result.changed.map((c) => c.name);
    expect(changedNames).toContain('getUser');
    const getUser = result.changed.find((c) => c.name === 'getUser')!;
    expect(getUser.old_signature).toBe('(id: number): User');
    expect(getUser.new_signature).toBe('(id: string): User');
    expect(getUser.start_line).toBe(2);
  });

  it('returns summary with counts', () => {
    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });
    expect(result.summary).toBeDefined();
    expect(result.summary.added.total).toBeGreaterThanOrEqual(1);
    expect(result.summary.removed.total).toBeGreaterThanOrEqual(1);
    expect(result.summary.changed.total).toBeGreaterThanOrEqual(1);
  });

  it('resolves default new_branch', () => {
    const result = handler(db, { old_branch: 'v1' });
    // Should auto-resolve to v2
    expect(result.new_branch).toBe('v2');
  });

  it('throws when no other branch exists', () => {
    const singleBranchDb = openDb(':memory:');
    try {
      singleBranchDb.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'a.ts', 'only', 'typescript', '')`).run();
      singleBranchDb.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, is_exported) VALUES (1, 1, 'f', 'function', 1, 1, 1)`).run();
      expect(() => handler(singleBranchDb, { old_branch: 'only' })).toThrow(/Cannot resolve new_branch/);
    } finally {
      singleBranchDb.close();
    }
  });

  it('filters by path_prefix', () => {
    const result = handler(db, { old_branch: 'v1', new_branch: 'v2', path_prefix: 'src/' });
    // All results should have paths starting with src/
    for (const entry of [...result.added, ...result.removed]) {
      expect(entry.file_path.startsWith('src/')).toBe(true);
    }
  });

  it('filters by kind', () => {
    const result = handler(db, { old_branch: 'v1', new_branch: 'v2', kind: 'function' });
    for (const entry of [...result.added, ...result.removed]) {
      expect(entry.kind).toBe('function');
    }
  });

  it('handles empty DB', () => {
    const emptyDb = openDb(':memory:');
    try {
      emptyDb.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'a.ts', 'a', 'typescript', '')`).run();
      emptyDb.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'a.ts', 'b', 'typescript', '')`).run();
      const result = handler(emptyDb, { old_branch: 'a', new_branch: 'b' });
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
      expect(result.changed).toHaveLength(0);
    } finally {
      emptyDb.close();
    }
  });

  it('compares effective replacement rows for each branch', () => {
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source, layer, generation)
       VALUES (3, 'src/api.ts', 'v2', 'typescript', 'overlay', 'overlay', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO symbols
         (id, file_id, name, kind, start_line, end_line, signature, is_exported, layer, generation)
       VALUES (5, 3, 'getUser', 'function', 0, 4, '(id: boolean): User', 1, 'overlay', 0),
              (6, 3, 'overlayOnly', 'function', 5, 9, '(): void', 1, 'overlay', 0)`,
    ).run();
    db.prepare(
      "INSERT INTO dirty_files (path, branch, overlay_gen) VALUES ('src/api.ts', 'v2', 0)",
    ).run();

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });
    expect(result.added.map((entry) => entry.name)).toEqual(['overlayOnly']);
    expect(result.changed).toEqual([
      expect.objectContaining({
        name: 'getUser',
        old_signature: '(id: number): User',
        new_signature: '(id: boolean): User',
      }),
    ]);
    expect(result.added.map((entry) => entry.name)).not.toContain('createUser');
  });

  it('treats a dirty path with no overlay row as deleted on that branch', () => {
    db.prepare(
      "INSERT INTO dirty_files (path, branch, overlay_gen) VALUES ('src/api.ts', 'v2', 0)",
    ).run();

    const result = handler(db, { old_branch: 'v1', new_branch: 'v2' });
    expect(result.added).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.removed.map((entry) => entry.name).sort())
      .toEqual(['deleteUser', 'getUser']);
  });
});
