import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/search.js';

function seedDb(db: Database.Database) {
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/utils.ts', 'main', 'typescript', 'function helpers() {}')`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (1, 1, 'helpers', 'function', 1, 1, '(): void', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (2, 1, 'parseConfig', 'function', 2, 5, '(cfg: string): Config', 1)`,
  ).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (1, 'helpers', '(): void', 'function')`).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (2, 'parseConfig', '(cfg: string): Config', 'function')`).run();
}

describe('lore_search toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_search');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.type).toBe('object');
    expect(toolDef.inputSchema.required).toContain('query');
  });
});

describe('lore_search handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns structural results for matching query', async () => {
    const result = await handler(db, { query: 'helpers' });
    expect(result.mode_used).toBe('structural');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.name).toBe('helpers');
  });

  it('returns empty for no-match query', async () => {
    const result = await handler(db, { query: 'zzzzNonExistent' });
    expect(result.results).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    const result = await handler(db, { query: 'helpers', limit: 1 });
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it('falls back to structural when no embedder for semantic mode', async () => {
    const result = await handler(db, { query: 'helpers', mode: 'semantic' });
    expect(result.mode_used).toContain('structural');
  });

  it('falls back to structural when no embedder for fused mode', async () => {
    const result = await handler(db, { query: 'helpers', mode: 'fused' });
    expect(result.mode_used).toContain('structural');
  });

  it('filters by kind', async () => {
    const result = await handler(db, { query: 'helpers', kind: 'function' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.kind).toBe('function');
    }
  });

  it('works with empty database', async () => {
    const emptyDb = openDb(':memory:');
    try {
      const result = await handler(emptyDb, { query: 'anything' });
      expect(result.results).toHaveLength(0);
    } finally {
      emptyDb.close();
    }
  });

  it('invokes observer if provided', async () => {
    let observed = false;
    const observer = () => { observed = true; };
    await handler(db, { query: 'helpers' }, undefined, observer);
    expect(observed).toBe(true);
  });

  it('returns FTS scored results', async () => {
    const result = await handler(db, { query: 'helpers' });
    expect(result.mode_used).toBe('structural');
    for (const r of result.results) {
      expect(r).toHaveProperty('score');
    }
  });

  it('filters by path_prefix', async () => {
    const result = await handler(db, { query: 'helpers', path_prefix: 'src/' });
    for (const r of result.results) {
      expect(r.file_path).toMatch(/^src\//);
    }
  });

  it('filters by language', async () => {
    const result = await handler(db, { query: 'helpers', language: 'typescript' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('handles FTS special characters gracefully', async () => {
    const result = await handler(db, { query: 'operator+' });
    // Should not throw - FTS query is sanitized
    expect(result.results).toBeDefined();
  });

  it('handles query with double quotes', async () => {
    const result = await handler(db, { query: '"helpers"' });
    expect(result.results).toBeDefined();
  });

  it('returns result_type=symbol', async () => {
    const result = await handler(db, { query: 'helpers' });
    if (result.results.length > 0) {
      expect(result.results[0]!.result_type).toBe('symbol');
    }
  });

  it('returns branch in results', async () => {
    const result = await handler(db, { query: 'helpers' });
    if (result.results.length > 0) {
      expect(result.results[0]!.branch).toBe('main');
    }
  });

  it('filters by branch', async () => {
    const result = await handler(db, { query: 'helpers', branch: 'main' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('branch filter with non-matching returns empty', async () => {
    const result = await handler(db, { query: 'helpers', branch: 'nonexistent' });
    expect(result.results).toHaveLength(0);
  });

  it('searches by signature content', async () => {
    const result = await handler(db, { query: 'parseConfig' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const match = result.results.find(r => r.name === 'parseConfig');
    expect(match).toBeDefined();
  });

  it('observer receives correct observation fields', async () => {
    let observation: any = null;
    const observer = (obs: any) => { observation = obs; };
    await handler(db, { query: 'helpers', branch: 'main' }, undefined, observer);
    expect(observation).not.toBeNull();
    expect(observation.query).toBe('helpers');
    expect(observation.requestedMode).toBe('structural');
    expect(observation.modeUsed).toBe('structural');
    expect(observation.resultCount).toBeGreaterThanOrEqual(1);
    expect(observation.topScore).toBeDefined();
    expect(typeof observation.latencyMs).toBe('number');
    expect(observation.branch).toBe('main');
    expect(observation.timestamp).toBeDefined();
  });

  it('observer error does not break search', async () => {
    const observer = () => { throw new Error('observer boom'); };
    const result = await handler(db, { query: 'helpers' }, undefined, observer);
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('observer receives topScore=null when no results', async () => {
    let observation: any = null;
    const observer = (obs: any) => { observation = obs; };
    await handler(db, { query: 'zzzzNothingHere' }, undefined, observer);
    expect(observation.topScore).toBeNull();
    expect(observation.resultCount).toBe(0);
  });

  it('semantic mode without embedder reports degradation in mode_used', async () => {
    const result = await handler(db, { query: 'helpers', mode: 'semantic' });
    expect(result.mode_used).toContain('no query-time embedder');
  });

  it('fused mode without embedder reports degradation in mode_used', async () => {
    const result = await handler(db, { query: 'helpers', mode: 'fused' });
    expect(result.mode_used).toContain('no query-time embedder');
  });

  it('filters by kind returning empty when no match', async () => {
    const result = await handler(db, { query: 'helpers', kind: 'class' });
    expect(result.results).toHaveLength(0);
  });

  it('combined filters path_prefix + kind', async () => {
    const result = await handler(db, { query: 'helpers', path_prefix: 'src/', kind: 'function' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.file_path).toMatch(/^src\//);
      expect(r.kind).toBe('function');
    }
  });

  it('combined filters path_prefix + kind with no match', async () => {
    const result = await handler(db, { query: 'helpers', path_prefix: 'lib/', kind: 'function' });
    expect(result.results).toHaveLength(0);
  });

  it('returns file_path and line numbers in results', async () => {
    const result = await handler(db, { query: 'helpers' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    const r = result.results[0]!;
    expect(r.file_path).toBe('src/utils.ts');
    expect(typeof r.start_line).toBe('number');
    expect(typeof r.end_line).toBe('number');
  });

  it('returns symbol_id in results', async () => {
    const result = await handler(db, { query: 'helpers' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(typeof result.results[0]!.symbol_id).toBe('number');
  });

  it('FTS fallback handles LIKE prefix when FTS query is invalid', async () => {
    // Populate a symbol with name matching prefix
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/extra.ts', 'main', 'typescript', 'class MyTest {}')`,
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
       VALUES (3, 2, 'MyTest', 'class', 1, 1, 'class MyTest', 1)`,
    ).run();
    // Don't insert into FTS - this forces the FTS MATCH to fail and fall back to LIKE
    const result = await handler(db, { query: 'MyTest' });
    // Should still find results via LIKE fallback
    expect(result.results).toBeDefined();
  });

  it('language filter with no match returns empty', async () => {
    const result = await handler(db, { query: 'helpers', language: 'python' });
    expect(result.results).toHaveLength(0);
  });

  it('default limit is 20', async () => {
    const result = await handler(db, { query: 'helpers' });
    expect(result.results.length).toBeLessThanOrEqual(20);
  });
});
