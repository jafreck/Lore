import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/structure.js';

function seedStructureData(db: Database.Database) {
  // Create files in different directories
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/server/a.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/db/b.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/server/c.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (4, 'src/db/d.ts', 'main', 'typescript', '')`).run();

  // Create circular imports: server → db → server (cycle)
  db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (1, '../db/b', 2)`).run();
  db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (2, '../server/c', 3)`).run();
  // Also db → server back
  db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (4, '../server/a', 1)`).run();
}

describe('lore_structure toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_structure');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.type).toBe('object');
  });
});

describe('lore_structure handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedStructureData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('runs all analyses by default', () => {
    const result = handler(db, {});
    expect(result.cycles).toBeDefined();
    expect(result.layer_violations).toBeDefined();
    expect(result.outliers).toBeDefined();
  });

  it('detects cycles', () => {
    const result = handler(db, { analysis: 'cycles' });
    expect(result.cycles).toBeDefined();
    // Should detect the src/server ↔ src/db cycle
    expect(result.cycles!.length).toBeGreaterThanOrEqual(1);
  });

  it('runs layers analysis', () => {
    const result = handler(db, { analysis: 'layers' });
    expect(result.layer_violations).toBeDefined();
  });

  it('runs outliers analysis', () => {
    const result = handler(db, { analysis: 'outliers' });
    expect(result.outliers).toBeDefined();
  });

  it('handles custom depth', () => {
    const result = handler(db, { depth: 1 });
    expect(result.cycles).toBeDefined();
  });

  it('handles empty DB', () => {
    const emptyDb = openDb(':memory:');
    try {
      const result = handler(emptyDb, {});
      expect(result.cycles).toBeDefined();
      expect(result.cycles).toHaveLength(0);
    } finally {
      emptyDb.close();
    }
  });
});
