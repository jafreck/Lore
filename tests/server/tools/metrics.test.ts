import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/metrics.js';

function seedMetricsData(db: Database.Database) {
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/complex.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature) VALUES (1, 1, 'simpleFunc', 'function', 1, 5, '(): void')`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature) VALUES (2, 1, 'complexFunc', 'function', 6, 50, '(a, b, c): Result')`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature) VALUES (3, 1, 'mediumFunc', 'function', 51, 80, '(x): void')`).run();

  db.prepare(`INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (1, 5, 0, 1, 0)`).run();
  db.prepare(`INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (2, 45, 3, 15, 5)`).run();
  db.prepare(`INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (3, 30, 1, 7, 3)`).run();
}

describe('lore_metrics toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_metrics');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.type).toBe('object');
  });
});

describe('lore_metrics handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedMetricsData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns symbols ranked by cyclomatic complexity', () => {
    const result = handler(db, {});
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    // Should be ordered by cyclomatic DESC
    expect(result.symbols[0]!.name).toBe('complexFunc');
    expect(result.symbols[0]!.cyclomatic).toBe(15);
  });

  it('respects limit', () => {
    const result = handler(db, { limit: 1 });
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('complexFunc');
  });

  it('respects min_cyclomatic filter', () => {
    const result = handler(db, { min_cyclomatic: 10 });
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('complexFunc');
  });

  it('returns all fields', () => {
    const result = handler(db, {});
    const sym = result.symbols[0]!;
    expect(typeof sym.id).toBe('number');
    expect(typeof sym.name).toBe('string');
    expect(typeof sym.kind).toBe('string');
    expect(typeof sym.line_count).toBe('number');
    expect(typeof sym.param_count).toBe('number');
    expect(typeof sym.cyclomatic).toBe('number');
    expect(typeof sym.max_nesting).toBe('number');
  });

  it('handles empty DB (no metrics table data)', () => {
    const emptyDb = openDb(':memory:');
    try {
      const result = handler(emptyDb, {});
      expect(result.symbols).toHaveLength(0);
    } finally {
      emptyDb.close();
    }
  });

  it('handles min_cyclomatic = 0', () => {
    const result = handler(db, { min_cyclomatic: 0 });
    expect(result.symbols).toHaveLength(3);
  });
});
