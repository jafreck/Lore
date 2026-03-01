import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  openDb,
  setKbMeta,
  getKbMeta,
  createVec0Tables,
  KB_META_INDEX_CHECKPOINT,
  KB_META_LAST_HEAD_SHA,
  KB_META_COVERAGE_LAST_SOURCE_PATH,
  KB_META_COVERAGE_LAST_SOURCE_MTIME,
} from '../../src/indexer/db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

describe('openDb', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `lore-test-${Date.now()}-${Math.random()}.db`);
  });

  afterEach(() => {
    db?.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) unlinkSync(walPath);
    if (existsSync(shmPath)) unlinkSync(shmPath);
  });

  it('should create a database file and return a Database instance', () => {
    db = openDb(dbPath);
    expect(db).toBeDefined();
    expect(existsSync(dbPath)).toBe(true);
  });

  it('should create the files table with a branch column', () => {
    db = openDb(dbPath);
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='files'")
      .get() as { sql: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.sql).toContain('branch');
  });

  it('should enforce UNIQUE(path, branch) constraint on files table', () => {
    db = openDb(dbPath);
    db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('a.ts', 'main', 'typescript')"
    ).run();
    // Same path + branch → should throw
    expect(() =>
      db.prepare(
        "INSERT INTO files (path, branch, language) VALUES ('a.ts', 'main', 'typescript')"
      ).run()
    ).toThrow();
    // Same path, different branch → should succeed
    expect(() =>
      db.prepare(
        "INSERT INTO files (path, branch, language) VALUES ('a.ts', 'feat', 'typescript')"
      ).run()
    ).not.toThrow();
  });

  it('should create the symbols, kb_meta, and other required tables', () => {
    db = openDb(dbPath);
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toContain('files');
    expect(tables).toContain('symbols');
    expect(tables).toContain('kb_meta');
    expect(tables).toContain('test_mappings');
    expect(tables).toContain('commit_refs');
    expect(tables).toContain('coverage_runs');
    expect(tables).toContain('coverage_files');
    expect(tables).toContain('coverage_lines');
  });

  it('should create test_mappings with expected columns and unique pair constraint', () => {
    db = openDb(dbPath);

    const columns = db.pragma('table_info(test_mappings)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['test_file_id', 'source_file_id', 'confidence']),
    );

    const firstTestFile = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('tests/a.test.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };
    const firstSourceFile = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('src/a.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };

    db.prepare(
      "INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, 'import')",
    ).run(firstTestFile.lastInsertRowid, firstSourceFile.lastInsertRowid);

    expect(() =>
      db.prepare(
        "INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, 'import')",
      ).run(firstTestFile.lastInsertRowid, firstSourceFile.lastInsertRowid),
    ).toThrow();
  });

  it('should cascade delete test_mappings when either linked file is deleted', () => {
    db = openDb(dbPath);

    const testFile = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('tests/a.test.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };
    const sourceFile = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('src/a.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };

    db.prepare(
      "INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, 'import')",
    ).run(testFile.lastInsertRowid, sourceFile.lastInsertRowid);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM test_mappings').get() as { count: number }).count,
    ).toBe(1);

    db.prepare('DELETE FROM files WHERE id = ?').run(sourceFile.lastInsertRowid);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM test_mappings').get() as { count: number }).count,
    ).toBe(0);
  });

  it('should enforce foreign keys from coverage tables to coverage runs', () => {
    db = openDb(dbPath);
    const coverageFilesFks = db.pragma('foreign_key_list(coverage_files)') as Array<{
      from: string;
      table: string;
    }>;
    const coverageLinesFks = db.pragma('foreign_key_list(coverage_lines)') as Array<{
      from: string;
      table: string;
    }>;

    expect(
      coverageFilesFks.some((fk) => fk.from === 'run_id' && fk.table === 'coverage_runs'),
    ).toBe(true);
    expect(
      coverageLinesFks.some((fk) => fk.from === 'run_id' && fk.table === 'coverage_runs'),
    ).toBe(true);
  });

  it('should reject coverage rows when the referenced run does not exist', () => {
    db = openDb(dbPath);

    expect(() =>
      db.prepare(
        "INSERT INTO coverage_files (run_id, file_path, lines_found, lines_hit) VALUES (999, 'src/a.ts', 1, 1)",
      ).run(),
    ).toThrow();

    expect(() =>
      db.prepare(
        "INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (999, 'src/a.ts', 1, 1)",
      ).run(),
    ).toThrow();
  });

  it('should reject coverage line rows when the matching coverage file row is missing', () => {
    db = openDb(dbPath);
    const run = db
      .prepare(
        "INSERT INTO coverage_runs (commit_sha, source_path, format) VALUES ('abc123', 'coverage/lcov.info', 'lcov')",
      )
      .run();

    expect(() =>
      db.prepare(
        "INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, 'src/a.ts', 10, 3)",
      ).run(run.lastInsertRowid),
    ).toThrow();
  });

  it('should be idempotent — calling openDb twice on the same path is safe', () => {
    db = openDb(dbPath);
    db.close();
    db = openDb(dbPath);
    expect(db).toBeDefined();
  });
});

describe('setKbMeta / getKbMeta', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `lore-test-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db?.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) unlinkSync(walPath);
    if (existsSync(shmPath)) unlinkSync(shmPath);
  });

  it('should write and read a key-value pair', () => {
    setKbMeta(db, 'schema_version', '1');
    expect(getKbMeta(db, 'schema_version')).toBe('1');
  });

  it('should return undefined for a missing key', () => {
    expect(getKbMeta(db, 'nonexistent_key')).toBeUndefined();
  });

  it('should overwrite an existing key', () => {
    setKbMeta(db, 'model', 'v1');
    setKbMeta(db, 'model', 'v2');
    expect(getKbMeta(db, 'model')).toBe('v2');
  });

  it('should export expected kb_meta key constants', () => {
    expect(KB_META_INDEX_CHECKPOINT).toBe('index_checkpoint');
    expect(KB_META_LAST_HEAD_SHA).toBe('last_known_head_sha');
    expect(KB_META_COVERAGE_LAST_SOURCE_PATH).toBe('coverage_last_source_path');
    expect(KB_META_COVERAGE_LAST_SOURCE_MTIME).toBe('coverage_last_source_mtime');
  });
});

describe('createVec0Tables', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `lore-test-${Date.now()}-${Math.random()}.db`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db?.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (existsSync(walPath)) unlinkSync(walPath);
    if (existsSync(shmPath)) unlinkSync(shmPath);
  });

  it('should create vec0 embedding tables and persist embedding_dims', () => {
    createVec0Tables(db, 4);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')")
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(tables).toContain('symbol_embeddings');
    expect(tables).toContain('symbol_semantic_embeddings');
    expect(getKbMeta(db, 'embedding_dims')).toBe('4');
  });
});
