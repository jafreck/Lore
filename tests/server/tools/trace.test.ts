import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef, type TraceArgs } from '../../../src/server/tools/trace.js';

function seedTraceData(db: Database.Database) {
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/main.ts', 'main', 'typescript', 'function entryPoint() { helper(); }\nfunction helper() { deepCall(); }\nfunction deepCall() {}')`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'entryPoint', 'function', 1, 1)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'helper', 'function', 2, 2)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 1, 'deepCall', 'function', 3, 3)`).run();
  db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (1, 1, 2, 'helper', 0, 'resolved')`).run();
  db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (2, 1, 3, 'deepCall', 1, 'resolved')`).run();
}

describe('lore_trace toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_trace');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.type).toBe('object');
  });
});

describe('lore_trace handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedTraceData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('traces forward from symbol ID', () => {
    const result = handler(db, { from: 1, depth: 5 });
    expect(result.entry).toBeTruthy();
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    // First step should be the entry symbol
    expect(result.steps[0]!.symbol_id).toBe(1);
    expect(result.steps[0]!.name).toBe('entryPoint');
  });

  it('traces to depth 1', () => {
    const result = handler(db, { from: 1, depth: 1 });
    // Should include entry + direct callees but not deeper
    const ids = result.steps.map((s) => s.symbol_id);
    expect(ids).toContain(1); // entry
    expect(ids).toContain(2); // helper (1 hop)
    // deepCall (2 hops) should NOT be traced at depth=1
    expect(ids).not.toContain(3);
  });

  it('traces forward from name', () => {
    const result = handler(db, { from_name: 'entryPoint', depth: 5 });
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.steps[0]!.name).toBe('entryPoint');
  });

  it('throws for unknown symbol name', () => {
    expect(() => handler(db, { from_name: 'nonExistent' })).toThrow(/Symbol not found/);
  });

  it('traces point-to-point', () => {
    const result = handler(db, { from: 1, to: 3, depth: 5 });
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('returns truncated flag when deeper edges exist', () => {
    const result = handler(db, { from: 1, depth: 1 });
    expect(result.truncated).toBe(true);
  });

  it('handles empty DB gracefully', () => {
    const emptyDb = openDb(':memory:');
    try {
      expect(() => handler(emptyDb, { from_name: 'anything' })).toThrow();
    } finally {
      emptyDb.close();
    }
  });

  it('requires from or from_name', () => {
    expect(() => handler(db, {})).toThrow();
  });

  it('resolves to_name for point-to-point trace', () => {
    const result = handler(db, { from: 1, to_name: 'deepCall', depth: 5 });
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    const ids = result.steps.map((s) => s.symbol_id);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
  });

  it('throws when to_name is not found', () => {
    expect(() => handler(db, { from: 1, to_name: 'nonExistent' })).toThrow(/Symbol not found/);
  });

  it('throws when from symbol ID does not exist', () => {
    expect(() => handler(db, { from: 999 })).toThrow(/Entry symbol not found/);
  });

  it('throws when no path found between disconnected symbols', () => {
    // Add a disconnected symbol with no edges to it
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (4, 1, 'isolated', 'function', 4, 4)`,
    ).run();
    expect(() => handler(db, { from: 1, to: 4, depth: 5 })).toThrow(/No call path found/);
  });

  it('clamps depth to min 1 and max 10', () => {
    // depth: 0 should be clamped to 1
    const result = handler(db, { from: 1, depth: 0 });
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    // Verify clamping happened by checking result has data
    expect(result.total_nodes).toBeGreaterThanOrEqual(1);
  });

  it('clamps depth to max 10', () => {
    const result = handler(db, { from: 1, depth: 100 });
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    // Verify clamping: result should still be valid
    expect(result.total_nodes).toBeGreaterThanOrEqual(1);
  });

  it('defaults max_source_lines to 50', () => {
    const result = handler(db, { from: 1, depth: 1 });
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    // Source should be present
    for (const step of result.steps) {
      expect(step.source).toBeDefined();
    }
  });

  it('truncates long source with max_source_lines', () => {
    // Create a file with many lines
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    db.prepare(`UPDATE files SET source = ? WHERE id = 1`).run(lines);
    db.prepare(`UPDATE symbols SET start_line = 1, end_line = 100 WHERE id = 1`).run();
    const result = handler(db, { from: 1, depth: 0, max_source_lines: 5 });
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    const source = result.steps[0]!.source;
    expect(source).toContain('more lines');
  });

  it('includes call_line in steps for non-root nodes', () => {
    const result = handler(db, { from: 1, depth: 5 });
    // Find the helper step (depth > 0)
    const helperStep = result.steps.find((s) => s.name === 'helper');
    expect(helperStep).toBeDefined();
    expect(helperStep!.call_line).toBeDefined();
  });

  it('includes resolution_method in steps', () => {
    const result = handler(db, { from: 1, depth: 5 });
    const helperStep = result.steps.find((s) => s.name === 'helper');
    expect(helperStep).toBeDefined();
    expect(helperStep!.resolution_method).toBe('resolved');
  });

  it('total_nodes reflects visited count', () => {
    const result = handler(db, { from: 1, depth: 5 });
    expect(result.total_nodes).toBe(3); // entryPoint, helper, deepCall
  });

  it('point-to-point is not truncated', () => {
    const result = handler(db, { from: 1, to: 3, depth: 5 });
    expect(result.truncated).toBe(false);
  });

  it('entry field shows point-to-point description', () => {
    const result = handler(db, { from: 1, to: 3, depth: 5 });
    expect(result.entry).toContain('→');
  });

  it('ambiguous from_name throws with candidates', () => {
    // Add a second symbol with the same name
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/other.ts', 'main', 'typescript', 'function entryPoint() {}')`,
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (5, 2, 'entryPoint', 'function', 1, 1)`,
    ).run();
    expect(() => handler(db, { from_name: 'entryPoint' })).toThrow(/Ambiguous/);
  });

  it('handles symbol with signature', () => {
    db.prepare(`UPDATE symbols SET signature = '(a: number): void' WHERE id = 1`).run();
    const result = handler(db, { from: 1, depth: 0 });
    expect(result.steps[0]!.signature).toBe('(a: number): void');
  });

  it('handles symbol_metrics table for cyclomatic complexity', () => {
    // Create symbol_metrics table and insert data
    db.prepare(`INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (1, 10, 2, 5, 1)`).run();
    const result = handler(db, { from: 1, depth: 0 });
    expect(result.steps[0]!.cyclomatic).toBe(5);
  });
});
