import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { handler, type SearchArgs, type SearchResult, type SearchObservation, type SearchObserver } from '../../../src/kb-server/tools/search.js';

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
      doc_comment TEXT
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
): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    )
    .run(fileId, name, kind);
  const rowid = result.lastInsertRowid as number;
  db.prepare('INSERT INTO symbols_fts(rowid, name, kind) VALUES (?, ?, ?)').run(rowid, name, kind);
  return rowid;
}

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

  it('should default to structural mode when mode is omitted', async () => {
    const result = await handler(db, { query: 'renderPage' });
    expect(result.mode_used).toBe('structural');
  });

  it('should include branch field on each result', async () => {
    const result = await handler(db, { query: 'parseConfig', mode: 'structural' });
    result.results.forEach((r) => expect(typeof r.branch).toBe('string'));
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
