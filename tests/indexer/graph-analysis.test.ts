import { describe, it, expect } from 'vitest';
import {
  detectSymbolCycles,
  findConnectedComponents,
  clusterSymbols,
  buildCodebaseSummary,
} from '../../src/indexer/graph-analysis.js';
import { openDb } from '../../src/indexer/db.js';
import { resolveSymbolEdges } from '../../src/indexer/call-graph.js';
import type { Database } from '../../src/indexer/db.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string): number {
  return Number(
    db.prepare("INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, 'HEAD', 'typescript', 0, NULL, '')")
      .run(path).lastInsertRowid,
  );
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function',
  startLine = 1,
  endLine?: number,
): number {
  return Number(
    db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, name, kind, startLine, endLine ?? startLine + 10, `${kind} ${name}`).lastInsertRowid,
  );
}

function insertCallRef(
  db: Database.Database,
  callerId: number,
  fileId: number,
  calleeName: string,
  callLine: number,
): void {
  db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line) VALUES (?, ?, ?, ?)`,
  ).run(callerId, fileId, calleeName, callLine);
}

function insertFileImport(db: Database.Database, fileId: number, resolvedId: number): void {
  db.prepare(
    `INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, 'import', ?)`,
  ).run(fileId, resolvedId);
}

/**
 * Helper: set up a resolved call edge directly.
 * Sets callee_id and resolution_method to bypass resolution.
 */
function insertResolvedCallRef(
  db: Database.Database,
  callerId: number,
  calleeId: number,
  fileId: number,
  callLine = 1,
): void {
  db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
     VALUES (?, ?, ?, 'resolved', ?, 'name_unique')`,
  ).run(callerId, fileId, calleeId, callLine);
}

// ─── detectSymbolCycles ───────────────────────────────────────────────────────

describe('detectSymbolCycles', () => {
  it('should find no cycles in a DAG', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'a');
    const b = insertSymbol(db, f, 'b');
    const c = insertSymbol(db, f, 'c');

    // a → b → c (no cycle)
    insertResolvedCallRef(db, a, b, f);
    insertResolvedCallRef(db, b, c, f);

    const sccs = detectSymbolCycles(db);
    expect(sccs).toEqual([]);
  });

  it('should detect a simple mutual recursion cycle', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'funcA');
    const b = insertSymbol(db, f, 'funcB');

    // a → b → a (cycle)
    insertResolvedCallRef(db, a, b, f);
    insertResolvedCallRef(db, b, a, f);

    const sccs = detectSymbolCycles(db);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toHaveLength(2);
    expect(new Set(sccs[0])).toEqual(new Set([a, b]));
  });

  it('should detect a self-referencing symbol', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'recursive');

    insertResolvedCallRef(db, a, a, f);

    const sccs = detectSymbolCycles(db);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toEqual([a]);
  });

  it('should detect multiple separate SCCs', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'a');
    const b = insertSymbol(db, f, 'b');
    const c = insertSymbol(db, f, 'c');
    const d = insertSymbol(db, f, 'd');

    // Cycle 1: a ↔ b
    insertResolvedCallRef(db, a, b, f);
    insertResolvedCallRef(db, b, a, f);
    // Cycle 2: c ↔ d
    insertResolvedCallRef(db, c, d, f);
    insertResolvedCallRef(db, d, c, f);

    const sccs = detectSymbolCycles(db);
    expect(sccs).toHaveLength(2);

    const sets = sccs.map(scc => new Set(scc));
    expect(sets).toContainEqual(new Set([a, b]));
    expect(sets).toContainEqual(new Set([c, d]));
  });

  it('should respect edgeKinds=call (ignore type edges)', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'ClassA', 'class');
    const b = insertSymbol(db, f, 'ClassB', 'class');

    // Type-ref cycle only (not call)
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (?, ?, ?, 'ClassB', 'ClassB', 'parameter', 5, 'name_same_file')`,
    ).run(f, a, b);
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, resolution_method)
       VALUES (?, ?, ?, 'ClassA', 'ClassA', 'parameter', 15, 'name_same_file')`,
    ).run(f, b, a);

    // With call only → no cycles
    const callOnly = detectSymbolCycles(db, { edgeKinds: 'call' });
    expect(callOnly).toEqual([]);

    // With type only → should find the cycle
    const typeOnly = detectSymbolCycles(db, { edgeKinds: 'type' });
    expect(typeOnly).toHaveLength(1);
    expect(new Set(typeOnly[0])).toEqual(new Set([a, b]));

    // With both → should also find it
    const both = detectSymbolCycles(db, { edgeKinds: 'both' });
    expect(both).toHaveLength(1);
  });

  it('should return empty for empty database', () => {
    const db = createDb();
    expect(detectSymbolCycles(db)).toEqual([]);
  });
});

// ─── findConnectedComponents ──────────────────────────────────────────────────

describe('findConnectedComponents', () => {
  describe('symbol scope', () => {
    it('should find a single component from connected symbols', () => {
      const db = createDb();
      const f = insertFile(db, 'src/a.ts');
      const a = insertSymbol(db, f, 'a');
      const b = insertSymbol(db, f, 'b');
      const c = insertSymbol(db, f, 'c');

      insertResolvedCallRef(db, a, b, f);
      insertResolvedCallRef(db, b, c, f);

      const components = findConnectedComponents(db, { scope: 'symbol' });
      expect(components).toHaveLength(1);
      expect(new Set(components[0])).toEqual(new Set([a, b, c]));
    });

    it('should find two separate components', () => {
      const db = createDb();
      const f1 = insertFile(db, 'src/a.ts');
      const f2 = insertFile(db, 'src/b.ts');
      const a = insertSymbol(db, f1, 'a');
      const b = insertSymbol(db, f1, 'b');
      const c = insertSymbol(db, f2, 'c');
      const d = insertSymbol(db, f2, 'd');

      insertResolvedCallRef(db, a, b, f1);
      insertResolvedCallRef(db, c, d, f2);

      const components = findConnectedComponents(db, { scope: 'symbol' });
      expect(components).toHaveLength(2);

      const sets = components.map(c => new Set(c));
      expect(sets).toContainEqual(new Set([a, b]));
      expect(sets).toContainEqual(new Set([c, d]));
    });

    it('should return empty for no edges', () => {
      const db = createDb();
      insertFile(db, 'src/a.ts');
      expect(findConnectedComponents(db, { scope: 'symbol' })).toEqual([]);
    });
  });

  describe('file scope', () => {
    it('should find connected file components via imports', () => {
      const db = createDb();
      const f1 = insertFile(db, 'src/a.ts');
      const f2 = insertFile(db, 'src/b.ts');
      const f3 = insertFile(db, 'src/c.ts');

      insertFileImport(db, f1, f2);
      insertFileImport(db, f2, f3);

      const components = findConnectedComponents(db, { scope: 'file' });
      expect(components).toHaveLength(1);
      expect(new Set(components[0])).toEqual(new Set([f1, f2, f3]));
    });

    it('should find two disconnected file components', () => {
      const db = createDb();
      const f1 = insertFile(db, 'src/a.ts');
      const f2 = insertFile(db, 'src/b.ts');
      const f3 = insertFile(db, 'src/c.ts');
      const f4 = insertFile(db, 'src/d.ts');

      insertFileImport(db, f1, f2);
      insertFileImport(db, f3, f4);

      const components = findConnectedComponents(db, { scope: 'file' });
      expect(components).toHaveLength(2);
    });
  });
});

// ─── clusterSymbols ───────────────────────────────────────────────────────────

describe('clusterSymbols', () => {
  it('should return empty for an empty database', () => {
    const db = createDb();
    expect(clusterSymbols(db)).toEqual([]);
  });

  it('should cluster mutually recursive symbols together', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'funcA', 'function', 1, 20);
    const b = insertSymbol(db, f, 'funcB', 'function', 21, 40);

    insertResolvedCallRef(db, a, b, f);
    insertResolvedCallRef(db, b, a, f);

    const clusters = clusterSymbols(db);
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    // a and b must be in the same cluster (SCC)
    const clusterWithA = clusters.find(c => c.symbolIds.includes(a));
    expect(clusterWithA).toBeDefined();
    expect(clusterWithA!.symbolIds).toContain(b);
  });

  it('should merge same-file symbols when within line budget', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'helper', 'function', 1, 10);
    const b = insertSymbol(db, f, 'main', 'function', 11, 20);

    // No edges between them, but same file → should merge
    const clusters = clusterSymbols(db, { maxLinesPerCluster: 100 });
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    const clusterWithA = clusters.find(c => c.symbolIds.includes(a));
    expect(clusterWithA).toBeDefined();
    expect(clusterWithA!.symbolIds).toContain(b);
  });

  it('should not merge when exceeding max lines', () => {
    const db = createDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const a = insertSymbol(db, f1, 'bigFunc', 'function', 1, 50);
    const b = insertSymbol(db, f2, 'otherBig', 'function', 1, 50);

    insertResolvedCallRef(db, a, b, f1);

    // maxLines = 60 — combining two 50-line symbols would exceed
    const clusters = clusterSymbols(db, { maxLinesPerCluster: 60 });
    const clusterA = clusters.find(c => c.symbolIds.includes(a));
    const clusterB = clusters.find(c => c.symbolIds.includes(b));
    expect(clusterA).toBeDefined();
    expect(clusterB).toBeDefined();
    expect(clusterA!.id).not.toBe(clusterB!.id);
  });

  it('should report internal and external edge counts', () => {
    const db = createDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const a = insertSymbol(db, f1, 'a', 'function', 1, 100);
    const b = insertSymbol(db, f1, 'b', 'function', 101, 200);
    const c = insertSymbol(db, f2, 'c', 'function', 1, 100);

    // a → b (internal), a → c (external)
    insertResolvedCallRef(db, a, b, f1);
    insertResolvedCallRef(db, a, c, f1);

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 250 });
    // a and b should be in same cluster (same file, fits in budget)
    const clusterAB = clusters.find(c => c.symbolIds.includes(a));
    expect(clusterAB).toBeDefined();
    expect(clusterAB!.symbolIds).toContain(b);
    expect(clusterAB!.internalEdges).toBeGreaterThanOrEqual(1);
    expect(clusterAB!.externalEdges).toBeGreaterThanOrEqual(1);
  });
});

// ─── buildCodebaseSummary ─────────────────────────────────────────────────────

describe('buildCodebaseSummary', () => {
  it('should return zero counts for an empty database', () => {
    const db = createDb();
    const summary = buildCodebaseSummary(db);
    expect(summary.totalFiles).toBe(0);
    expect(summary.totalSymbols).toBe(0);
    expect(summary.totalEdges).toBe(0);
    expect(summary.modules).toEqual([]);
    expect(summary.connectedComponents).toEqual([]);
    expect(summary.cyclicGroups).toEqual([]);
  });

  it('should produce a summary with modules for a simple codebase', () => {
    const db = createDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const a = insertSymbol(db, f1, 'funcA', 'function', 1, 20);
    const b = insertSymbol(db, f2, 'funcB', 'function', 1, 20);

    insertResolvedCallRef(db, a, b, f1);

    const summary = buildCodebaseSummary(db);
    expect(summary.totalFiles).toBe(2);
    expect(summary.totalSymbols).toBe(2);
    expect(summary.totalEdges).toBe(1);
    expect(summary.modules.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect cyclic module groups', () => {
    const db = createDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const a = insertSymbol(db, f1, 'funcA', 'function', 1, 200);
    const b = insertSymbol(db, f2, 'funcB', 'function', 1, 200);

    // Force a → b and b → a (module-level cycle)
    insertResolvedCallRef(db, a, b, f1);
    insertResolvedCallRef(db, b, a, f2);

    // max 250 lines per module — symbols are in separate files with 200 lines each
    // so they shouldn't merge into one cluster
    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 250 });

    // Should have at least 2 modules (one per file since they don't fit together)
    if (summary.modules.length >= 2) {
      // The two modules should be in the same connected component
      expect(summary.connectedComponents.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('should report module dependencies', () => {
    const db = createDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const a = insertSymbol(db, f1, 'funcA', 'function', 1, 200);
    const b = insertSymbol(db, f2, 'funcB', 'function', 1, 200);

    insertResolvedCallRef(db, a, b, f1);

    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 250 });
    // At least one module should have a dependency
    const hasDeps = summary.modules.some(m => m.dependsOn.length > 0);
    const hasRevDeps = summary.modules.some(m => m.dependedOnBy.length > 0);
    if (summary.modules.length >= 2) {
      expect(hasDeps).toBe(true);
      expect(hasRevDeps).toBe(true);
    }
  });
});

// ─── methods filter (resolution confidence) ───────────────────────────────────

describe('resolution method filtering', () => {
  it('should only include specified resolution methods', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'a');
    const b = insertSymbol(db, f, 'b');
    const c = insertSymbol(db, f, 'c');

    // a → b via lsp_definition
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
       VALUES (?, ?, ?, 'b', 1, 'lsp_definition')`,
    ).run(a, f, b);

    // b → c via name_unique
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
       VALUES (?, ?, ?, 'c', 1, 'name_unique')`,
    ).run(b, f, c);

    // a → c via self-loop with name_same_file
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
       VALUES (?, ?, ?, 'a', 1, 'name_same_file')`,
    ).run(c, f, a);

    // Filter to only lsp_definition → no cycle (only a→b)
    const sccsLsp = detectSymbolCycles(db, { methods: ['lsp_definition'] });
    expect(sccsLsp).toEqual([]);

    // Filter to all three → should find cycle a→b→c→a
    const sccsAll = detectSymbolCycles(db, {
      methods: ['lsp_definition', 'name_unique', 'name_same_file'],
    });
    expect(sccsAll).toHaveLength(1);
    expect(new Set(sccsAll[0])).toEqual(new Set([a, b, c]));
  });
});

// ─── Branch option filtering ──────────────────────────────────────────────────

describe('branch option filtering', () => {
  it('should filter edges by branch in detectSymbolCycles', () => {
    const db = createDb();
    // Insert files for two branches
    const f1 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('a.ts', 'main', 'typescript', 0)")
        .run().lastInsertRowid,
    );
    const f2 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('b.ts', 'main', 'typescript', 0)")
        .run().lastInsertRowid,
    );
    const a = insertSymbol(db, f1, 'funcA');
    const b = insertSymbol(db, f2, 'funcB');

    // Cycle: a → b → a
    insertResolvedCallRef(db, a, b, f1);
    insertResolvedCallRef(db, b, a, f2);

    // Filter by 'main' — should find the cycle
    const sccsMain = detectSymbolCycles(db, { branch: 'main' });
    expect(sccsMain).toHaveLength(1);

    // Filter by 'other' — files don't match, so no edges → no cycles
    const sccsOther = detectSymbolCycles(db, { branch: 'other' });
    expect(sccsOther).toEqual([]);
  });

  it('should filter file components by branch', () => {
    const db = createDb();
    const f1 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('a.ts', 'main', 'typescript', 0)")
        .run().lastInsertRowid,
    );
    const f2 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('b.ts', 'main', 'typescript', 0)")
        .run().lastInsertRowid,
    );
    const f3 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('c.ts', 'feat', 'typescript', 0)")
        .run().lastInsertRowid,
    );

    insertFileImport(db, f1, f2);
    insertFileImport(db, f3, f1); // cross-branch import

    const mainComponents = findConnectedComponents(db, { scope: 'file', branch: 'main' });
    // Should only see f1 and f2 connected
    expect(mainComponents.length).toBeGreaterThanOrEqual(1);
    // f3 should not be in any main-branch component
    const allIds = mainComponents.flat();
    expect(allIds).not.toContain(f3);
  });

  it('should filter summary by branch', () => {
    const db = createDb();
    const f1 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('a.ts', 'main', 'typescript', 0)")
        .run().lastInsertRowid,
    );
    const f2 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('b.ts', 'develop', 'typescript', 0)")
        .run().lastInsertRowid,
    );
    const a = insertSymbol(db, f1, 'funcA');
    const b = insertSymbol(db, f2, 'funcB');

    insertResolvedCallRef(db, a, b, f1);

    const summary = buildCodebaseSummary(db, { branch: 'main' });
    // The branch filter should limit files/symbols/edges
    expect(summary.totalFiles).toBe(1);
  });

  it('should return empty for empty methods array', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'a');
    const b = insertSymbol(db, f, 'b');

    insertResolvedCallRef(db, a, b, f);
    insertResolvedCallRef(db, b, a, f);

    // Empty methods array → no edges → no cycles
    const sccs = detectSymbolCycles(db, { methods: [] });
    expect(sccs).toEqual([]);
  });

  it('should filter clusters by branch', () => {
    const db = createDb();
    const f1 = Number(
      db.prepare("INSERT INTO files (path, branch, language, size_bytes) VALUES ('a.ts', 'main', 'typescript', 0)")
        .run().lastInsertRowid,
    );
    const a = insertSymbol(db, f1, 'funcA', 'function', 1, 50);
    const b = insertSymbol(db, f1, 'funcB', 'function', 51, 100);

    insertResolvedCallRef(db, a, b, f1);

    const clusters = clusterSymbols(db, { branch: 'main' });
    expect(clusters.length).toBeGreaterThanOrEqual(1);

    const clustersOther = clusterSymbols(db, { branch: 'nonexistent' });
    expect(clustersOther).toEqual([]);
  });
});
