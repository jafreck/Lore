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

  it('should create the files table with branch and source columns', () => {
    db = openDb(dbPath);
    const columns = (db.pragma('table_info(files)') as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toEqual(expect.arrayContaining(['branch', 'source']));
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
    expect(tables).toContain('external_symbols');
    expect(tables).toContain('kb_meta');
    expect(tables).toContain('test_mappings');
    expect(tables).toContain('commit_refs');
    expect(tables).toContain('coverage_runs');
    expect(tables).toContain('coverage_files');
    expect(tables).toContain('coverage_lines');
    expect(tables).toContain('docs');
    expect(tables).toContain('doc_sections');
  });

  it('should create docs and doc_sections with expected unique constraints', () => {
    db = openDb(dbPath);
    const docsTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='docs'")
      .get() as { sql: string } | undefined;
    const sectionsTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='doc_sections'")
      .get() as { sql: string } | undefined;

    expect(docsTable?.sql).toContain('UNIQUE(path, branch)');
    expect(sectionsTable?.sql).toContain('UNIQUE(doc_id, section_index)');

    const insertDoc = db.prepare(
      `INSERT INTO docs (path, branch, kind, title, content, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const docInfo = insertDoc.run('README.md', 'main', 'readme', 'Readme', '# Readme', 'hash-1');
    const docId = Number(docInfo.lastInsertRowid);
    expect(() =>
      insertDoc.run('README.md', 'main', 'readme', 'Readme', '# Readme', 'hash-1'),
    ).toThrow();

    const insertSection = db.prepare(
      `INSERT INTO doc_sections (
         doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSection.run(docId, 0, 'Readme', 1, '["Readme"]', 1, 3, '# Readme', 'chunk-hash-1');
    expect(() =>
      insertSection.run(docId, 0, 'Readme', 1, '["Readme"]', 1, 3, '# Readme', 'chunk-hash-1'),
    ).toThrow();
    expect(() =>
      insertSection.run(docId, 1, 'Intro', 2, '["Readme","Intro"]', 4, 6, 'Intro', 'chunk-hash-2'),
    ).not.toThrow();
  });

  it('should create docs retrieval indexes during bootstrap', () => {
    db = openDb(dbPath);
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(indexes).toContain('idx_docs_branch_kind');
    expect(indexes).toContain('idx_doc_sections_doc_id');
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

  it('should create external_symbols with expected columns and indexes', () => {
    db = openDb(dbPath);
    const columns = db.pragma('table_info(external_symbols)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'dependency_ecosystem',
        'source_type',
        'source_ref',
        'package_name',
        'package_version',
        'symbol_name',
        'symbol_kind',
        'signature',
        'doc_comment',
        'resolved_type_signature',
        'resolved_return_type',
        'definition_uri',
        'definition_path',
      ]),
    );

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='external_symbols'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_external_symbols_dependency_ecosystem',
        'idx_external_symbols_package_name',
        'idx_external_symbols_symbol_name',
        'idx_external_symbols_definition_path',
      ]),
    );
  });

  it('should create enrichment metadata columns and indexes for symbols and symbol_refs', () => {
    db = openDb(dbPath);

    const symbolColumns = db.pragma('table_info(symbols)') as Array<{ name: string }>;
    expect(symbolColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'resolved_type_signature',
        'resolved_return_type',
        'definition_uri',
        'definition_path',
      ]),
    );

    const refColumns = db.pragma('table_info(symbol_refs)') as Array<{ name: string }>;
    expect(refColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'resolved_type_signature',
        'resolved_return_type',
        'definition_uri',
        'definition_path',
      ]),
    );

    const symbolIndexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='symbols'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const refIndexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='symbol_refs'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(symbolIndexes).toContain('idx_symbols_definition_path');
    expect(refIndexes).toContain('idx_symbol_refs_definition_path');
  });

  it('should default enrichment metadata fields to NULL when omitted', () => {
    db = openDb(dbPath);
    const fileRow = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('src/a.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };
    const symbolRow = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment)
       VALUES (?, 'alpha', 'function', 0, 1, 'function alpha(): string', '/** docs */')`,
    ).run(fileRow.lastInsertRowid) as { lastInsertRowid: number | bigint };
    db.prepare(
      "INSERT INTO symbol_refs (caller_id, callee_name, call_line) VALUES (?, 'beta', 4)",
    ).run(symbolRow.lastInsertRowid);

    const symbol = db.prepare(
      `SELECT resolved_type_signature, resolved_return_type, definition_uri, definition_path
       FROM symbols
       WHERE id = ?`,
    ).get(symbolRow.lastInsertRowid) as {
      resolved_type_signature: string | null;
      resolved_return_type: string | null;
      definition_uri: string | null;
      definition_path: string | null;
    };
    const ref = db.prepare(
      `SELECT resolved_type_signature, resolved_return_type, definition_uri, definition_path
       FROM symbol_refs
       WHERE caller_id = ?`,
    ).get(symbolRow.lastInsertRowid) as {
      resolved_type_signature: string | null;
      resolved_return_type: string | null;
      definition_uri: string | null;
      definition_path: string | null;
    };

    expect(symbol).toEqual({
      resolved_type_signature: null,
      resolved_return_type: null,
      definition_uri: null,
      definition_path: null,
    });
    expect(ref).toEqual({
      resolved_type_signature: null,
      resolved_return_type: null,
      definition_uri: null,
      definition_path: null,
    });
  });

  it('should apply default metadata values for external_symbols when omitted', () => {
    db = openDb(dbPath);
    db.prepare(
      `INSERT INTO external_symbols (package_name, package_version, symbol_name, symbol_kind)
       VALUES ('left-pad', '1.3.0', 'leftPad', 'function')`,
    ).run();

    const row = db
      .prepare(
        `SELECT dependency_ecosystem, source_type, source_ref, signature
         FROM external_symbols
         WHERE package_name = 'left-pad'`,
      )
      .get() as
      | {
          dependency_ecosystem: string;
          source_type: string;
          source_ref: string;
          signature: string;
        }
      | undefined;

    expect(row).toEqual({
      dependency_ecosystem: 'npm',
      source_type: 'declaration',
      source_ref: '',
      signature: '',
    });
  });

  it('should enforce unique external_symbols rows for an ecosystem/package/version/symbol signature', () => {
    db = openDb(dbPath);
    db.prepare(
      `INSERT INTO external_symbols
        (dependency_ecosystem, package_name, package_version, symbol_name, symbol_kind, signature, doc_comment)
       VALUES ('npm', 'left-pad', '1.3.0', 'leftPad', 'function', 'leftPad(input: string): string', '/** docs */')`,
    ).run();

    expect(() =>
      db.prepare(
        `INSERT INTO external_symbols
          (dependency_ecosystem, package_name, package_version, symbol_name, symbol_kind, signature)
         VALUES ('npm', 'left-pad', '1.3.0', 'leftPad', 'function', 'leftPad(input: string): string')`,
      ).run(),
    ).toThrow();

    expect(() =>
      db.prepare(
        `INSERT INTO external_symbols
          (dependency_ecosystem, package_name, package_version, symbol_name, symbol_kind, signature)
         VALUES ('pypi', 'left-pad', '1.3.0', 'leftPad', 'function', 'leftPad(input: string): string')`,
      ).run(),
    ).not.toThrow();
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

  it('should migrate legacy databases by adding enrichment metadata columns', () => {
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        last_hash TEXT,
        indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(path, branch)
      );
      INSERT INTO files (path, branch, language, size_bytes, last_hash, indexed_at)
      VALUES ('src/legacy.ts', 'main', 'typescript', 0, 'legacy-hash', unixepoch());
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        doc_comment TEXT
      );
      CREATE TABLE symbol_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        callee_id INTEGER REFERENCES symbols(id),
        callee_name TEXT NOT NULL,
        call_line INTEGER NOT NULL
      );
      CREATE TABLE external_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dependency_ecosystem TEXT NOT NULL DEFAULT 'npm',
        source_type TEXT NOT NULL DEFAULT 'declaration',
        source_ref TEXT NOT NULL DEFAULT '',
        package_name TEXT NOT NULL,
        package_version TEXT,
        symbol_name TEXT NOT NULL,
        symbol_kind TEXT NOT NULL,
        signature TEXT NOT NULL DEFAULT '',
        doc_comment TEXT
      );
    `);
    legacyDb.close();

    db = openDb(dbPath);
    const fileColumns = (db.pragma('table_info(files)') as Array<{ name: string }>).map(
      (column) => column.name,
    );
    const symbolColumns = (db.pragma('table_info(symbols)') as Array<{ name: string }>).map(
      (column) => column.name,
    );
    const refColumns = (db.pragma('table_info(symbol_refs)') as Array<{ name: string }>).map(
      (column) => column.name,
    );
    const externalColumns = (db.pragma('table_info(external_symbols)') as Array<{ name: string }>).map(
      (column) => column.name,
    );

    const legacyFileSource = db
      .prepare("SELECT source FROM files WHERE path = 'src/legacy.ts' AND branch = 'main'")
      .get() as { source: string } | undefined;

    expect(fileColumns).toContain('source');
    expect(symbolColumns).toEqual(
      expect.arrayContaining(['resolved_type_signature', 'resolved_return_type', 'definition_uri', 'definition_path']),
    );
    expect(refColumns).toEqual(
      expect.arrayContaining(['resolved_type_signature', 'resolved_return_type', 'definition_uri', 'definition_path']),
    );
    expect(externalColumns).toEqual(
      expect.arrayContaining(['resolved_type_signature', 'resolved_return_type', 'definition_uri', 'definition_path']),
    );
    expect(legacyFileSource?.source).toBe('');
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
