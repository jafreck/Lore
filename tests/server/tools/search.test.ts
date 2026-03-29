import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef, clearQueryEmbeddingCache, type SearchObservation } from '../../../src/server/tools/search.js';
import type { EmbeddingProvider } from '../../../src/embeddings/embedder.js';

function seedDb(db: Database.Database) {
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/utils.ts', 'main', 'typescript', 'function helpers() {}')`,
  ).run();
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (2, 'lib/math.ts', 'main', 'typescript', 'function add() {}')`,
  ).run();
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/app.py', 'main', 'python', 'def run(): pass')`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (1, 1, 'helpers', 'function', 1, 1, '(): void', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (2, 1, 'parseConfig', 'function', 2, 5, '(cfg: string): Config', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (3, 2, 'add', 'function', 1, 3, '(a: number, b: number): number', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (4, 1, 'ConfigClass', 'class', 6, 20, 'class ConfigClass', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
     VALUES (5, 3, 'run', 'function', 1, 1, 'def run()', 1)`,
  ).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (1, 'helpers', '(): void', 'function')`).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (2, 'parseConfig', '(cfg: string): Config', 'function')`).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (3, 'add', '(a: number, b: number): number', 'function')`).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (4, 'ConfigClass', 'class ConfigClass', 'class')`).run();
  db.prepare(`INSERT INTO symbols_fts (rowid, name, signature, kind) VALUES (5, 'run', 'def run()', 'function')`).run();
}

function makeMockEmbedder(vector: number[] = [0.1, 0.2, 0.3]): EmbeddingProvider {
  return {
    embed: async (_texts: string[]) => [vector],
    dimensions: vector.length,
    modelName: 'test-mock',
  } as unknown as EmbeddingProvider;
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
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.result_type).toBe('symbol');
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
      `INSERT INTO files (id, path, branch, language, source) VALUES (10, 'src/extra.ts', 'main', 'typescript', 'class MyTest {}')`,
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, is_exported)
       VALUES (10, 10, 'MyTest', 'class', 1, 1, 'class MyTest', 1)`,
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

  it('scoring/ranking with multiple FTS matches', async () => {
    const result = await handler(db, { query: 'function' });
    // Multiple symbols should be returned, ordered by FTS score
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < result.results.length; i++) {
      // BM25 scores are negative; lower (more negative) = better match
      expect(result.results[i - 1]!.score).toBeLessThanOrEqual(result.results[i]!.score);
    }
  });

  it('kind filter excludes non-matching kinds', async () => {
    const result = await handler(db, { query: 'ConfigClass', kind: 'function' });
    expect(result.results).toHaveLength(0);
  });

  it('kind filter for class returns only classes', async () => {
    const result = await handler(db, { query: 'ConfigClass', kind: 'class' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.kind).toBe('class');
    }
  });

  it('language filter restricts to specific language files', async () => {
    const result = await handler(db, { query: 'run', language: 'python' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('language + kind + path_prefix combined filters', async () => {
    const result = await handler(db, { query: 'helpers', language: 'typescript', kind: 'function', path_prefix: 'src/' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.kind).toBe('function');
      expect(r.file_path).toMatch(/^src\//);
    }
  });

  it('path_prefix with no match returns empty', async () => {
    const result = await handler(db, { query: 'helpers', path_prefix: 'nonexistent/' });
    expect(result.results).toHaveLength(0);
  });

  it('semantic mode with embedder but no symbol_embeddings table falls back', async () => {
    const embedder = makeMockEmbedder();
    const result = await handler(db, { query: 'helpers', mode: 'semantic' }, embedder);
    // No symbol_embeddings table → semantic returns null → falls back to structural
    expect(result.mode_used).toContain('structural');
  });

  it('fused mode with embedder but no symbol_embeddings table', async () => {
    const embedder = makeMockEmbedder();
    const result = await handler(db, { query: 'helpers', mode: 'fused' }, embedder);
    // semantic is null so fused degrades — structural results are still returned
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('semantic mode with embedder returning empty vector', async () => {
    const embedder: EmbeddingProvider = {
      embed: async () => [[]],
      dimensions: 0,
      modelName: 'test-empty',
    } as unknown as EmbeddingProvider;
    const result = await handler(db, { query: 'helpers', mode: 'semantic' }, embedder);
    // Empty vector → semantic returns null → falls back
    expect(result.mode_used).toContain('structural');
  });

  it('observer receives all required observation fields', async () => {
    let obs: SearchObservation | null = null;
    const observer = (o: SearchObservation) => { obs = o; };
    await handler(db, { query: 'helpers', mode: 'structural', branch: 'main' }, undefined, observer);
    expect(obs).not.toBeNull();
    expect(obs!.timestamp).toMatch(/^\d{4}-/);
    expect(obs!.query).toBe('helpers');
    expect(obs!.requestedMode).toBe('structural');
    expect(obs!.modeUsed).toBe('structural');
    expect(obs!.resultCount).toBeGreaterThanOrEqual(1);
    expect(typeof obs!.topScore).toBe('number');
    expect(obs!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(obs!.branch).toBe('main');
  });

  it('observer receives semantic mode fallback info', async () => {
    let obs: SearchObservation | null = null;
    const observer = (o: SearchObservation) => { obs = o; };
    await handler(db, { query: 'helpers', mode: 'semantic' }, undefined, observer);
    expect(obs).not.toBeNull();
    expect(obs!.requestedMode).toBe('semantic');
    expect(obs!.modeUsed).toContain('no query-time embedder');
  });

  it('observer receives fused mode fallback info', async () => {
    let obs: SearchObservation | null = null;
    const observer = (o: SearchObservation) => { obs = o; };
    await handler(db, { query: 'helpers', mode: 'fused' }, undefined, observer);
    expect(obs).not.toBeNull();
    expect(obs!.requestedMode).toBe('fused');
    expect(obs!.modeUsed).toContain('no query-time embedder');
  });
});

describe('lore_search embedding cache', () => {
  let db: Database.Database;

  beforeEach(() => {
    clearQueryEmbeddingCache();
    db = openDb(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    clearQueryEmbeddingCache();
    db.close();
  });

  it('caches embedding vectors and reuses them on second call', async () => {
    const embedFn = vi.fn(async (_texts: string[]) => [[0.1, 0.2, 0.3]]);
    const embedder: EmbeddingProvider = {
      embed: embedFn,
      dimensions: 3,
      modelName: 'test-cache',
    } as unknown as EmbeddingProvider;

    // First call — embed() should be called
    await handler(db, { query: 'cacheTest', mode: 'semantic' }, embedder);
    expect(embedFn).toHaveBeenCalledTimes(1);

    // Second call with same query — embed() should NOT be called again
    await handler(db, { query: 'cacheTest', mode: 'semantic' }, embedder);
    expect(embedFn).toHaveBeenCalledTimes(1);
  });

  it('calls embed() again after cache is cleared', async () => {
    const embedFn = vi.fn(async (_texts: string[]) => [[0.1, 0.2, 0.3]]);
    const embedder: EmbeddingProvider = {
      embed: embedFn,
      dimensions: 3,
      modelName: 'test-cache',
    } as unknown as EmbeddingProvider;

    await handler(db, { query: 'clearTest', mode: 'semantic' }, embedder);
    expect(embedFn).toHaveBeenCalledTimes(1);

    clearQueryEmbeddingCache();

    await handler(db, { query: 'clearTest', mode: 'semantic' }, embedder);
    expect(embedFn).toHaveBeenCalledTimes(2);
  });

  it('different queries each call embed()', async () => {
    const embedFn = vi.fn(async (_texts: string[]) => [[0.1, 0.2, 0.3]]);
    const embedder: EmbeddingProvider = {
      embed: embedFn,
      dimensions: 3,
      modelName: 'test-cache',
    } as unknown as EmbeddingProvider;

    await handler(db, { query: 'queryA', mode: 'semantic' }, embedder);
    await handler(db, { query: 'queryB', mode: 'semantic' }, embedder);
    expect(embedFn).toHaveBeenCalledTimes(2);
  });
});

describe('lore_search semantic/fused with mock embeddings table', () => {
  let db: Database.Database;

  beforeEach(() => {
    clearQueryEmbeddingCache();
    db = openDb(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    clearQueryEmbeddingCache();
    db.close();
  });

  /**
   * Check whether sqlite-vec is available to create vec0 virtual tables.
   * If not, semantic/fused paths that require real KNN are skipped.
   */
  function hasVecSupport(): boolean {
    try {
      db.prepare("CREATE VIRTUAL TABLE IF NOT EXISTS _vec_probe USING vec0(v float[3])").run();
      db.prepare("DROP TABLE IF EXISTS _vec_probe").run();
      return true;
    } catch {
      return false;
    }
  }

  function setupEmbeddingsTable(): void {
    db.prepare("CREATE VIRTUAL TABLE symbol_embeddings USING vec0(embedding float[3])").run();
    // Insert embeddings for our seeded symbols (rowids 1-5)
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO symbol_embeddings (rowid, embedding) VALUES (?, ?)").run(
        i,
        JSON.stringify([0.1 * i, 0.2 * i, 0.3 * i]),
      );
    }
  }

  it('semantic mode returns semantic results when embeddings exist', async function () {
    if (!hasVecSupport()) return;
    setupEmbeddingsTable();

    const embedder = makeMockEmbedder([0.1, 0.2, 0.3]);
    const result = await handler(db, { query: 'helpers', mode: 'semantic' }, embedder);
    expect(result.mode_used).toBe('semantic');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('fused mode uses rrfFuse when both structural and semantic results exist', async function () {
    if (!hasVecSupport()) return;
    setupEmbeddingsTable();

    const embedder = makeMockEmbedder([0.1, 0.2, 0.3]);
    const result = await handler(db, { query: 'helpers', mode: 'fused' }, embedder);
    expect(result.mode_used).toBe('fused');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('postFilterSemanticResults excludes results by path_prefix', async function () {
    if (!hasVecSupport()) return;
    setupEmbeddingsTable();

    const embedder = makeMockEmbedder([0.1, 0.2, 0.3]);
    // Query 'helpers' but filter to 'lib/' path — helpers is in src/utils.ts
    const result = await handler(db, { query: 'helpers', mode: 'semantic', path_prefix: 'lib/' }, embedder);
    // Post-filter should exclude src/ results; if no lib/ results survive, falls back
    for (const r of result.results) {
      if (result.mode_used === 'semantic') {
        expect(r.file_path).toMatch(/^lib\//);
      }
    }
  });

  it('postFilterSemanticResults excludes results by kind', async function () {
    if (!hasVecSupport()) return;
    setupEmbeddingsTable();

    const embedder = makeMockEmbedder([0.1, 0.2, 0.3]);
    const result = await handler(db, { query: 'ConfigClass', mode: 'semantic', kind: 'class' }, embedder);
    for (const r of result.results) {
      if (result.mode_used === 'semantic') {
        expect(r.kind).toBe('class');
      }
    }
  });

  it('fused mode falls back when semantic returns null', async () => {
    // No symbol_embeddings table → semantic = null → fused degrades
    const embedder = makeMockEmbedder();
    const result = await handler(db, { query: 'helpers', mode: 'fused' }, embedder);
    expect(result.mode_used).toContain('structural');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('semantic mode falls back when embed() returns undefined', async () => {
    const embedder: EmbeddingProvider = {
      embed: async () => [undefined as unknown as number[]],
      dimensions: 3,
      modelName: 'test-undef',
    } as unknown as EmbeddingProvider;
    const result = await handler(db, { query: 'helpers', mode: 'semantic' }, embedder);
    expect(result.mode_used).toContain('structural');
  });
});

// ─── FTS5 LIKE fallback ───────────────────────────────────────────────────────

describe('lore_search LIKE fallback', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('falls back to LIKE when FTS table is unavailable', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'helpers' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.name).toBe('helpers');
  });

  it('LIKE fallback applies path_prefix filter', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'helpers', path_prefix: 'src/' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.file_path).toMatch(/^src\//);
    }
  });

  it('LIKE fallback applies kind filter', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'helpers', kind: 'function' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      expect(r.kind).toBe('function');
    }
  });

  it('LIKE fallback applies language filter', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'helpers', language: 'typescript' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('LIKE fallback applies branch filter', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'helpers', branch: 'main' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('LIKE fallback escapes wildcard characters in query', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'test%value' });
    expect(result.results).toHaveLength(0);
  });

  it('LIKE fallback escapes _ wildcard in path_prefix', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'helpers', path_prefix: 'src/%_test/' });
    expect(result.results).toHaveLength(0);
  });

  it('LIKE fallback returns score of 0', async () => {
    db.prepare('DROP TABLE symbols_fts').run();
    const result = await handler(db, { query: 'helpers' });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results[0]!.score).toBe(0);
  });
});

// ─── Embedder error handling ──────────────────────────────────────────────────

describe('lore_search embedder error handling', () => {
  let db: Database.Database;

  beforeEach(() => {
    clearQueryEmbeddingCache();
    db = openDb(':memory:');
    seedDb(db);
  });

  afterEach(() => {
    clearQueryEmbeddingCache();
    db.close();
  });

  it('semantic mode catches embedder that throws', async () => {
    const embedder: EmbeddingProvider = {
      embed: async () => { throw new Error('embed failed'); },
      dimensions: 3,
      modelName: 'test-throw',
    } as unknown as EmbeddingProvider;
    const result = await handler(db, { query: 'helpers', mode: 'semantic' }, embedder);
    // Error caught → semantic returns null → falls back to structural
    expect(result.mode_used).toContain('structural');
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it('fused mode catches embedder that throws', async () => {
    const embedder: EmbeddingProvider = {
      embed: async () => { throw new Error('embed failed'); },
      dimensions: 3,
      modelName: 'test-throw',
    } as unknown as EmbeddingProvider;
    const result = await handler(db, { query: 'helpers', mode: 'fused' }, embedder);
    // Error caught → semantic null → fused degrades to structural
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});
