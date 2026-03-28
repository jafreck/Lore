import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/cohesion.js';

function seedCohesionData(db: Database.Database) {
  // Create files in different directories
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/server/handler.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/server/router.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/db/schema.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (4, 'src/db/queries.ts', 'main', 'typescript', '')`).run();

  // Create symbols
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'handleReq', 'function', 1, 5)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'route', 'function', 1, 3)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'createTable', 'function', 1, 5)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (4, 4, 'query', 'function', 1, 3)`).run();

  // Internal edges within src/server (handler → router)
  db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (1, 1, 2, 'route', 2, 'resolved')`).run();

  // External edge: server → db
  db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (1, 1, 4, 'query', 3, 'resolved')`).run();

  // Internal edges within src/db
  db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (4, 4, 3, 'createTable', 1, 'resolved')`).run();
}

describe('lore_cohesion toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_cohesion');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.type).toBe('object');
  });
});

describe('lore_cohesion handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedCohesionData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns directory cohesion data', () => {
    const result = handler(db, {});
    expect(result.directories).toBeDefined();
    expect(result.directories.length).toBeGreaterThanOrEqual(1);
  });

  it('each directory has required fields', () => {
    const result = handler(db, {});
    for (const dir of result.directories) {
      expect(dir.directory).toBeTruthy();
      expect(typeof dir.file_count).toBe('number');
      expect(typeof dir.internal_edges).toBe('number');
      expect(typeof dir.external_inbound).toBe('number');
      expect(typeof dir.external_outbound).toBe('number');
      expect(typeof dir.cohesion).toBe('number');
      expect(typeof dir.instability).toBe('number');
    }
  });

  it('directories with more internal edges have higher cohesion', () => {
    const result = handler(db, {});
    // db directory has 1 internal + 1 inbound = cohesion = 1/(1+0) = 1.0
    // server directory has 1 internal + 1 outbound = cohesion 0.5
    const serverDir = result.directories.find((d) => d.directory === 'src/server');
    const dbDir = result.directories.find((d) => d.directory === 'src/db');
    expect(serverDir).toBeDefined();
    expect(dbDir).toBeDefined();
    expect(serverDir!.cohesion).toBeLessThanOrEqual(dbDir!.cohesion);
  });

  it('respects limit parameter', () => {
    const result = handler(db, { limit: 1 });
    expect(result.directories.length).toBeLessThanOrEqual(1);
  });

  it('respects depth parameter', () => {
    const result = handler(db, { depth: 1 });
    expect(result.directories.length).toBeGreaterThanOrEqual(1);
    // With depth=1, all files under src/* should be grouped as "src"
    const dirs = result.directories.map((d) => d.directory);
    // At depth 1 they may all be "src"
    for (const dir of dirs) {
      expect(dir.split('/').length).toBeLessThanOrEqual(1);
    }
  });

  it('handles empty DB', () => {
    const emptyDb = openDb(':memory:');
    try {
      const result = handler(emptyDb, {});
      expect(result.directories).toHaveLength(0);
    } finally {
      emptyDb.close();
    }
  });
});
