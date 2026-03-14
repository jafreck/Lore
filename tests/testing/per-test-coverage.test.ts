import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestPerTestCoverage } from '../../src/testing/coverage.js';
import { listTestsByLine } from '../../src/db/read-only.js';

function createPerTestCoverageDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE test_coverage_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_sha    TEXT    NOT NULL,
      test_file     TEXT    NOT NULL,
      test_name     TEXT,
      source_path   TEXT    NOT NULL,
      format        TEXT    NOT NULL,
      ingested_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE test_coverage_lines (
      run_id        INTEGER NOT NULL REFERENCES test_coverage_runs(id) ON DELETE CASCADE,
      file_path     TEXT    NOT NULL,
      line_number   INTEGER NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, file_path, line_number)
    );
    CREATE INDEX idx_test_coverage_lines_path_line ON test_coverage_lines(file_path, line_number);
  `);
  return db;
}

describe('ingestPerTestCoverage', () => {
  let tempDir: string;
  let reportsDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lore-per-test-cov-'));
    reportsDir = join(tempDir, 'reports');
    mkdirSync(reportsDir);
    db = createPerTestCoverageDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should ingest LCOV per-test reports and derive test file paths from filenames', () => {
    writeFileSync(
      join(reportsDir, 'tests__unit__foo.test.ts'),
      ['SF:src/foo.ts', 'DA:1,3', 'DA:2,0', 'DA:3,1', 'end_of_record'].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(reportsDir, 'tests__unit__bar.test.ts'),
      ['SF:src/bar.ts', 'DA:10,1', 'end_of_record'].join('\n'),
      'utf8',
    );

    const count = ingestPerTestCoverage({
      db,
      reportsDir,
      rootDir: tempDir,
      commitSha: 'abc123',
      format: 'lcov',
    });

    expect(count).toBe(2);

    const runs = db.prepare('SELECT test_file, commit_sha, format FROM test_coverage_runs ORDER BY test_file').all() as Array<{
      test_file: string;
      commit_sha: string;
      format: string;
    }>;
    expect(runs).toHaveLength(2);
    expect(runs[0].test_file).toBe('tests/unit/bar.test.ts');
    expect(runs[1].test_file).toBe('tests/unit/foo.test.ts');
    expect(runs[0].commit_sha).toBe('abc123');
    expect(runs[0].format).toBe('lcov');

    const storedPaths = db
      .prepare('SELECT DISTINCT file_path FROM test_coverage_lines ORDER BY file_path')
      .all() as Array<{ file_path: string }>;
    expect(storedPaths).toEqual([
      { file_path: resolve(tempDir, 'src/bar.ts') },
      { file_path: resolve(tempDir, 'src/foo.ts') },
    ]);
  });

  it('should only insert lines with hit_count > 0', () => {
    writeFileSync(
      join(reportsDir, 'tests__a.test.ts'),
      ['SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'DA:3,5', 'end_of_record'].join('\n'),
      'utf8',
    );

    ingestPerTestCoverage({ db, reportsDir, rootDir: tempDir, commitSha: 'sha1', format: 'lcov' });

    const lines = db
      .prepare('SELECT file_path, line_number, hit_count FROM test_coverage_lines ORDER BY line_number')
      .all() as Array<{ file_path: string; line_number: number; hit_count: number }>;
    expect(lines).toEqual([
      { file_path: resolve(tempDir, 'src/a.ts'), line_number: 1, hit_count: 1 },
      { file_path: resolve(tempDir, 'src/a.ts'), line_number: 3, hit_count: 5 },
    ]);
  });

  it('should support a custom separator', () => {
    writeFileSync(
      join(reportsDir, 'tests--unit--baz.test.ts'),
      ['SF:src/baz.ts', 'DA:1,1', 'end_of_record'].join('\n'),
      'utf8',
    );

    const count = ingestPerTestCoverage({
      db,
      reportsDir,
      commitSha: 'sha2',
      format: 'lcov',
      separator: '--',
    });

    expect(count).toBe(1);
    const run = db.prepare('SELECT test_file FROM test_coverage_runs').get() as { test_file: string };
    expect(run.test_file).toBe('tests/unit/baz.test.ts');
  });

  it('should return 0 when the reports directory is empty', () => {
    const count = ingestPerTestCoverage({ db, reportsDir, commitSha: 'sha3', format: 'lcov' });
    expect(count).toBe(0);
  });

  it('should skip subdirectories and only process files', () => {
    mkdirSync(join(reportsDir, 'subdir'));
    writeFileSync(
      join(reportsDir, 'tests__x.test.ts'),
      ['SF:src/x.ts', 'DA:1,1', 'end_of_record'].join('\n'),
      'utf8',
    );

    const count = ingestPerTestCoverage({ db, reportsDir, commitSha: 'sha4', format: 'lcov' });
    expect(count).toBe(1);
  });

  it('should ingest Cobertura per-test reports', () => {
    const sourceFile = join(reportsDir, 'src/foo.ts');
    writeFileSync(
      join(reportsDir, 'tests__unit__cob.test.ts'),
      [
        '<coverage>',
        `  <class name="Foo" filename="${sourceFile}">`,
        '    <lines>',
        '      <line number="1" hits="2"/>',
        '      <line number="2" hits="0"/>',
        '    </lines>',
        '  </class>',
        '</coverage>',
      ].join('\n'),
      'utf8',
    );

    const count = ingestPerTestCoverage({
      db,
      reportsDir,
      commitSha: 'sha5',
      format: 'cobertura',
    });

    expect(count).toBe(1);
    const run = db.prepare('SELECT test_file, format FROM test_coverage_runs').get() as {
      test_file: string;
      format: string;
    };
    expect(run.test_file).toBe('tests/unit/cob.test.ts');
    expect(run.format).toBe('cobertura');

    const lines = db
      .prepare('SELECT line_number, hit_count FROM test_coverage_lines ORDER BY line_number')
      .all() as Array<{ line_number: number; hit_count: number }>;
    // Only line with hit_count > 0 should be stored
    expect(lines).toEqual([{ line_number: 1, hit_count: 2 }]);
  });

  it('should handle separator with regex-special characters', () => {
    writeFileSync(
      join(reportsDir, 'tests.+.unit.+.special.test.ts'),
      ['SF:src/s.ts', 'DA:1,1', 'end_of_record'].join('\n'),
      'utf8',
    );

    const count = ingestPerTestCoverage({
      db,
      reportsDir,
      commitSha: 'sha6',
      format: 'lcov',
      separator: '.+.',
    });

    expect(count).toBe(1);
    const run = db.prepare('SELECT test_file FROM test_coverage_runs').get() as { test_file: string };
    expect(run.test_file).toBe('tests/unit/special.test.ts');
  });
});

describe('listTestsByLine', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createPerTestCoverageDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should return tests covering a specific file and line', () => {
    db.exec(`
      INSERT INTO test_coverage_runs (id, commit_sha, test_file, test_name, source_path, format)
        VALUES (1, 'abc', 'tests/foo.test.ts', NULL, '/report1', 'lcov');
      INSERT INTO test_coverage_runs (id, commit_sha, test_file, test_name, source_path, format)
        VALUES (2, 'abc', 'tests/bar.test.ts', 'it works', '/report2', 'lcov');
      INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count)
        VALUES (1, 'src/foo.ts', 10, 3);
      INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count)
        VALUES (2, 'src/foo.ts', 10, 1);
      INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count)
        VALUES (2, 'src/foo.ts', 20, 1);
    `);

    const results = listTestsByLine(db, 'src/foo.ts', 10);
    expect(results).toHaveLength(2);
    expect(results).toEqual([
      { test_file: 'tests/bar.test.ts', test_name: 'it works' },
      { test_file: 'tests/foo.test.ts', test_name: null },
    ]);
  });

  it('should return an empty array when no tests cover the line', () => {
    expect(listTestsByLine(db, 'src/missing.ts', 1)).toEqual([]);
  });

  it('should exclude lines with hit_count = 0', () => {
    db.exec(`
      INSERT INTO test_coverage_runs (id, commit_sha, test_file, test_name, source_path, format)
        VALUES (1, 'abc', 'tests/a.test.ts', NULL, '/r', 'lcov');
      INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count)
        VALUES (1, 'src/a.ts', 5, 0);
    `);

    expect(listTestsByLine(db, 'src/a.ts', 5)).toEqual([]);
  });

  it('should return distinct results when the same test covers a line in multiple runs', () => {
    db.exec(`
      INSERT INTO test_coverage_runs (id, commit_sha, test_file, test_name, source_path, format)
        VALUES (1, 'sha1', 'tests/x.test.ts', NULL, '/r1', 'lcov');
      INSERT INTO test_coverage_runs (id, commit_sha, test_file, test_name, source_path, format)
        VALUES (2, 'sha2', 'tests/x.test.ts', NULL, '/r2', 'lcov');
      INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count)
        VALUES (1, 'src/x.ts', 1, 1);
      INSERT INTO test_coverage_lines (run_id, file_path, line_number, hit_count)
        VALUES (2, 'src/x.ts', 1, 2);
    `);

    const results = listTestsByLine(db, 'src/x.ts', 1);
    expect(results).toHaveLength(1);
    expect(results[0].test_file).toBe('tests/x.test.ts');
  });
});
