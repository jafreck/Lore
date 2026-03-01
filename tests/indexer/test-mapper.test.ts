import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/indexer/db.js';
import {
  isTestFilePath,
  refreshTestMappings,
  TEST_MAPPING_CONFIDENCES,
} from '../../src/indexer/test-mapper.js';

describe('isTestFilePath', () => {
  it('should recognize supported naming and directory conventions', () => {
    expect(isTestFilePath('/repo/src/math.test.ts')).toBe(true);
    expect(isTestFilePath('/repo/src/math.spec.ts')).toBe(true);
    expect(isTestFilePath('/repo/src/test_math.py')).toBe(true);
    expect(isTestFilePath('/repo/src/math_test.py')).toBe(true);
    expect(isTestFilePath('/repo/tests/math.ts')).toBe(true);
    expect(isTestFilePath('/repo/src/__tests__/math.ts')).toBe(true);
    expect(isTestFilePath('/repo/spec/math.ts')).toBe(true);
    expect(isTestFilePath('/repo/src/math.ts')).toBe(false);
  });
});

describe('refreshTestMappings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should map test files to resolved imports with import confidence', () => {
    const testFile = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('/repo/tests/math.test.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };
    const sourceFile = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('/repo/src/math.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };
    const helperFile = db.prepare(
      "INSERT INTO files (path, branch, language) VALUES ('/repo/src/helper.ts', 'main', 'typescript')",
    ).run() as { lastInsertRowid: number | bigint };
    db.prepare(
      "INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, './math', ?)",
    ).run(testFile.lastInsertRowid, sourceFile.lastInsertRowid);
    db.prepare(
      "INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, './helper', ?)",
    ).run(helperFile.lastInsertRowid, sourceFile.lastInsertRowid);

    refreshTestMappings(db, 'main');

    const rows = db.prepare(
      `SELECT tm.test_file_id, tm.source_file_id, tm.confidence
       FROM test_mappings tm
       ORDER BY tm.test_file_id, tm.source_file_id`,
    ).all() as Array<{ test_file_id: number; source_file_id: number; confidence: string }>;

    expect(rows).toEqual([
      {
        test_file_id: Number(testFile.lastInsertRowid),
        source_file_id: Number(sourceFile.lastInsertRowid),
        confidence: 'import',
      },
    ]);
  });

  it('should expose the supported confidence taxonomy', () => {
    expect(TEST_MAPPING_CONFIDENCES).toEqual(['import', 'coverage', 'heuristic']);
  });
});
