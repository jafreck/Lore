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
});

describe('test-map toolDef', () => {
  it('should expose lore_test_map with source_path required and optional branch', () => {
    expect(toolDef.name).toBe('lore_test_map');
    expect(toolDef.inputSchema.required).toEqual(['source_path']);
    expect(toolDef.inputSchema.properties.source_path.type).toBe('string');
    expect(toolDef.inputSchema.properties.branch.type).toBe('string');
  });
});
