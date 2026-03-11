import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestCoverageReport } from '../../src/testing/coverage.js';

function createCoverageDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coverage_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_sha    TEXT    NOT NULL,
      source_path   TEXT    NOT NULL,
      format        TEXT    NOT NULL,
      ingested_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      source_mtime  INTEGER
    );
    CREATE TABLE coverage_files (
      run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
      file_path     TEXT    NOT NULL,
      lines_found   INTEGER NOT NULL DEFAULT 0,
      lines_hit     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, file_path)
    );
    CREATE TABLE coverage_lines (
      run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
      file_path     TEXT    NOT NULL,
      line_number   INTEGER NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, file_path, line_number)
    );
  `);
  return db;
}

describe('ingestCoverageReport', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lore-coverage-test-'));
    db = createCoverageDb();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should ingest LCOV reports and aggregate duplicate DA lines', () => {
    const reportPath = join(tempDir, 'lcov.info');
    writeFileSync(
      reportPath,
      ['TN:', 'SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'DA:2,2', 'DA:3,-5', 'DA:0,9', 'end_of_record'].join('\n'),
      'utf8',
    );

    const runId = ingestCoverageReport({
      db,
      rootDir: tempDir,
      reportPath,
      format: 'lcov',
      commitSha: 'abc123',
      sourceMtime: 123,
    });

    const filePath = join(tempDir, 'src/a.ts');
    const run = db
      .prepare('SELECT commit_sha, format, source_mtime FROM coverage_runs WHERE id = ?')
      .get(runId) as { commit_sha: string; format: string; source_mtime: number };
    const file = db
      .prepare('SELECT lines_found, lines_hit FROM coverage_files WHERE run_id = ? AND file_path = ?')
      .get(runId, filePath) as { lines_found: number; lines_hit: number };
    const lines = db
      .prepare('SELECT line_number, hit_count FROM coverage_lines WHERE run_id = ? AND file_path = ? ORDER BY line_number')
      .all(runId, filePath) as Array<{ line_number: number; hit_count: number }>;

    expect(run.commit_sha).toBe('abc123');
    expect(run.format).toBe('lcov');
    expect(run.source_mtime).toBe(123);
    expect(file.lines_found).toBe(3);
    expect(file.lines_hit).toBe(2);
    expect(lines).toEqual([
      { line_number: 1, hit_count: 1 },
      { line_number: 2, hit_count: 2 },
      { line_number: 3, hit_count: 0 },
    ]);
  });

  it('should ingest Cobertura reports with absolute file paths', () => {
    const reportPath = join(tempDir, 'coverage.xml');
    const sourceFile = join(tempDir, 'src/main.ts');
    writeFileSync(
      reportPath,
      [
        '<coverage>',
        `  <class name="Main" filename="${sourceFile}">`,
        '    <lines>',
        '      <line number="5" hits="1"/>',
        '      <line number="6" hits="0"/>',
        '    </lines>',
        '  </class>',
        '</coverage>',
      ].join('\n'),
      'utf8',
    );

    const runId = ingestCoverageReport({
      db,
      rootDir: tempDir,
      reportPath,
      format: 'cobertura',
      commitSha: 'def456',
    });

    const file = db
      .prepare('SELECT lines_found, lines_hit FROM coverage_files WHERE run_id = ? AND file_path = ?')
      .get(runId, sourceFile) as { lines_found: number; lines_hit: number };

    expect(file.lines_found).toBe(2);
    expect(file.lines_hit).toBe(1);
  });

  it('should throw when the report file does not exist', () => {
    expect(() =>
      ingestCoverageReport({
        db,
        rootDir: tempDir,
        reportPath: join(tempDir, 'missing.info'),
        format: 'lcov',
        commitSha: 'abc123',
      }),
    ).toThrow();
  });
});
