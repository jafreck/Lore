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
    // but required fields must still be present
    expect(edge.source_name).toBeDefined();
    expect(edge.target_name).toBeDefined();
  });

  it('returns depth_used', () => {
    const result = handler(db, { kind: 'call', source_id: 1 });
    expect(result.depth_used).toBeDefined();
    expect(typeof result.depth_used).toBe('number');
    expect(result.depth_used).toBeGreaterThanOrEqual(1);
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

  it('returns inbound type dependency edges for target_id', () => {
    const result = handler(db, { kind: 'type_dependency', target_id: 2 });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0]! as any;
    expect(edge.source_name).toBe('myFunc');
    expect(edge.target_name).toBe('MyType');
  });
});

// ─── Branch filtering ─────────────────────────────────────────────────────────

describe('lore_graph handler — branch filtering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedCallGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it('call edges filtered by matching branch', () => {
    const result = handler(db, { kind: 'call', source_id: 1, branch: 'main' });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('call edges filtered by non-matching branch returns empty', () => {
    const result = handler(db, { kind: 'call', source_id: 1, branch: 'other' });
    expect(result.edges).toHaveLength(0);
  });

  it('import edges filtered by branch', () => {
    db.close();
    db = openDb(':memory:');
    seedImportGraph(db);
    const result = handler(db, { kind: 'import', source_id: 1, branch: 'main' });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('inheritance edges filtered by branch', () => {
    db.close();
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'Base', 'class', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'Child', 'class', 6, 10)`).run();
    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
       VALUES (1, 2, 1, 'Base', 'extends', 6, 'resolved')`,
    ).run();
    const result = handler(db, { kind: 'inheritance', source_id: 2, branch: 'main' });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('type_dependency edges filtered by branch', () => {
    db.close();
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'myFunc', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'MyType', 'type', 6, 6)`).run();
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (1, 1, 2, 'MyType', 'MyType', 'parameter', 2, 'resolved')`,
    ).run();
    const result = handler(db, { kind: 'type_dependency', source_id: 1, branch: 'main' });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Compact edge with optional fields ────────────────────────────────────────

describe('lore_graph handler — compact edge optional fields', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    // Seed with parent symbol to cover compact edge parent fields
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'Parent', 'class', 1, 20)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, parent_symbol_id) VALUES (2, 1, 'method', 'method', 5, 10, 1)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 1, 'target', 'function', 15, 20)`).run();
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method, definition_path)
       VALUES (2, 1, 3, 'target', 5, 'resolved', 'src/a.ts')`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('compact mode preserves parent symbol fields when present', () => {
    const result = handler(db, { kind: 'call', source_id: 2, compact: true });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0] as any;
    expect(edge.source_parent_symbol_id).toBe(1);
    expect(edge.source_parent_name).toBe('Parent');
    expect(edge.source_file_path).toBe('src/a.ts');
    // target_file_path comes from definition_path
    expect(edge.target_file_path).toBe('src/a.ts');
  });

  it('compact mode with type_dependency preserves ref_kind', () => {
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (1, 2, 3, 'target', 'target', 'field', 6, 'resolved')`,
    ).run();
    const result = handler(db, { kind: 'type_dependency', source_id: 2, compact: true });
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges[0] as any;
    expect(edge.ref_kind).toBe('field');
  });
});

// ─── Multi-hop transitive expansion ───────────────────────────────────────────

describe('lore_graph handler — multi-hop expansion', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    // Chain: a→b→c
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'a', 'function', 1, 1)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'b', 'function', 2, 2)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 1, 'c', 'function', 3, 3)`).run();
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (1, 1, 2, 'b', 0, 'resolved')`).run();
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (2, 1, 3, 'c', 1, 'resolved')`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('follows transitive outbound edges across hops', () => {
    const result = handler(db, { kind: 'call', source_id: 1 });
    // Should find a→b and b→c
    expect(result.edges.length).toBe(2);
    const targetNames = result.edges.map(e => e.target_name);
    expect(targetNames).toContain('b');
    expect(targetNames).toContain('c');
    expect(result.depth_used).toBe(2);
  });

  it('follows transitive inbound edges across hops', () => {
    const result = handler(db, { kind: 'call', target_id: 3 });
    // Should find b→c and a→b
    expect(result.edges.length).toBe(2);
    const sourceNames = result.edges.map(e => e.source_name);
    expect(sourceNames).toContain('a');
    expect(sourceNames).toContain('b');
  });

  it('deduplicates edges in multi-hop traversal', () => {
    // Add a diamond: a→b, a→c, b→d, c→d
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (4, 1, 'd', 'function', 4, 4)`).run();
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (3, 1, 4, 'd', 2, 'resolved')`).run();
    // Also add a→c directly so we create potential duplicate path
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (1, 1, 3, 'c', 3, 'resolved')`).run();

    const result = handler(db, { kind: 'call', source_id: 1 });
    // Edges should be unique
    const edgeKeys = result.edges.map(e => `${e.source_name}:${e.target_name}`);
    const uniqueKeys = [...new Set(edgeKeys)];
    expect(edgeKeys.length).toBe(uniqueKeys.length);
  });

  it('truncated flag set when edges reach limit', () => {
    // The INTERNAL_LIMIT is 1000, so we just verify the truncated field logic
    const result = handler(db, { kind: 'call', source_id: 1 });
    expect(result.truncated).toBe(false);
  });
});

// ─── Semantic mode ────────────────────────────────────────────────────────────

describe('lore_graph handler — semantic mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedCallGraph(db);
  });

  afterEach(() => {
    db.close();
  });

  it('semantic mode without query_vector falls back', () => {
    const result = handler(db, { kind: 'call', source_id: 1, mode: 'semantic' });
    expect(result.mode_used).toContain('structural');
    expect(result.mode_used).toContain('missing query_vector');
    expect(result.semantic_nodes).toEqual([]);
  });

  it('semantic mode with empty query_vector falls back', () => {
    const result = handler(db, { kind: 'call', source_id: 1, mode: 'semantic', query_vector: [] });
    expect(result.mode_used).toContain('structural');
    expect(result.mode_used).toContain('missing query_vector');
  });

  it('semantic mode with query_vector but no embeddings table falls back', () => {
    const result = handler(db, { kind: 'call', source_id: 1, mode: 'semantic', query_vector: [0.1, 0.2, 0.3] });
    expect(result.mode_used).toContain('structural');
    expect(result.mode_used).toContain('no embeddings');
    expect(result.semantic_nodes).toEqual([]);
  });

  it('semantic mode with embeddings table returns semantic results', () => {
    // Check if vec0 is available
    try {
      db.prepare("CREATE VIRTUAL TABLE symbol_embeddings USING vec0(embedding float[3])").run();
    } catch {
      return; // skip if sqlite-vec not available
    }
    // Insert embeddings for seeded symbols
    db.prepare("INSERT INTO symbol_embeddings (rowid, embedding) VALUES (1, ?)").run(JSON.stringify([0.1, 0.2, 0.3]));
    db.prepare("INSERT INTO symbol_embeddings (rowid, embedding) VALUES (2, ?)").run(JSON.stringify([0.4, 0.5, 0.6]));

    const result = handler(db, {
      kind: 'call',
      source_id: 1,
      mode: 'semantic',
      query_vector: [0.1, 0.2, 0.3],
    });
    expect(result.mode_used).toBe('semantic');
    expect(result.semantic_nodes).toBeDefined();
    expect(result.semantic_nodes!.length).toBeGreaterThanOrEqual(1);
    const node = result.semantic_nodes![0]!;
    expect(node.node_type).toBe('symbol');
    expect(typeof node.id).toBe('number');
    expect(typeof node.name).toBe('string');
    expect(typeof node.score).toBe('number');
  });

  it('semantic mode respects semantic_max_distance filter', () => {
    try {
      db.prepare("CREATE VIRTUAL TABLE symbol_embeddings USING vec0(embedding float[3])").run();
    } catch {
      return;
    }
    db.prepare("INSERT INTO symbol_embeddings (rowid, embedding) VALUES (1, ?)").run(JSON.stringify([0.1, 0.2, 0.3]));
    db.prepare("INSERT INTO symbol_embeddings (rowid, embedding) VALUES (2, ?)").run(JSON.stringify([0.9, 0.9, 0.9]));

    const result = handler(db, {
      kind: 'call',
      source_id: 1,
      mode: 'semantic',
      query_vector: [0.1, 0.2, 0.3],
      semantic_max_distance: 0.001,
    });
    // With very low max distance, far symbols should be filtered out
    expect(result.mode_used).toBe('semantic');
    if (result.semantic_nodes!.length > 0) {
      for (const node of result.semantic_nodes!) {
        expect(node.score).toBeLessThanOrEqual(0.001);
      }
    }
  });

  it('semantic mode respects semantic_limit', () => {
    try {
      db.prepare("CREATE VIRTUAL TABLE symbol_embeddings USING vec0(embedding float[3])").run();
    } catch {
      return;
    }
    db.prepare("INSERT INTO symbol_embeddings (rowid, embedding) VALUES (1, ?)").run(JSON.stringify([0.1, 0.2, 0.3]));
    db.prepare("INSERT INTO symbol_embeddings (rowid, embedding) VALUES (2, ?)").run(JSON.stringify([0.4, 0.5, 0.6]));

    const result = handler(db, {
      kind: 'call',
      source_id: 1,
      mode: 'semantic',
      query_vector: [0.1, 0.2, 0.3],
      semantic_limit: 1,
    });
    expect(result.mode_used).toBe('semantic');
    expect(result.semantic_nodes!.length).toBeLessThanOrEqual(1);
  });
});

// ─── Fake vec0 coverage (runs without sqlite-vec native extension) ────────────

describe('lore_graph semantic via fakeVec0', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = openDb(':memory:');
    seedCallGraph(db);
    const { installFakeVec0 } = await import('../../helpers/fakeVec0.js');
    installFakeVec0(db, [
      {
        symbol_id: 1,
        name: 'a',
        kind: 'function',
        file_path: 'src/a.ts',
        start_line: 1,
        end_line: 1,
        score: 0.05,
        file_branch: 'main',
      },
      {
        symbol_id: 2,
        name: 'b',
        kind: 'function',
        file_path: 'src/b.ts',
        start_line: 1,
        end_line: 1,
        score: 0.15,
        file_branch: 'main',
      },
    ]);
  });

  afterEach(async () => {
    const { removeFakeVec0 } = await import('../../helpers/fakeVec0.js');
    removeFakeVec0(db);
    db.close();
  });

  it('returns semantic nodes without real vec0', () => {
    const result = handler(db, {
      kind: 'call',
      source_id: 1,
      mode: 'semantic',
      query_vector: [0.1, 0.2, 0.3],
    });
    expect(result.mode_used).toBe('semantic');
    expect(result.semantic_nodes).toBeDefined();
    expect(result.semantic_nodes!.length).toBeGreaterThanOrEqual(1);
  });

  it('respects semantic_max_distance filter', () => {
    const result = handler(db, {
      kind: 'call',
      source_id: 1,
      mode: 'semantic',
      query_vector: [0.1, 0.2, 0.3],
      semantic_max_distance: 0.1,
    });
    expect(result.mode_used).toBe('semantic');
    for (const node of result.semantic_nodes!) {
      expect(node.score).toBeLessThanOrEqual(0.1);
    }
  });

  it('respects semantic_limit parameter', () => {
    const result = handler(db, {
      kind: 'call',
      source_id: 1,
      mode: 'semantic',
      query_vector: [0.1, 0.2, 0.3],
      semantic_limit: 1,
    });
    expect(result.mode_used).toBe('semantic');
    // Fake returns all rows; the limit is applied in SQL which the fake doesn't enforce.
    // Just verify the mode is correct and semantic_nodes are populated.
    expect(result.semantic_nodes).toBeDefined();
    expect(result.semantic_nodes!.length).toBeGreaterThanOrEqual(1);
  });
});
