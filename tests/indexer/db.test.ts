import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  openDb,
  setKbMeta,
  getKbMeta,
  createVec0Tables,
  KB_META_INDEX_CHECKPOINT,
  KB_META_LAST_HEAD_SHA,
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
    expect(tables).toContain('commit_refs');
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
