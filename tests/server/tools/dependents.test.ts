import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/dependents.js';

function seedDependentsData(db: Database.Database) {
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/core.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/consumer.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/other.ts', 'main', 'typescript', '')`).run();

  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'coreFunc', 'function', 1, 5)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'consumerFunc', 'function', 1, 5)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'otherFunc', 'function', 1, 3)`).run();

  // consumerFunc calls coreFunc
  db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (2, 2, 1, 'coreFunc', 2, 'resolved')`).run();

  // consumer.ts imports core.ts
  db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (2, './core', 1)`).run();
}

describe('lore_dependents toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_dependents');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.required).toContain('query');
    expect(toolDef.inputSchema.required).toContain('kind');
  });
});

describe('lore_dependents handler — symbol', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDependentsData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finds callers of a symbol', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(result.target.name).toBe('coreFunc');
    expect(result.dependents.callers.length).toBeGreaterThanOrEqual(1);
  });

  it('returns importers for a symbol', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    // Should find importers of the file containing coreFunc
    expect(result.dependents.importers.length).toBeGreaterThanOrEqual(1);
  });

  it('returns total_count', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(result.total_count).toBeGreaterThanOrEqual(1);
  });

  it('supports compact mode', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol', compact: true });
    if (result.dependents.callers.length > 0) {
      const caller = result.dependents.callers[0] as any;
      // compact callers omit line, character, resolution_method
      expect(caller.line).toBeUndefined();
    }
  });

  it('throws for unknown symbol', () => {
    expect(() => handler(db, { query: 'nonExistent', kind: 'symbol' })).toThrow(/No symbol found/);
  });

  it('returns depth_used', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(result.depth_used).toBeDefined();
    expect(typeof result.depth_used).toBe('number');
  });

  it('returns truncated flag', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(typeof result.truncated).toBe('boolean');
  });
});

describe('lore_dependents handler — file', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDependentsData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finds importers of a file', () => {
    const result = handler(db, { query: 'src/core.ts', kind: 'file' });
    expect(result.target.name).toBe('src/core.ts');
    expect(result.target.kind).toBe('file');
    expect(result.dependents.importers.length).toBeGreaterThanOrEqual(1);
  });

  it('finds callers from other files', () => {
    const result = handler(db, { query: 'src/core.ts', kind: 'file' });
    expect(result.dependents.callers.length).toBeGreaterThanOrEqual(1);
  });

  it('throws for unknown file', () => {
    expect(() => handler(db, { query: 'not/a/real/path.ts', kind: 'file' })).toThrow(/No file found/);
  });
});

describe('lore_dependents handler — ambiguous symbol', () => {
  it('throws for ambiguous symbol name', () => {
    const db = openDb(':memory:');
    try {
      db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'a.ts', 'main', 'typescript', '')`).run();
      db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'b.ts', 'main', 'typescript', '')`).run();
      db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'dup', 'function', 1, 1)`).run();
      db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'dup', 'function', 1, 1)`).run();
      expect(() => handler(db, { query: 'dup', kind: 'symbol' })).toThrow(/Ambiguous/);
    } finally {
      db.close();
    }
  });
});
