/**
 * Tests for incremental indexing schema helpers: generation tracking,
 * effective_* views, dirty_files, and reverse_deps tables.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  openDb,
  setLoreMeta,
  getLoreMeta,
  getGeneration,
  incrementGeneration,
  LORE_META_GENERATION,
  LORE_META_GENERATION_PENDING,
  LORE_META_BASELINE_HEAD_SHA,
  LORE_META_OVERLAY_HEAD_SHA,
} from '../../src/db/schema.js';
import type Database from 'better-sqlite3';

describe('incremental schema — generation helpers', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('getGeneration should return 0 when no generation is set', () => {
    db = openDb(':memory:');
    expect(getGeneration(db)).toBe(0);
  });

  it('getGeneration should return the stored generation value', () => {
    db = openDb(':memory:');
    setLoreMeta(db, LORE_META_GENERATION, '5');
    expect(getGeneration(db)).toBe(5);
  });

  it('incrementGeneration should increment from 0 to 1', () => {
    db = openDb(':memory:');
    const result = incrementGeneration(db);
    expect(result).toBe(1);
    expect(getGeneration(db)).toBe(1);
  });

  it('incrementGeneration should increment from existing value', () => {
    db = openDb(':memory:');
    setLoreMeta(db, LORE_META_GENERATION, '3');
    const result = incrementGeneration(db);
    expect(result).toBe(4);
    expect(getGeneration(db)).toBe(4);
  });

  it('should export new lore_meta key constants', () => {
    expect(LORE_META_GENERATION).toBe('generation');
    expect(LORE_META_GENERATION_PENDING).toBe('generation_pending');
    expect(LORE_META_BASELINE_HEAD_SHA).toBe('baseline_head_sha');
    expect(LORE_META_OVERLAY_HEAD_SHA).toBe('overlay_head_sha');
  });
});

describe('incremental schema — dirty_files table', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should create dirty_files table', () => {
    db = openDb(':memory:');
    const row = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'dirty_files'",
    ).get() as { ok: number } | undefined;
    expect(row?.ok).toBe(1);
  });

  it('should allow inserting and querying dirty files', () => {
    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)',
    ).run('/src/test.ts', 1000, 0);

    const row = db.prepare('SELECT * FROM dirty_files WHERE path = ?').get('/src/test.ts') as
      | { path: string; dirty_since: number; overlay_gen: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.path).toBe('/src/test.ts');
    expect(row!.dirty_since).toBe(1000);
  });

  it('should support INSERT OR REPLACE for upserts', () => {
    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)',
    ).run('/src/test.ts', 1000, 0);
    db.prepare(
      'INSERT OR REPLACE INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)',
    ).run('/src/test.ts', 2000, 1);

    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM dirty_files').get() as { cnt: number }).cnt;
    expect(count).toBe(1);
    const row = db.prepare('SELECT dirty_since FROM dirty_files WHERE path = ?').get('/src/test.ts') as { dirty_since: number };
    expect(row.dirty_since).toBe(2000);
  });
});

describe('incremental schema — reverse_deps table', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should create reverse_deps table', () => {
    db = openDb(':memory:');
    const row = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'reverse_deps'",
    ).get() as { ok: number } | undefined;
    expect(row?.ok).toBe(1);
  });

  it('should enforce composite primary key', () => {
    db = openDb(':memory:');
    // Insert two files first (FK constraint)
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/a.ts', 'HEAD', 'typescript', 10, '', 'baseline', 1);
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/b.ts', 'HEAD', 'typescript', 10, '', 'baseline', 1);

    db.prepare(
      "INSERT INTO reverse_deps (file_id, dependent_id, dep_kind) VALUES (1, 2, 'import')",
    ).run();

    // Duplicate insert should fail
    expect(() => {
      db.prepare(
        "INSERT INTO reverse_deps (file_id, dependent_id, dep_kind) VALUES (1, 2, 'import')",
      ).run();
    }).toThrow();
  });
});

describe('incremental schema — effective_* views', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should create effective_files view', () => {
    db = openDb(':memory:');
    const row = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'view' AND name = 'effective_files'",
    ).get() as { ok: number } | undefined;
    expect(row?.ok).toBe(1);
  });

  it('should return baseline rows when no dirty files exist', () => {
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 10, 'baseline-content', 'baseline', 1);

    const rows = db.prepare('SELECT * FROM effective_files').all() as Array<{ path: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('/src/a.ts');
  });

  it('should prefer overlay rows for dirty files', () => {
    db = openDb(':memory:');
    // Baseline row
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 10, 'baseline-content', 'baseline', 1);
    // Overlay row
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 15, 'overlay-content', 'overlay', 0);
    // Mark as dirty
    db.prepare(
      'INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)',
    ).run('/src/a.ts', 1000, 0);

    const rows = db.prepare('SELECT * FROM effective_files').all() as Array<{ path: string; source: string; layer: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.layer).toBe('overlay');
    expect(rows[0]!.source).toBe('overlay-content');
  });

  it('should return baseline for non-dirty files alongside overlay for dirty files', () => {
    db = openDb(':memory:');
    // File A: baseline only (not dirty)
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 10, 'a-baseline', 'baseline', 1);
    // File B: has overlay (dirty)
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/b.ts', 'HEAD', 'typescript', 10, 'b-baseline', 'baseline', 1);
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/b.ts', 'HEAD', 'typescript', 15, 'b-overlay', 'overlay', 0);
    db.prepare(
      'INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)',
    ).run('/src/b.ts', 1000, 0);

    const rows = db.prepare('SELECT path, source, layer FROM effective_files ORDER BY path').all() as
      Array<{ path: string; source: string; layer: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({ path: '/src/a.ts', layer: 'baseline' }));
    expect(rows[1]).toEqual(expect.objectContaining({ path: '/src/b.ts', layer: 'overlay' }));
  });

  it('effective_symbols should join through effective_files', () => {
    db = openDb(':memory:');
    // Insert baseline file and symbol
    const fInfo = db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 10, '', 'baseline', 1);
    db.prepare(
      "INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(Number(fInfo.lastInsertRowid), 'hello', 'function', 1, 3, 'baseline', 1);

    const rows = db.prepare('SELECT * FROM effective_symbols').all();
    expect(rows).toHaveLength(1);
  });

  it('should add layer and generation columns to all data tables', () => {
    db = openDb(':memory:');
    const tables = ['files', 'symbols', 'symbol_refs', 'type_refs', 'symbol_relationships',
      'file_imports', 'annotations', 'external_deps', 'symbol_metrics'];
    for (const table of tables) {
      const cols = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(r => r.name);
      expect(cols).toContain('layer');
      expect(cols).toContain('generation');
    }
  });
});
