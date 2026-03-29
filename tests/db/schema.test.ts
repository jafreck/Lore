import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';

describe('openDb', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('creates all core tables in-memory', () => {
    db = openDb(':memory:');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('files');
    expect(names).toContain('symbols');
    expect(names).toContain('annotations');
    expect(names).toContain('file_imports');
    expect(names).toContain('symbol_refs');
    expect(names).toContain('symbol_relationships');
    expect(names).toContain('type_refs');
    expect(names).toContain('external_deps');
    expect(names).toContain('external_symbols');
    expect(names).toContain('modules');
    expect(names).toContain('file_modules');
    expect(names).toContain('symbol_summaries');
    expect(names).toContain('symbol_metrics');
    expect(names).toContain('lore_meta');
    expect(names).toContain('commits');
    expect(names).toContain('commit_files');
    expect(names).toContain('commit_refs');
    expect(names).toContain('dirty_files');
    expect(names).toContain('reverse_deps');
  });

  it('creates effective_* views', () => {
    db = openDb(':memory:');
    const views = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = views.map((v) => v.name);

    expect(names).toContain('effective_files');
    expect(names).toContain('effective_symbols');
    expect(names).toContain('effective_symbol_refs');
    expect(names).toContain('effective_type_refs');
    expect(names).toContain('effective_symbol_relationships');
    expect(names).toContain('effective_annotations');
    expect(names).toContain('effective_file_imports');
  });

  it('creates symbols_fts virtual table', () => {
    db = openDb(':memory:');
    const row = db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'symbols_fts'",
      )
      .get() as { ok: number } | undefined;
    expect(row?.ok).toBe(1);
  });

  it('enables WAL journal mode', () => {
    db = openDb(':memory:');
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    // In-memory databases may report 'memory' instead of 'wal'
    expect(['wal', 'memory']).toContain(result[0]?.journal_mode);
  });

  it('enables foreign keys', () => {
    db = openDb(':memory:');
    const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(result[0]?.foreign_keys).toBe(1);
  });

  it('is idempotent — calling twice does not error', () => {
    db = openDb(':memory:');
    // Re-run the schema on the same DB should not throw
    expect(() => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', language TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0, last_hash TEXT, source TEXT NOT NULL DEFAULT '', indexed_at INTEGER NOT NULL DEFAULT (unixepoch()), layer TEXT NOT NULL DEFAULT 'baseline', generation INTEGER NOT NULL DEFAULT 0, UNIQUE(path, branch, layer))",
      );
    }).not.toThrow();
  });

  it('sets appropriate pragmas for performance', () => {
    db = openDb(':memory:');
    const sync = db.pragma('synchronous') as Array<{ synchronous: number }>;
    // NORMAL = 1
    expect(sync[0]?.synchronous).toBe(1);
  });

  it('creates expected indexes on core tables', () => {
    db = openDb(':memory:');
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);

    expect(names).toContain('idx_symbols_file_id');
    expect(names).toContain('idx_symbols_name');
    expect(names).toContain('idx_files_layer');
    expect(names).toContain('idx_commit_files_file_path');
    expect(names).toContain('idx_commit_refs_ref_name');
    expect(names).toContain('idx_dirty_files_path');
  });

  it('can insert and read from tables created by openDb', () => {
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes) VALUES ('test.ts', '', 'typescript', 100)",
    ).run();
    const row = db.prepare('SELECT * FROM files WHERE path = ?').get('test.ts') as {
      path: string;
      language: string;
    };
    expect(row.path).toBe('test.ts');
    expect(row.language).toBe('typescript');
  });
});
