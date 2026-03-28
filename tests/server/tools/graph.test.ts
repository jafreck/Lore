import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef, type GraphArgs } from '../../../src/server/tools/graph.js';

function seedCallGraph(db: Database.Database) {
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', 'function a() { b(); }')`,
  ).run();
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/b.ts', 'main', 'typescript', 'function b() {}')`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'a', 'function', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'b', 'function', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
     VALUES (1, 1, 2, 'b', 0, 'resolved')`,
  ).run();
}

function seedImportGraph(db: Database.Database) {
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/index.ts', 'main', 'typescript', '')`,
  ).run();
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/utils.ts', 'main', 'typescript', '')`,
  ).run();
  db.prepare(
    `INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (1, './utils', 2)`,
  ).run();
}

describe('lore_graph toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_graph');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.required).toContain('kind');
  });
});

describe('lore_graph handler — call edges', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedCallGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns call edges for source_id', () => {
    const result = handler(db, { kind: 'call', source_id: 1 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0]!;
    expect(edge.source_name).toBe('a');
    expect(edge.target_name).toBe('b');
    expect(result.mode_used).toBe('structural');
  });

  it('returns inbound call edges for target_id', () => {
    const result = handler(db, { kind: 'call', target_id: 2 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0]!;
    expect(edge.source_name).toBe('a');
    expect(edge.target_name).toBe('b');
  });

  it('returns empty for non-existent source_id', () => {
    const result = handler(db, { kind: 'call', source_id: 999 });
    expect(result.edges).toHaveLength(0);
  });

  it('supports compact mode', () => {
    const result = handler(db, { kind: 'call', source_id: 1, compact: true });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0] as any;
    // compact omits line, character, resolution_method
    expect(edge.line).toBeUndefined();
    expect(edge.resolution_method).toBeUndefined();
  });

  it('returns depth_used', () => {
    const result = handler(db, { kind: 'call', source_id: 1 });
    expect(result.depth_used).toBeDefined();
    expect(typeof result.depth_used).toBe('number');
  });

  it('handles point-to-point query', () => {
    const result = handler(db, { kind: 'call', source_id: 1, target_id: 2 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('converts line numbers to 1-based', () => {
    const result = handler(db, { kind: 'call', source_id: 1 });
    const edge = result.edges[0] as any;
    // call_line=0 in DB → line=1 in response
    expect(edge.line).toBe(1);
  });
});

describe('lore_graph handler — import edges', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedImportGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns import edges for source_id', () => {
    const result = handler(db, { kind: 'import', source_id: 1 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0]!;
    expect(edge.source_name).toBe('src/index.ts');
    expect(edge.target_name).toBe('src/utils.ts');
  });

  it('returns import edges for target_id', () => {
    const result = handler(db, { kind: 'import', target_id: 2 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('lore_graph handler — empty DB', () => {
  it('returns empty edges', () => {
    const db = openDb(':memory:');
    try {
      const result = handler(db, { kind: 'call' });
      expect(result.edges).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe('lore_graph handler — inheritance edges', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'Base', 'class', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'Child', 'class', 6, 10)`).run();
    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
       VALUES (1, 2, 1, 'Base', 'extends', 6, 'resolved')`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('returns inheritance edges', () => {
    const result = handler(db, { kind: 'inheritance', source_id: 2 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.edges[0]!.target_name).toBe('Base');
  });

  it('returns inbound inheritance edges', () => {
    const result = handler(db, { kind: 'inheritance', target_id: 1 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.edges[0]!.source_name).toBe('Child');
  });
});

describe('lore_graph handler — type_dependency edges', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'myFunc', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'MyType', 'type', 6, 6)`).run();
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (1, 1, 2, 'MyType', 'MyType', 'parameter', 2, 'resolved')`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('returns type dependency edges', () => {
    const result = handler(db, { kind: 'type_dependency', source_id: 1 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0]! as any;
    expect(edge.target_name).toBe('MyType');
    expect(edge.ref_kind).toBe('parameter');
  });
});
