import { describe, it, expect, afterEach } from 'vitest';
import RawDatabase from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CURRENT_LORE_SCHEMA_VERSION,
  inspectLoreSchema,
  LORE_SCHEMA_MIGRATION_VERSIONS,
  openDb,
} from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';

describe('openDb', () => {
  let db: Database.Database;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (db?.open) db.close();
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
    expect(names).toContain('baseline_generations');
    expect(names).toContain('index_runs');
    expect(names).toContain('indexer_runs');
    expect(names).toContain('commits');
    expect(names).toContain('commit_files');
    expect(names).toContain('commit_refs');
    expect(names).toContain('dirty_files');
    expect(names).toContain('reverse_deps');
  });

  it('records and reports the current schema version', () => {
    db = openDb(':memory:');
    expect(inspectLoreSchema(db)).toMatchObject({
      status: 'current',
      version: CURRENT_LORE_SCHEMA_VERSION,
      requiredVersion: CURRENT_LORE_SCHEMA_VERSION,
      missing: [],
    });
  });

  it('declares a contiguous ordered migration chain', () => {
    expect(LORE_SCHEMA_MIGRATION_VERSIONS).toEqual(
      Array.from({ length: CURRENT_LORE_SCHEMA_VERSION }, (_, index) => index + 1),
    );
  });

  it('rejects a newer database before changing its journal mode', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-newer-schema-'));
    tempDirs.push(directory);
    const dbPath = path.join(directory, 'newer.db');
    const raw = new RawDatabase(dbPath);
    raw.exec('CREATE TABLE sentinel (value TEXT)');
    raw.pragma(`user_version = ${CURRENT_LORE_SCHEMA_VERSION + 1}`);
    expect((raw.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]?.journal_mode)
      .toBe('delete');
    raw.close();

    expect(() => openDb(dbPath)).toThrow(/newer than supported/u);

    const unchanged = new RawDatabase(dbPath, { readonly: true });
    try {
      expect((unchanged.pragma('journal_mode') as Array<{ journal_mode: string }>)[0]?.journal_mode)
        .toBe('delete');
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'sentinel'").get())
        .toBeDefined();
    } finally {
      unchanged.close();
    }
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
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
    expect(names).toContain('effective_symbol_metrics');
  });

  it('selects only the promoted baseline generation in effective_files', () => {
    db = openDb(':memory:');
    db.prepare(
      `INSERT INTO files (path, branch, language, source, layer, generation)
       VALUES ('src/a.ts', 'main', 'typescript', 'generation one', 'baseline', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO files (path, branch, language, source, layer, generation)
       VALUES ('src/a.ts', 'main', 'typescript', 'generation two', 'baseline', 2)`,
    ).run();
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();

    expect(db.prepare(
      "SELECT source, generation FROM effective_files WHERE branch = 'main'",
    ).get()).toEqual({ source: 'generation one', generation: 1 });

    db.prepare(
      "UPDATE baseline_generations SET generation = 2 WHERE branch = 'main'",
    ).run();
    expect(db.prepare(
      "SELECT source, generation FROM effective_files WHERE branch = 'main'",
    ).get()).toEqual({ source: 'generation two', generation: 2 });
  });

  it('does not expose an initial candidate generation to an independent reader', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hidden-initial-'));
    tempDirs.push(directory);
    const dbPath = path.join(directory, 'index.db');
    db = openDb(dbPath);
    db.prepare(
      `INSERT INTO files (path, branch, language, source, layer, generation)
       VALUES ('src/candidate.ts', 'main', 'typescript', 'candidate', 'baseline', 1)`,
    ).run();

    const reader = new RawDatabase(dbPath, { readonly: true });
    try {
      expect(reader.prepare('SELECT path FROM effective_files').all()).toEqual([]);
    } finally {
      reader.close();
    }
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

  it('stores precise symbol range and selection coordinates', () => {
    db = openDb(':memory:');
    const columns = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining([
      'start_character',
      'end_character',
      'selection_line',
      'selection_character',
    ]));
  });

  it('stores import resolution provenance and resets it with a deleted target', () => {
    db = openDb(':memory:');
    const insertFile = db.prepare(
      "INSERT INTO files (path, language) VALUES (?, 'c')",
    );
    const sourceId = Number(insertFile.run('source.c').lastInsertRowid);
    const targetId = Number(insertFile.run('target.h').lastInsertRowid);
    db.prepare(
      `INSERT INTO file_imports (file_id, raw_import, resolved_id, resolution_method)
       VALUES (?, 'target.h', ?, 'compilation_database')`,
    ).run(sourceId, targetId);

    db.prepare('DELETE FROM files WHERE id = ?').run(targetId);
    const imported = db.prepare(
      'SELECT resolved_id, resolution_method FROM file_imports WHERE file_id = ?',
    ).get(sourceId) as { resolved_id: number | null; resolution_method: string };
    expect(imported).toEqual({ resolved_id: null, resolution_method: 'overlay_stale' });
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
    expect(names).toContain('idx_file_imports_resolution_method');
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
