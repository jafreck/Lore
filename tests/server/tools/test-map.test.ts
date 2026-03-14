import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef } from '../../../src/server/tools/test-map.js';

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
    CREATE TABLE test_mappings (
      test_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      confidence     TEXT    NOT NULL DEFAULT 'heuristic',
      UNIQUE(test_file_id, source_file_id)
    );
  `);
  return db;
}

describe('test-map handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns mapped test paths with confidence values', () => {
    const sourceId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('src/lib/math.ts', 'main', 'typescript').lastInsertRowid as number;
    const testAId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('tests/math.spec.ts', 'main', 'typescript').lastInsertRowid as number;
    const testBId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('tests/math.integration.test.ts', 'main', 'typescript').lastInsertRowid as number;

    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)')
      .run(testAId, sourceId, 'import');
    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)')
      .run(testBId, sourceId, 'heuristic');

    const result = handler(db, { source_path: 'src/lib/math.ts' });
    expect(result).toEqual({
      source_path: 'src/lib/math.ts',
      branch: null,
      mappings: [
        { test_path: 'tests/math.integration.test.ts', confidence: 'heuristic' },
        { test_path: 'tests/math.spec.ts', confidence: 'import' },
      ],
    });
  });

  it('filters mappings by branch when provided', () => {
    const mainSourceId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('src/lib/math.ts', 'main', 'typescript').lastInsertRowid as number;
    const featSourceId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('src/lib/math.ts', 'feat', 'typescript').lastInsertRowid as number;
    const mainTestId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('tests/math.spec.ts', 'main', 'typescript').lastInsertRowid as number;
    const featTestId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('tests/math.spec.ts', 'feat', 'typescript').lastInsertRowid as number;

    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)')
      .run(mainTestId, mainSourceId, 'import');
    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)')
      .run(featTestId, featSourceId, 'heuristic');

    const result = handler(db, { source_path: 'src/lib/math.ts', branch: 'feat' });
    expect(result).toEqual({
      source_path: 'src/lib/math.ts',
      branch: 'feat',
      mappings: [{ test_path: 'tests/math.spec.ts', confidence: 'heuristic' }],
    });
  });

  it('returns empty mappings when no source matches', () => {
    const result = handler(db, { source_path: 'src/missing.ts' });
    expect(result.mappings).toEqual([]);
  });

  it('returns per_test_coverage mappings when line is provided', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_coverage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha  TEXT NOT NULL,
        test_file   TEXT NOT NULL,
        test_name   TEXT,
        source_path TEXT NOT NULL,
        format      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_coverage_lines (
        run_id      INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, file_path, line_number)
      );
      CREATE INDEX IF NOT EXISTS idx_test_coverage_lines_path_line ON test_coverage_lines(file_path, line_number);
    `);

    const runId = db
      .prepare(
        `INSERT INTO test_coverage_runs (commit_sha, test_file, test_name, source_path, format)
         VALUES ('abc123', 'tests/math.spec.ts', 'adds numbers', 'coverage/math.lcov', 'lcov')`,
      )
      .run().lastInsertRowid as number;
    db.prepare(
      'INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)',
    ).run(runId, 'src/lib/math.ts', 10, 3);

    const result = handler(db, { source_path: 'src/lib/math.ts', line: 10 });
    expect(result).toEqual({
      source_path: 'src/lib/math.ts',
      branch: null,
      mappings: [
        {
          test_path: 'tests/math.spec.ts',
          confidence: 'per_test_coverage',
          line: 10,
          test_name: 'adds numbers',
        },
      ],
    });
  });

  it('returns empty mappings when line has no coverage data', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_coverage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha  TEXT NOT NULL,
        test_file   TEXT NOT NULL,
        test_name   TEXT,
        source_path TEXT NOT NULL,
        format      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_coverage_lines (
        run_id      INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, file_path, line_number)
      );
    `);

    const result = handler(db, { source_path: 'src/lib/math.ts', line: 99 });
    expect(result).toEqual({
      source_path: 'src/lib/math.ts',
      branch: null,
      mappings: [],
    });
  });

  it('preserves branch in result when line is provided', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_coverage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha  TEXT NOT NULL,
        test_file   TEXT NOT NULL,
        test_name   TEXT,
        source_path TEXT NOT NULL,
        format      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_coverage_lines (
        run_id      INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, file_path, line_number)
      );
    `);

    const result = handler(db, { source_path: 'src/lib/math.ts', branch: 'feat', line: 5 });
    expect(result.branch).toBe('feat');
  });

  it('should exclude lines with hit_count of zero', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_coverage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha  TEXT NOT NULL,
        test_file   TEXT NOT NULL,
        test_name   TEXT,
        source_path TEXT NOT NULL,
        format      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_coverage_lines (
        run_id      INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, file_path, line_number)
      );
    `);

    const runId = db
      .prepare(
        `INSERT INTO test_coverage_runs (commit_sha, test_file, test_name, source_path, format)
         VALUES ('abc123', 'tests/math.spec.ts', 'adds numbers', 'coverage/math.lcov', 'lcov')`,
      )
      .run().lastInsertRowid as number;
    db.prepare(
      'INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)',
    ).run(runId, 'src/lib/math.ts', 10, 0);

    const result = handler(db, { source_path: 'src/lib/math.ts', line: 10 });
    expect(result.mappings).toEqual([]);
  });

  it('should return multiple tests covering the same line', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_coverage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha  TEXT NOT NULL,
        test_file   TEXT NOT NULL,
        test_name   TEXT,
        source_path TEXT NOT NULL,
        format      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_coverage_lines (
        run_id      INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, file_path, line_number)
      );
    `);

    const runA = db
      .prepare(
        `INSERT INTO test_coverage_runs (commit_sha, test_file, test_name, source_path, format)
         VALUES ('abc123', 'tests/math.spec.ts', 'adds numbers', 'coverage/math.lcov', 'lcov')`,
      )
      .run().lastInsertRowid as number;
    const runB = db
      .prepare(
        `INSERT INTO test_coverage_runs (commit_sha, test_file, test_name, source_path, format)
         VALUES ('abc123', 'tests/math.spec.ts', 'subtracts numbers', 'coverage/math.lcov', 'lcov')`,
      )
      .run().lastInsertRowid as number;

    db.prepare(
      'INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)',
    ).run(runA, 'src/lib/math.ts', 10, 2);
    db.prepare(
      'INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)',
    ).run(runB, 'src/lib/math.ts', 10, 1);

    const result = handler(db, { source_path: 'src/lib/math.ts', line: 10 });
    expect(result.mappings).toHaveLength(2);
    expect(result.mappings).toEqual([
      {
        test_path: 'tests/math.spec.ts',
        confidence: 'per_test_coverage',
        line: 10,
        test_name: 'adds numbers',
      },
      {
        test_path: 'tests/math.spec.ts',
        confidence: 'per_test_coverage',
        line: 10,
        test_name: 'subtracts numbers',
      },
    ]);
  });

  it('should handle null test_name in per-test coverage', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_coverage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha  TEXT NOT NULL,
        test_file   TEXT NOT NULL,
        test_name   TEXT,
        source_path TEXT NOT NULL,
        format      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_coverage_lines (
        run_id      INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, file_path, line_number)
      );
    `);

    const runId = db
      .prepare(
        `INSERT INTO test_coverage_runs (commit_sha, test_file, test_name, source_path, format)
         VALUES ('abc123', 'tests/math.spec.ts', NULL, 'coverage/math.lcov', 'lcov')`,
      )
      .run().lastInsertRowid as number;
    db.prepare(
      'INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)',
    ).run(runId, 'src/lib/math.ts', 5, 1);

    const result = handler(db, { source_path: 'src/lib/math.ts', line: 5 });
    expect(result.mappings).toEqual([
      {
        test_path: 'tests/math.spec.ts',
        confidence: 'per_test_coverage',
        line: 5,
        test_name: null,
      },
    ]);
  });

  it('should fall back to file-level mappings when line is not provided', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_coverage_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        commit_sha  TEXT NOT NULL,
        test_file   TEXT NOT NULL,
        test_name   TEXT,
        source_path TEXT NOT NULL,
        format      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS test_coverage_lines (
        run_id      INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, file_path, line_number)
      );
    `);

    // Insert both file-level and line-level data
    const sourceId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('src/lib/math.ts', 'main', 'typescript').lastInsertRowid as number;
    const testId = db
      .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
      .run('tests/math.spec.ts', 'main', 'typescript').lastInsertRowid as number;
    db.prepare(
      'INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)',
    ).run(testId, sourceId, 'import');

    const runId = db
      .prepare(
        `INSERT INTO test_coverage_runs (commit_sha, test_file, test_name, source_path, format)
         VALUES ('abc123', 'tests/math.spec.ts', 'adds numbers', 'coverage/math.lcov', 'lcov')`,
      )
      .run().lastInsertRowid as number;
    db.prepare(
      'INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)',
    ).run(runId, 'src/lib/math.ts', 10, 3);

    // Without line, should return file-level mappings only
    const result = handler(db, { source_path: 'src/lib/math.ts' });
    expect(result.mappings).toEqual([
      { test_path: 'tests/math.spec.ts', confidence: 'import' },
    ]);
  });
});

describe('test-map toolDef', () => {
  it('should expose lore_test_map with source_path required and optional branch and line', () => {
    expect(toolDef.name).toBe('lore_test_map');
    expect(toolDef.inputSchema.required).toEqual(['source_path']);
    expect(toolDef.inputSchema.properties.source_path.type).toBe('string');
    expect(toolDef.inputSchema.properties.branch.type).toBe('string');
    expect(toolDef.inputSchema.properties.line.type).toBe('number');
  });
});
