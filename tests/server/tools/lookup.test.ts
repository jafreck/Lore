import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef, type LookupArgs } from '../../../src/server/tools/lookup.js';

function seedDb(db: Database.Database) {
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/main.ts', 'main', 'typescript', 'const x = 1;\nfunction foo() {}\nclass Bar {}')`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (1, 1, 'foo', 'function', 2, 2, '(): void', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (2, 1, 'Bar', 'class', 3, 3, 'class Bar', 1)`,
  ).run();
  // FTS index
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (1, 'foo', '(): void', 'function')`).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (2, 'Bar', 'class Bar', 'class')`).run();
}

describe('lore_lookup toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_lookup');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.type).toBe('object');
    expect(toolDef.inputSchema.required).toContain('kind');
    expect(toolDef.inputSchema.required).toContain('query');
  });
});

describe('lore_lookup handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('looks up a symbol by exact name', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'foo' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const first = result.results[0] as any;
    expect(first.name).toBe('foo');
    expect(first.kind).toBe('function');
  });

  it('looks up a file by path', async () => {
    const result = await handler(db, { kind: 'file', query: 'src/main.ts' });
    expect(result.results.length).toBe(1);
    const first = result.results[0] as any;
    expect(first.path).toBe('src/main.ts');
  });

  it('returns empty for unknown symbol', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'nonexistent' });
    expect(result.results).toHaveLength(0);
  });

  it('returns empty for unknown file', async () => {
    const result = await handler(db, { kind: 'file', query: 'no/such/file.ts' });
    expect(result.results).toHaveLength(0);
  });

  it('supports match_mode=contains', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'oo', match_mode: 'contains' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const names = result.results.map((r: any) => r.name);
    expect(names).toContain('foo');
  });

  it('supports match_mode=prefix', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'Ba', match_mode: 'prefix' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const names = result.results.map((r: any) => r.name);
    expect(names).toContain('Bar');
  });

  it('supports symbol_kind filter', async () => {
    const result = await handler(db, { kind: 'symbol', query: '', symbol_kind: 'class' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect((r as any).kind).toBe('class');
    }
  });

  it('lists symbols when query is empty', async () => {
    const result = await handler(db, { kind: 'symbol', query: '' });
    expect(result.results.length).toBeGreaterThanOrEqual(2);
  });

  it('respects limit on empty query', async () => {
    const result = await handler(db, { kind: 'symbol', query: '', limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  it('returns empty on empty DB', async () => {
    const emptyDb = openDb(':memory:');
    try {
      const result = await handler(emptyDb, { kind: 'symbol', query: 'anything' });
      expect(result.results).toHaveLength(0);
    } finally {
      emptyDb.close();
    }
  });

  it('handles semantic mode gracefully without embedder', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'foo', mode: 'semantic' });
    // Should fall back to exact search
    expect(result.results.length).toBeGreaterThanOrEqual(0);
  });

  it('handles fused mode gracefully without embedder', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'foo', mode: 'fused' });
    expect(result.results.length).toBeGreaterThanOrEqual(0);
  });

  it('looks up file listing with empty query', async () => {
    const result = await handler(db, { kind: 'file', query: '' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('supports path_prefix filter', async () => {
    const result = await handler(db, { kind: 'symbol', query: '', path_prefix: 'src/' });
    for (const r of result.results) {
      expect((r as any).file_path).toMatch(/^src\//);
    }
  });

  it('supports language filter', async () => {
    const result = await handler(db, { kind: 'symbol', query: '', language: 'typescript' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('supports offset parameter', async () => {
    const all = await handler(db, { kind: 'symbol', query: '' });
    const offset = await handler(db, { kind: 'symbol', query: '', offset: 1 });
    expect(offset.results.length).toBeLessThan(all.results.length);
  });

  it('exact mode returns mode_used=exact', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'foo', mode: 'exact' });
    expect(result.mode_used).toBe('exact');
  });

  it('semantic mode without embedder falls back', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'foo', mode: 'semantic' });
    expect(result.mode_used).toContain('exact');
  });

  it('fused mode without embedder falls back', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'foo', mode: 'fused' });
    expect(result.mode_used).toContain('exact');
  });

  it('includes external symbols for exact match', async () => {
    // Seed an external symbol
    db.prepare(
      `INSERT INTO external_symbols (id, symbol_name, symbol_kind, package_name, definition_path, definition_uri)
       VALUES (1, 'extFn', 'function', 'lodash', 'lodash/index.d.ts', 'file:///lodash/index.d.ts')`,
    ).run();
    const result = await handler(db, { kind: 'symbol', query: 'extFn' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('file lookup with branch filter', async () => {
    const result = await handler(db, { kind: 'file', query: 'src/main.ts', branch: 'main' });
    expect(result.results.length).toBe(1);
  });

  it('file lookup with wrong branch returns empty', async () => {
    const result = await handler(db, { kind: 'file', query: 'src/main.ts', branch: 'nonexistent' });
    expect(result.results).toHaveLength(0);
  });

  it('excludes external symbols when match_mode is not exact', async () => {
    db.prepare(
      `INSERT INTO external_symbols (id, symbol_name, symbol_kind, package_name, definition_path, definition_uri)
       VALUES (1, 'fooExt', 'function', 'lodash', 'lodash/index.d.ts', 'file:///lodash/index.d.ts')`,
    ).run();
    const result = await handler(db, { kind: 'symbol', query: 'foo', match_mode: 'contains' });
    // external symbols are excluded for non-exact match_mode
    const names = result.results.map((r: any) => r.name ?? r.symbol_name);
    expect(names).not.toContain('fooExt');
  });

  it('excludes external symbols when path_prefix is set', async () => {
    db.prepare(
      `INSERT INTO external_symbols (id, symbol_name, symbol_kind, package_name, definition_path, definition_uri)
       VALUES (2, 'foo', 'function', 'lodash', 'lodash/index.d.ts', 'file:///lodash/index.d.ts')`,
    ).run();
    const result = await handler(db, { kind: 'symbol', query: 'foo', path_prefix: 'src/' });
    // external symbols are excluded when path_prefix is present
    const hasExternal = result.results.some((r: any) => r.package_name === 'lodash');
    expect(hasExternal).toBe(false);
  });

  it('excludes external symbols when language filter is set', async () => {
    db.prepare(
      `INSERT INTO external_symbols (id, symbol_name, symbol_kind, package_name, definition_path, definition_uri)
       VALUES (3, 'foo', 'function', 'lodash', 'lodash/index.d.ts', 'file:///lodash/index.d.ts')`,
    ).run();
    const result = await handler(db, { kind: 'symbol', query: 'foo', language: 'typescript' });
    const hasExternal = result.results.some((r: any) => r.package_name === 'lodash');
    expect(hasExternal).toBe(false);
  });

  it('external symbols filtered by symbol_kind', async () => {
    db.prepare(
      `INSERT INTO external_symbols (id, symbol_name, symbol_kind, package_name, definition_path, definition_uri)
       VALUES (4, 'extClass', 'class', 'external-pkg', 'pkg/index.d.ts', 'file:///pkg/index.d.ts')`,
    ).run();
    const result = await handler(db, { kind: 'symbol', query: 'extClass', symbol_kind: 'function' });
    // Should not include 'extClass' since it's a class, not a function
    const hasExternal = result.results.some((r: any) => (r.name ?? r.symbol_name) === 'extClass');
    expect(hasExternal).toBe(false);
  });

  it('returns mode_used for empty query listing', async () => {
    const result = await handler(db, { kind: 'symbol', query: '' });
    expect(result.mode_used).toBe('exact');
  });

  it('semantic mode with mock embedder returning null vectors falls back', async () => {
    const mockEmbedder = {
      embed: async () => [[]],
      dimensions: 3,
      modelName: 'test',
    };
    const result = await handler(db, { kind: 'symbol', query: 'foo', mode: 'semantic' }, mockEmbedder as any);
    expect(result.mode_used).toContain('fallback');
  });

  it('fused mode with mock embedder returning null vectors falls back', async () => {
    const mockEmbedder = {
      embed: async () => [[]],
      dimensions: 3,
      modelName: 'test',
    };
    const result = await handler(db, { kind: 'symbol', query: 'foo', mode: 'fused' }, mockEmbedder as any);
    expect(result.mode_used).toContain('fallback');
  });

  it('branch filter applies to symbol listing', async () => {
    const result = await handler(db, { kind: 'symbol', query: '', branch: 'main' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('branch filter with nonexistent branch returns empty', async () => {
    const result = await handler(db, { kind: 'symbol', query: '', branch: 'nonexistent' });
    expect(result.results).toHaveLength(0);
  });
});
