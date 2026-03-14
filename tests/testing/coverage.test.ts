import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestCoverageReport, parseLcov, parseCobertura } from '../../src/testing/coverage.js';

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

describe('parseLcov', () => {
  it('should parse a simple LCOV record into file-line hit maps', () => {
    const source = [
      'TN:',
      'SF:src/a.ts',
      'DA:1,5',
      'DA:2,0',
      'DA:3,1',
      'end_of_record',
    ].join('\n');

    const result = parseLcov(source, '/root');
    expect(result.size).toBe(1);
    const hits = result.get('/root/src/a.ts')!;
    expect(hits.get(1)).toBe(5);
    expect(hits.get(2)).toBe(0);
    expect(hits.get(3)).toBe(1);
  });

  it('should handle multiple files in a single LCOV report', () => {
    const source = [
      'SF:src/a.ts',
      'DA:1,1',
      'end_of_record',
      'SF:src/b.ts',
      'DA:10,2',
      'end_of_record',
    ].join('\n');

    const result = parseLcov(source, '/root');
    expect(result.size).toBe(2);
    expect(result.get('/root/src/a.ts')!.get(1)).toBe(1);
    expect(result.get('/root/src/b.ts')!.get(10)).toBe(2);
  });

  it('should aggregate duplicate DA lines for the same line number', () => {
    const source = ['SF:src/a.ts', 'DA:1,2', 'DA:1,3', 'end_of_record'].join('\n');

    const result = parseLcov(source, '/root');
    expect(result.get('/root/src/a.ts')!.get(1)).toBe(5);
  });

  it('should skip lines with invalid line numbers', () => {
    const source = [
      'SF:src/a.ts',
      'DA:0,5',
      'DA:-1,3',
      'DA:abc,1',
      'DA:1,1',
      'end_of_record',
    ].join('\n');

    const result = parseLcov(source, '/root');
    const hits = result.get('/root/src/a.ts')!;
    expect(hits.size).toBe(1);
    expect(hits.get(1)).toBe(1);
  });

  it('should clamp negative hit counts to zero', () => {
    const source = ['SF:src/a.ts', 'DA:1,-5', 'end_of_record'].join('\n');
    const result = parseLcov(source, '/root');
    expect(result.get('/root/src/a.ts')!.get(1)).toBe(0);
  });

  it('should return an empty map for empty input', () => {
    expect(parseLcov('', '/root').size).toBe(0);
  });

  it('should handle absolute SF paths without re-resolving', () => {
    const source = ['SF:/abs/src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const result = parseLcov(source, '/root');
    expect(result.has('/abs/src/a.ts')).toBe(true);
  });

  it('should ignore DA lines before any SF record', () => {
    const source = ['DA:1,1', 'SF:src/a.ts', 'DA:2,1', 'end_of_record'].join('\n');
    const result = parseLcov(source, '/root');
    const hits = result.get('/root/src/a.ts')!;
    expect(hits.size).toBe(1);
    expect(hits.get(2)).toBe(1);
  });

  it('should handle Windows-style CRLF line endings', () => {
    const source = 'SF:src/a.ts\r\nDA:1,1\r\nend_of_record\r\n';
    const result = parseLcov(source, '/root');
    expect(result.size).toBe(1);
  });
});

describe('parseCobertura', () => {
  it('should parse a simple Cobertura XML with one class', () => {
    const source = [
      '<coverage>',
      '  <class name="Foo" filename="src/foo.ts">',
      '    <lines>',
      '      <line number="1" hits="3"/>',
      '      <line number="2" hits="0"/>',
      '    </lines>',
      '  </class>',
      '</coverage>',
    ].join('\n');

    const result = parseCobertura(source, '/root');
    expect(result.size).toBe(1);
    const hits = result.get('/root/src/foo.ts')!;
    expect(hits.get(1)).toBe(3);
    expect(hits.get(2)).toBe(0);
  });

  it('should handle multiple classes with distinct files', () => {
    const source = [
      '<coverage>',
      '  <class name="A" filename="src/a.ts">',
      '    <lines><line number="1" hits="1"/></lines>',
      '  </class>',
      '  <class name="B" filename="src/b.ts">',
      '    <lines><line number="5" hits="2"/></lines>',
      '  </class>',
      '</coverage>',
    ].join('\n');

    const result = parseCobertura(source, '/root');
    expect(result.size).toBe(2);
    expect(result.get('/root/src/a.ts')!.get(1)).toBe(1);
    expect(result.get('/root/src/b.ts')!.get(5)).toBe(2);
  });

  it('should aggregate hits across multiple classes for the same file', () => {
    const source = [
      '<coverage>',
      '  <class name="A" filename="src/a.ts">',
      '    <lines><line number="1" hits="2"/></lines>',
      '  </class>',
      '  <class name="B" filename="src/a.ts">',
      '    <lines><line number="1" hits="3"/></lines>',
      '  </class>',
      '</coverage>',
    ].join('\n');

    const result = parseCobertura(source, '/root');
    expect(result.get('/root/src/a.ts')!.get(1)).toBe(5);
  });

  it('should handle absolute file paths in filename attribute', () => {
    const source = [
      '<coverage>',
      '  <class name="X" filename="/abs/src/x.ts">',
      '    <lines><line number="1" hits="1"/></lines>',
      '  </class>',
      '</coverage>',
    ].join('\n');

    const result = parseCobertura(source, '/root');
    expect(result.has('/abs/src/x.ts')).toBe(true);
  });

  it('should skip lines with invalid line numbers', () => {
    const source = [
      '<coverage>',
      '  <class name="X" filename="src/x.ts">',
      '    <lines>',
      '      <line number="0" hits="5"/>',
      '      <line number="1" hits="1"/>',
      '    </lines>',
      '  </class>',
      '</coverage>',
    ].join('\n');

    const result = parseCobertura(source, '/root');
    const hits = result.get('/root/src/x.ts')!;
    expect(hits.size).toBe(1);
    expect(hits.get(1)).toBe(1);
  });

  it('should return an empty map for XML with no class elements', () => {
    expect(parseCobertura('<coverage></coverage>', '/root').size).toBe(0);
  });

  it('should return an empty map for empty input', () => {
    expect(parseCobertura('', '/root').size).toBe(0);
  });
});
