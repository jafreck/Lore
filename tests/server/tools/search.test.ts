import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { handler, toolDef, type SearchArgs, type SearchResult, type SearchObservation, type SearchObserver } from '../../../src/server/tools/search.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const esmRequire = createRequire(import.meta.url);

function createTestDb(includeEnrichmentColumns = false): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const symbolEnrichmentColumns = includeEnrichmentColumns
    ? `,
       resolved_type_signature TEXT,
       resolved_return_type    TEXT,
       definition_uri          TEXT,
       definition_path         TEXT`
    : '';
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
      kind        TEXT    NOT NULL DEFAULT 'function',
      start_line  INTEGER NOT NULL DEFAULT 1,
      end_line    INTEGER NOT NULL DEFAULT 10,
      signature   TEXT,
      doc_comment TEXT${symbolEnrichmentColumns}
    );
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, kind, content=symbols, content_rowid=id);
  `);
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, 'typescript');
  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function',
  enrichment?: {
    resolvedTypeSignature?: string | null;
    resolvedReturnType?: string | null;
    definitionUri?: string | null;
    definitionPath?: string | null;
  },
): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    )
    .run(fileId, name, kind);
  const rowid = result.lastInsertRowid as number;
  db.prepare('INSERT INTO symbols_fts(rowid, name, kind) VALUES (?, ?, ?)').run(rowid, name, kind);
  if (enrichment) {
    try {
      db.prepare(
        `UPDATE symbols
         SET resolved_type_signature = ?, resolved_return_type = ?, definition_uri = ?, definition_path = ?
         WHERE id = ?`,
      ).run(
        enrichment.resolvedTypeSignature ?? null,
        enrichment.resolvedReturnType ?? null,
        enrichment.definitionUri ?? null,
        enrichment.definitionPath ?? null,
        rowid,
      );
    } catch {
      // Older fixture schemas intentionally omit enrichment columns.
    }
  }
  return rowid;
}

function loadVectorTables(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE symbol_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
      embedding FLOAT[${dims}]
    );
  `);
}

function insertSymbolEmbedding(db: Database.Database, symbolId: number, embedding: number[]): void {
  db.prepare(
    'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(symbolId, JSON.stringify(embedding));
}

describe('search toolDef', () => {
  it('should expose optional symbol and doc filter fields in input schema', () => {
    const props = toolDef.inputSchema.properties as Record<string, { type?: string; description?: string }>;

    expect(props.path_prefix?.type).toBe('string');
    expect(props.path_prefix?.description).toContain('source file path prefix');
    expect(props.language?.type).toBe('string');
    expect(props.language?.description).toContain('source language filter');
    expect(props.kind?.type).toBe('string');
    expect(props.kind?.description).toContain('symbol kind filter');
    expect(toolDef.inputSchema.required).toEqual(['query']);
  });
});

// ─── handler (structural mode) ────────────────────────────────────────────────

describe('search handler – structural mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, featId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
  });

  it('should return results matching query in structural mode', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    expect(result.mode_used).toBe('structural');
    expect(result.results.length).toBeGreaterThan(0);
    result.results.forEach((r) => expect(r.name).toBe('parseConfig'));
  });

  it('should expose null enrichment metadata fields when enrichment columns are absent', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    expect(result.results.length).toBeGreaterThan(0);
    result.results.forEach((row) => {
      expect(row.resolved_type_signature).toBeNull();
      expect(row.resolved_return_type).toBeNull();
      expect(row.definition_uri).toBeNull();
      expect(row.definition_path).toBeNull();
    });
  });

  it('should include persisted enrichment metadata fields when present', async () => {
    db = createTestDb(true);
    const fileId = insertFile(db, 'src/main.ts', 'main');
    insertSymbol(
      db,
      fileId,
      'parseConfig',
      'function',
      {
        resolvedTypeSignature: 'function parseConfig(input: string): ParseResult',
        resolvedReturnType: 'ParseResult',
        definitionUri: 'file:///repo/src/parser.ts',
        definitionPath: '/repo/src/parser.ts',
      },
    );

    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      resolved_type_signature: 'function parseConfig(input: string): ParseResult',
      resolved_return_type: 'ParseResult',
      definition_uri: 'file:///repo/src/parser.ts',
      definition_path: '/repo/src/parser.ts',
    });
  });

  it('should default to structural mode when mode is omitted', async () => {
    const result = await handler(db, { query: 'renderPage' });
    expect(result.mode_used).toBe('structural');
  });

  it('should include branch field on each result', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    result.results.forEach((r) => expect(typeof r.branch).toBe('string'));
  });

  it('should tag structural results with symbol result_type', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    expect(result.results.every((row) => row.result_type === 'symbol')).toBe(true);
  });

  it('should filter results by branch when branch is provided', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural', branch: 'main' });
    expect(result.results.length).toBe(1);
    expect(result.results[0].branch).toBe('main');
  });

  it('should return empty results when branch does not match', async () => {
    const result = await handler(db, {
      query: 'parseConfig',
      mode: 'structural',
      branch: 'nonexistent',
    });
    expect(result.results).toEqual([]);
  });

  it('should respect the limit parameter', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural', limit: 1 });
    expect(result.results.length).toBeLessThanOrEqual(1);
  });

  it('should return empty results for an unmatched query', async () => {
    const result = await handler(db, { query: 'zzz_no_match_zzz', mode: 'structural' });
    expect(result.results).toEqual([]);
  });

  it('should accept optional filter arguments without breaking structural search', async () => {
    const args: SearchArgs = {
      query: 'parseConfig',
      mode: 'structural',
      path_prefix: 'src/',
      language: 'typescript',
      kind: 'function',
    };
    const result = await handler(db, args);
    expect(result.mode_used).toBe('structural');
    expect(result.results.length).toBeGreaterThan(0);
  });
});

// ─── handler (semantic / fused fallback) ──────────────────────────────────────

describe('search handler – semantic/fused fallback without embedder', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/index.ts', 'main');
    insertSymbol(db, mainId, 'myFunc');
  });

  it('should fall back to structural when mode=semantic and no embedder provided', async () => {
    const result = await handler(db, { query: 'myFunc', mode: 'semantic' });
    expect(result.mode_used).toBe('structural (no query-time embedder)');
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('should fall back to structural when mode=fused and no embedder provided', async () => {
    const result = await handler(db, { query: 'myFunc', mode: 'fused' });
    expect(result.mode_used).toBe('structural (no query-time embedder)');
  });

  it('should fall back to structural when mode=semantic has embedder but embeddings are unavailable', async () => {
    const embedder = {
      modelName: 'test-embedder',
      dims: 3,
      embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
    };
    const result = await handler(db, { query: 'myFunc', mode: 'semantic' }, embedder);
    expect(result.mode_used).toBe('structural (fallback: no embeddings)');
    expect(result.results.every((row) => row.result_type === 'symbol')).toBe(true);
  });

  it('should fall back to structural when mode=fused has embedder but embeddings are unavailable', async () => {
    const embedder = {
      modelName: 'test-embedder',
      dims: 3,
      embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
    };
    const result = await handler(db, { query: 'myFunc', mode: 'fused' }, embedder);
    expect(result.mode_used).toBe('structural (fallback: no embeddings)');
    expect(result.results.every((row) => row.result_type === 'symbol')).toBe(true);
  });
});

// ─── SearchObserver callback ──────────────────────────────────────────────────

describe('search handler – observer callback', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
  });

  it('should invoke observer with correct fields on structural search', async () => {
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'parseConfig', mode: 'structural' }, undefined, observer);

    expect(observations).toHaveLength(1);
    const obs = observations[0]!;
    expect(obs.query).toBe('parseConfig');
    expect(obs.requestedMode).toBe('structural');
    expect(obs.modeUsed).toBe('structural');
    expect(obs.resultCount).toBe(1);
    expect(obs.topScore).toBeTypeOf('number');
    expect(obs.latencyMs).toBeGreaterThanOrEqual(0);
    expect(obs.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('should report zero results and null topScore when query has no matches', async () => {
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'zzz_no_match_zzz', mode: 'structural' }, undefined, observer);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.resultCount).toBe(0);
    expect(observations[0]!.topScore).toBeNull();
  });

  it('should report fallback mode when semantic requested without embedder', async () => {
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'parseConfig', mode: 'semantic' }, undefined, observer);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.requestedMode).toBe('semantic');
    expect(observations[0]!.modeUsed).toBe('structural (no query-time embedder)');
  });

  it('should include branch in observation when branch filter is used', async () => {
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'parseConfig', mode: 'structural', branch: 'main' }, undefined, observer);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.branch).toBe('main');
  });

  it('should not include branch in observation when no branch filter is used', async () => {
    const observations: SearchObservation[] = [];
    const observer: SearchObserver = (obs) => observations.push(obs);

    await handler(db, { query: 'parseConfig', mode: 'structural' }, undefined, observer);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.branch).toBeUndefined();
  });

  it('should not break search if observer throws', async () => {
    const throwingObserver: SearchObserver = () => {
      throw new Error('observer boom');
    };

    const result = await handler(db, { query: 'parseConfig', mode: 'structural' }, undefined, throwingObserver);

    expect(result.mode_used).toBe('structural');
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('should not invoke observer when none is provided', async () => {
    // Ensure no errors when observer is undefined (default path).
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    expect(result.results.length).toBeGreaterThan(0);
  });
});
