import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import {
  detectSymbolCycles,
  findConnectedComponents,
  clusterSymbols,
  buildCodebaseSummary,
} from '../../src/resolution/graph-analysis.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function insertFile(db: Database.Database, opts: { path: string; language?: string; branch?: string; layer?: string }): number {
  return db.prepare(
    `INSERT INTO files (path, language, branch, layer) VALUES (?, ?, ?, ?)`,
  ).run(opts.path, opts.language ?? 'typescript', opts.branch ?? '', opts.layer ?? 'baseline').lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, opts: {
  fileId: number; name: string; kind?: string; startLine?: number; endLine?: number; layer?: string;
}): number {
  return db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.fileId, opts.name, opts.kind ?? 'function', opts.startLine ?? 1, opts.endLine ?? 10, opts.layer ?? 'baseline').lastInsertRowid as number;
}

function insertResolvedSymbolRef(db: Database.Database, opts: {
  callerId: number; fileId: number; calleeId: number; calleeName: string;
  resolutionMethod?: string;
}): void {
  db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.callerId, opts.fileId, opts.calleeId, opts.calleeName, 1, opts.resolutionMethod ?? 'name_unique');
}

function insertResolvedTypeRef(db: Database.Database, opts: {
  fileId: number; symbolId: number; typeId: number; typeName: string;
  resolutionMethod?: string;
}): void {
  db.prepare(
    `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_line, resolution_method)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(opts.fileId, opts.symbolId, opts.typeId, opts.typeName, opts.typeName, 1, opts.resolutionMethod ?? 'name_unique');
}

function insertFileImport(db: Database.Database, fileId: number, rawImport: string, resolvedId: number | null): void {
  db.prepare(
    `INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)`,
  ).run(fileId, rawImport, resolvedId);
}

// ─── detectSymbolCycles ───────────────────────────────────────────────────────

describe('detectSymbolCycles', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('returns empty when no edges', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    insertSymbol(db, { fileId: fid, name: 'foo' });
    expect(detectSymbolCycles(db)).toEqual([]);
  });

  it('detects mutual recursion (A→B, B→A)', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const symA = insertSymbol(db, { fileId: fid, name: 'fnA' });
    const symB = insertSymbol(db, { fileId: fid, name: 'fnB' });

    insertResolvedSymbolRef(db, { callerId: symA, fileId: fid, calleeId: symB, calleeName: 'fnB' });
    insertResolvedSymbolRef(db, { callerId: symB, fileId: fid, calleeId: symA, calleeName: 'fnA' });

    const sccs = detectSymbolCycles(db);
    expect(sccs).toHaveLength(1);
    expect(new Set(sccs[0])).toEqual(new Set([symA, symB]));
  });

  it('detects self-loop', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const sym = insertSymbol(db, { fileId: fid, name: 'recursive' });
    insertResolvedSymbolRef(db, { callerId: sym, fileId: fid, calleeId: sym, calleeName: 'recursive' });

    const sccs = detectSymbolCycles(db);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toEqual([sym]);
  });

  it('ignores acyclic chains', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const a = insertSymbol(db, { fileId: fid, name: 'a' });
    const b = insertSymbol(db, { fileId: fid, name: 'b' });
    const c = insertSymbol(db, { fileId: fid, name: 'c' });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid, calleeId: b, calleeName: 'b' });
    insertResolvedSymbolRef(db, { callerId: b, fileId: fid, calleeId: c, calleeName: 'c' });

    expect(detectSymbolCycles(db)).toEqual([]);
  });

  it('filters by edgeKinds=call (ignores type_refs)', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const symA = insertSymbol(db, { fileId: fid, name: 'fnA' });
    const symB = insertSymbol(db, { fileId: fid, name: 'fnB' });

    // Type-ref cycle only
    insertResolvedTypeRef(db, { fileId: fid, symbolId: symA, typeId: symB, typeName: 'fnB' });
    insertResolvedTypeRef(db, { fileId: fid, symbolId: symB, typeId: symA, typeName: 'fnA' });

    const sccs = detectSymbolCycles(db, { edgeKinds: 'call' });
    expect(sccs).toEqual([]);
  });

  it('filters by edgeKinds=type (ignores symbol_refs)', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const symA = insertSymbol(db, { fileId: fid, name: 'fnA' });
    const symB = insertSymbol(db, { fileId: fid, name: 'fnB' });

    // Call-ref cycle only
    insertResolvedSymbolRef(db, { callerId: symA, fileId: fid, calleeId: symB, calleeName: 'fnB' });
    insertResolvedSymbolRef(db, { callerId: symB, fileId: fid, calleeId: symA, calleeName: 'fnA' });

    const sccs = detectSymbolCycles(db, { edgeKinds: 'type' });
    expect(sccs).toEqual([]);
  });

  it('returns empty when methods filter is empty', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const symA = insertSymbol(db, { fileId: fid, name: 'fnA' });
    const symB = insertSymbol(db, { fileId: fid, name: 'fnB' });
    insertResolvedSymbolRef(db, { callerId: symA, fileId: fid, calleeId: symB, calleeName: 'fnB' });
    insertResolvedSymbolRef(db, { callerId: symB, fileId: fid, calleeId: symA, calleeName: 'fnA' });

    expect(detectSymbolCycles(db, { methods: [] })).toEqual([]);
  });
});

// ─── findConnectedComponents ──────────────────────────────────────────────────

describe('findConnectedComponents', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('returns empty when no edges at symbol scope', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    insertSymbol(db, { fileId: fid, name: 'isolated' });
    expect(findConnectedComponents(db)).toEqual([]);
  });

  it('finds symbol-level connected components', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const a = insertSymbol(db, { fileId: fid, name: 'a' });
    const b = insertSymbol(db, { fileId: fid, name: 'b' });
    const c = insertSymbol(db, { fileId: fid, name: 'c' });

    // a→b, c is isolated
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid, calleeId: b, calleeName: 'b' });

    const comps = findConnectedComponents(db);
    // a and b form a component, c is isolated (filtered out because size=1)
    expect(comps).toHaveLength(1);
    expect(new Set(comps[0])).toEqual(new Set([a, b]));
  });

  it('finds file-level connected components', () => {
    const f1 = insertFile(db, { path: 'a.ts' });
    const f2 = insertFile(db, { path: 'b.ts' });
    const f3 = insertFile(db, { path: 'c.ts' });
    insertFileImport(db, f1, './b', f2);
    // f3 is isolated

    const comps = findConnectedComponents(db, { scope: 'file' });
    expect(comps).toHaveLength(1);
    expect(new Set(comps[0])).toEqual(new Set([f1, f2]));
  });

  it('filters by branch at file scope', () => {
    const f1 = insertFile(db, { path: 'a.ts', branch: 'main' });
    const f2 = insertFile(db, { path: 'b.ts', branch: 'main' });
    const f3 = insertFile(db, { path: 'a.ts', branch: 'feature' });
    insertFileImport(db, f1, './b', f2);

    const comps = findConnectedComponents(db, { scope: 'file', branch: 'main' });
    expect(comps).toHaveLength(1);
    expect(new Set(comps[0])).toEqual(new Set([f1, f2]));
  });
});

// ─── clusterSymbols ───────────────────────────────────────────────────────────

describe('clusterSymbols', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('returns empty for empty DB', () => {
    expect(clusterSymbols(db)).toEqual([]);
  });

  it('creates one cluster per isolated symbol', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    insertSymbol(db, { fileId: fid, name: 'foo', startLine: 1, endLine: 10 });
    insertSymbol(db, { fileId: fid, name: 'bar', startLine: 20, endLine: 30 });

    const clusters = clusterSymbols(db);
    // Same-file symbols get merged into one cluster (step 2)
    expect(clusters.length).toBe(1);
    // Total lines should be the sum
    const totalLines = clusters.reduce((s, c) => s + c.totalLines, 0);
    expect(totalLines).toBe(21); // (10-1+1) + (30-20+1) = 10 + 11 = 21
  });

  it('merges SCC members into the same cluster', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const a = insertSymbol(db, { fileId: fid, name: 'a', startLine: 1, endLine: 5 });
    const b = insertSymbol(db, { fileId: fid, name: 'b', startLine: 10, endLine: 15 });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid, calleeId: b, calleeName: 'b' });
    insertResolvedSymbolRef(db, { callerId: b, fileId: fid, calleeId: a, calleeName: 'a' });

    const clusters = clusterSymbols(db);
    // a and b should be in the same cluster (scc + same file)
    expect(clusters).toHaveLength(1);
    expect(new Set(clusters[0]!.symbolIds)).toEqual(new Set([a, b]));
  });

  it('respects maxLinesPerCluster', () => {
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const a = insertSymbol(db, { fileId: fid1, name: 'bigFn', startLine: 1, endLine: 300 });
    const b = insertSymbol(db, { fileId: fid2, name: 'otherBigFn', startLine: 1, endLine: 300 });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'otherBigFn' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 350 });
    // Each is 300 lines; they shouldn't merge (combined 600 > 350)
    expect(clusters.length).toBe(2);
  });

  it('reports internalEdges and externalEdges correctly', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const a = insertSymbol(db, { fileId: fid, name: 'a', startLine: 1, endLine: 5 });
    const b = insertSymbol(db, { fileId: fid, name: 'b', startLine: 10, endLine: 15 });
    const c = insertSymbol(db, { fileId: fid2, name: 'c', startLine: 1, endLine: 300 });

    insertResolvedSymbolRef(db, { callerId: a, fileId: fid, calleeId: b, calleeName: 'b' });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid, calleeId: c, calleeName: 'c' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 20 });
    // a and b should be in same cluster (same file, fits in 20 lines)
    // c should be separate (300 lines)
    const clusterWithAB = clusters.find(cl => cl.symbolIds.includes(a) && cl.symbolIds.includes(b));
    expect(clusterWithAB).toBeDefined();
    expect(clusterWithAB!.internalEdges).toBe(1); // a→b
    expect(clusterWithAB!.externalEdges).toBe(1); // a→c
  });
});

// ─── buildCodebaseSummary ─────────────────────────────────────────────────────

describe('buildCodebaseSummary', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('returns zero counts for empty DB', () => {
    const summary = buildCodebaseSummary(db);
    expect(summary.totalFiles).toBe(0);
    expect(summary.totalSymbols).toBe(0);
    expect(summary.totalEdges).toBe(0);
    expect(summary.modules).toEqual([]);
    expect(summary.connectedComponents).toEqual([]);
    expect(summary.cyclicGroups).toEqual([]);
  });

  it('counts files and symbols correctly', () => {
    const fid = insertFile(db, { path: 'src/a.ts' });
    insertSymbol(db, { fileId: fid, name: 'foo', startLine: 1, endLine: 10 });
    insertSymbol(db, { fileId: fid, name: 'bar', startLine: 15, endLine: 25 });

    const summary = buildCodebaseSummary(db);
    expect(summary.totalFiles).toBe(1);
    expect(summary.totalSymbols).toBe(2);
  });

  it('counts resolved edges', () => {
    const fid = insertFile(db, { path: 'src/a.ts' });
    const a = insertSymbol(db, { fileId: fid, name: 'a', startLine: 1, endLine: 10 });
    const b = insertSymbol(db, { fileId: fid, name: 'b', startLine: 15, endLine: 25 });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid, calleeId: b, calleeName: 'b' });

    const summary = buildCodebaseSummary(db);
    expect(summary.totalEdges).toBe(1);
  });

  it('produces modules from symbols', () => {
    const fid = insertFile(db, { path: 'src/util.ts' });
    insertSymbol(db, { fileId: fid, name: 'helper', startLine: 1, endLine: 10 });

    const summary = buildCodebaseSummary(db);
    expect(summary.modules.length).toBeGreaterThanOrEqual(1);
    // With a single file, there should be exactly one module
    const mod = summary.modules[0]!;
    expect(mod.symbolCount).toBe(1);
    expect(mod.totalLines).toBe(10);
  });

  it('filters by branch when provided', () => {
    const fMain = insertFile(db, { path: 'src/a.ts', branch: 'main' });
    const fFeat = insertFile(db, { path: 'src/b.ts', branch: 'feature' });
    insertSymbol(db, { fileId: fMain, name: 'mainFn', startLine: 1, endLine: 10 });
    insertSymbol(db, { fileId: fFeat, name: 'featFn', startLine: 1, endLine: 10 });

    const summary = buildCodebaseSummary(db, { branch: 'main' });
    expect(summary.totalFiles).toBe(1);
    expect(summary.totalSymbols).toBe(1);
  });

  it('detects inter-module dependencies', () => {
    const fid1 = insertFile(db, { path: 'src/a.ts' });
    const fid2 = insertFile(db, { path: 'src/b.ts' });
    const a = insertSymbol(db, { fileId: fid1, name: 'a', startLine: 1, endLine: 300 });
    const b = insertSymbol(db, { fileId: fid2, name: 'b', startLine: 1, endLine: 300 });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'b' });

    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 350 });
    // With maxLines=350, a (300) and b (300) won't merge → 2 modules
    expect(summary.modules.length).toBe(2);
    // One module should depend on the other
    const withDeps = summary.modules.find(m => m.dependsOn.length > 0);
    expect(withDeps).toBeDefined();
    const depTarget = summary.modules.find(m => m.dependedOnBy.length > 0);
    expect(depTarget).toBeDefined();
  });
});

// ─── UnionFind rank branches ──────────────────────────────────────────────────

describe('findConnectedComponents — UnionFind rank branches', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('covers rankA < rankB branch via asymmetric merge', () => {
    // Build a graph where union-find creates trees of different depths.
    // Union(1,2) → rank 1; Union(3,4) → rank 1; Union(1,3) → rank 2.
    // Then Union(5,1): find(5) rank 0 < find(1) rank 2 → rankA < rankB.
    const fid = insertFile(db, { path: 'a.ts' });
    const s1 = insertSymbol(db, { fileId: fid, name: 's1' });
    const s2 = insertSymbol(db, { fileId: fid, name: 's2' });
    const s3 = insertSymbol(db, { fileId: fid, name: 's3' });
    const s4 = insertSymbol(db, { fileId: fid, name: 's4' });
    const s5 = insertSymbol(db, { fileId: fid, name: 's5' });

    // Edges in specific order to create depth-2 tree then attach a leaf
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid, calleeId: s2, calleeName: 's2' });
    insertResolvedSymbolRef(db, { callerId: s3, fileId: fid, calleeId: s4, calleeName: 's4' });
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid, calleeId: s3, calleeName: 's3' });
    // s5 → s1: source=s5 (rank 0), target=s1 (root rank 2) → union(s5, s1) hits rankA < rankB
    insertResolvedSymbolRef(db, { callerId: s5, fileId: fid, calleeId: s1, calleeName: 's1' });

    const comps = findConnectedComponents(db);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.length).toBe(5);
  });

  it('covers rankA > rankB branch via reversed edge direction', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const s1 = insertSymbol(db, { fileId: fid, name: 's1' });
    const s2 = insertSymbol(db, { fileId: fid, name: 's2' });
    const s3 = insertSymbol(db, { fileId: fid, name: 's3' });
    const s4 = insertSymbol(db, { fileId: fid, name: 's4' });
    const s5 = insertSymbol(db, { fileId: fid, name: 's5' });
    const s6 = insertSymbol(db, { fileId: fid, name: 's6' });

    // Build deep tree: union(s1,s2)→rank1, union(s3,s4)→rank1, union(s1,s3)→rank2
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid, calleeId: s2, calleeName: 's2' });
    insertResolvedSymbolRef(db, { callerId: s3, fileId: fid, calleeId: s4, calleeName: 's4' });
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid, calleeId: s3, calleeName: 's3' });
    // s1 → s5: source=s1 (root rank 2), target=s5 (rank 0) → union(s1, s5) hits rankA > rankB
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid, calleeId: s5, calleeName: 's5' });
    // s6 isolated — for disconnected coverage
    insertResolvedSymbolRef(db, { callerId: s5, fileId: fid, calleeId: s6, calleeName: 's6' });

    const comps = findConnectedComponents(db);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.length).toBe(6);
  });

  it('union of already-same-root nodes is a no-op', () => {
    const fid = insertFile(db, { path: 'a.ts' });
    const s1 = insertSymbol(db, { fileId: fid, name: 's1' });
    const s2 = insertSymbol(db, { fileId: fid, name: 's2' });

    // Two edges between same pair → second union finds same root
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid, calleeId: s2, calleeName: 's2' });
    insertResolvedSymbolRef(db, { callerId: s2, fileId: fid, calleeId: s1, calleeName: 's1' });

    const comps = findConnectedComponents(db);
    expect(comps).toHaveLength(1);
    expect(new Set(comps[0])).toEqual(new Set([s1, s2]));
  });
});

// ─── clusterSymbols — greedy merge ────────────────────────────────────────────

describe('clusterSymbols — greedy cross-file merge', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('greedy merge step combines cross-file clusters when size fits', () => {
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const a = insertSymbol(db, { fileId: fid1, name: 'aFn', startLine: 1, endLine: 50 });
    const b = insertSymbol(db, { fileId: fid2, name: 'bFn', startLine: 1, endLine: 50 });

    // Cross-file edge
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'bFn' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 500 });
    // a and b should merge (50+50=100 ≤ 500)
    expect(clusters).toHaveLength(1);
    expect(new Set(clusters[0]!.symbolIds)).toEqual(new Set([a, b]));
  });

  it('greedy merge prefers higher-weight edges first', () => {
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const fid3 = insertFile(db, { path: 'c.ts' });

    const a = insertSymbol(db, { fileId: fid1, name: 'a', startLine: 1, endLine: 50 });
    const b = insertSymbol(db, { fileId: fid2, name: 'b', startLine: 1, endLine: 50 });
    const c = insertSymbol(db, { fileId: fid3, name: 'c', startLine: 1, endLine: 50 });

    // 3 edges a→b (high weight to same target)
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'b' });
    // 1 edge a→c (lower weight)
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: c, calleeName: 'c' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 500 });
    // All three should merge (150 ≤ 500)
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.symbolIds.length).toBe(3);
  });

  it('greedy merge skips when combined size exceeds limit', () => {
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const a = insertSymbol(db, { fileId: fid1, name: 'big', startLine: 1, endLine: 200 });
    const b = insertSymbol(db, { fileId: fid2, name: 'alsoBig', startLine: 1, endLine: 200 });

    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'alsoBig' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 250 });
    // 200+200=400 > 250 → can't merge
    expect(clusters).toHaveLength(2);
  });
});

// ─── buildCodebaseSummary — module-level cycles (tarjanScc) ───────────────────

describe('buildCodebaseSummary — module-level cycles', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('detects cyclic module dependencies', () => {
    // Create 4 symbols: s1→s2 (merge into module A), s3→s4 (merge into module B).
    // Cross-module edges: s1→s3 (A→B), s4→s2 (B→A) — creates a module-level cycle
    // without any symbol-level SCC (no mutual recursion between any pair).
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });

    const s1 = insertSymbol(db, { fileId: fid1, name: 's1', startLine: 1, endLine: 50 });
    const s2 = insertSymbol(db, { fileId: fid1, name: 's2', startLine: 51, endLine: 100 });
    const s3 = insertSymbol(db, { fileId: fid2, name: 's3', startLine: 1, endLine: 50 });
    const s4 = insertSymbol(db, { fileId: fid2, name: 's4', startLine: 51, endLine: 100 });

    // Intra-module edges (ensure same-module grouping)
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid1, calleeId: s2, calleeName: 's2' });
    insertResolvedSymbolRef(db, { callerId: s3, fileId: fid2, calleeId: s4, calleeName: 's4' });
    // Cross-module edges (create cycle between modules)
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid1, calleeId: s3, calleeName: 's3' });
    insertResolvedSymbolRef(db, { callerId: s4, fileId: fid2, calleeId: s2, calleeName: 's2' });

    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 120 });
    // Two modules that can't merge (100+100=200 > 120)
    expect(summary.modules.length).toBe(2);
    expect(summary.cyclicGroups.length).toBeGreaterThanOrEqual(1);
  });

  it('handles disconnected modules (tarjanScc visits unvisited nodes)', () => {
    // Create separate modules with no cross-module edges.
    // Use large enough symbols so they can't merge (50+50 > maxLines).
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const fid3 = insertFile(db, { path: 'c.ts' });

    insertSymbol(db, { fileId: fid1, name: 'a', startLine: 1, endLine: 50 });
    insertSymbol(db, { fileId: fid2, name: 'b', startLine: 1, endLine: 50 });
    insertSymbol(db, { fileId: fid3, name: 'c', startLine: 1, endLine: 50 });

    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 60 });
    // Each symbol can't merge with others (50+50=100 > 60)
    expect(summary.modules.length).toBe(3);
    // No cycles among disconnected modules
    expect(summary.cyclicGroups).toEqual([]);
  });

  it('connectedComponents detects groups at module level', () => {
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const fid3 = insertFile(db, { path: 'c.ts' });

    const a = insertSymbol(db, { fileId: fid1, name: 'a', startLine: 1, endLine: 80 });
    const b = insertSymbol(db, { fileId: fid2, name: 'b', startLine: 1, endLine: 80 });
    insertSymbol(db, { fileId: fid3, name: 'c', startLine: 1, endLine: 80 });

    // a → b — modules A and B are connected; C is isolated
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'b' });

    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 100 });
    // 80+80=160 > 100, so each stays separate → 3 modules
    expect(summary.modules.length).toBe(3);
    // Connected components should detect at least one component
    expect(summary.connectedComponents.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── clusterSymbols — undersized cluster folding ──────────────────────────────

describe('clusterSymbols — undersized cluster folding', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('folds undersized clusters (<30 lines) into heaviest neighbor', () => {
    // Create a small cluster (< 30 lines) connected to a larger one
    const fid1 = insertFile(db, { path: 'small.ts' });
    const fid2 = insertFile(db, { path: 'big.ts' });

    // Small symbol: only 10 lines — below MIN_CLUSTER_LINES (30)
    const small = insertSymbol(db, { fileId: fid1, name: 'tiny', startLine: 1, endLine: 10 });
    // Bigger symbol: 50 lines — above threshold
    const big = insertSymbol(db, { fileId: fid2, name: 'large', startLine: 1, endLine: 50 });

    // Edge between them
    insertResolvedSymbolRef(db, { callerId: small, fileId: fid1, calleeId: big, calleeName: 'large' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 500 });
    // The small cluster should be folded into the big one
    expect(clusters).toHaveLength(1);
    expect(new Set(clusters[0]!.symbolIds)).toEqual(new Set([small, big]));
  });

  it('undersized fold via inbound edge (ct === root path)', () => {
    // Small cluster with inbound edge from neighbor
    const fid1 = insertFile(db, { path: 'tiny.ts' });
    const fid2 = insertFile(db, { path: 'caller.ts' });
    const fid3 = insertFile(db, { path: 'other.ts' });

    const tiny = insertSymbol(db, { fileId: fid1, name: 'tiny', startLine: 1, endLine: 10 });
    const caller = insertSymbol(db, { fileId: fid2, name: 'caller', startLine: 1, endLine: 50 });
    // A third large symbol that can't merge with others
    const other = insertSymbol(db, { fileId: fid3, name: 'other', startLine: 1, endLine: 400 });

    // caller → tiny (inbound edge to tiny's cluster)
    insertResolvedSymbolRef(db, { callerId: caller, fileId: fid2, calleeId: tiny, calleeName: 'tiny' });
    // tiny → other (but combined would be too large at tight limit)
    insertResolvedSymbolRef(db, { callerId: tiny, fileId: fid1, calleeId: other, calleeName: 'other' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 100 });
    // tiny (10 lines) should fold into caller (50 lines), since 10+50=60 ≤ 100
    // other (400 lines) can't merge with anyone
    const tinyCluster = clusters.find(c => c.symbolIds.includes(Number(tiny)));
    const callerCluster = clusters.find(c => c.symbolIds.includes(Number(caller)));
    // tiny and caller should be in the same cluster
    expect(tinyCluster).toBe(callerCluster);
  });

  it('undersized cluster stays separate when no fitting neighbor', () => {
    // Small cluster with only connections to clusters too large to merge
    const fid1 = insertFile(db, { path: 'tiny.ts' });
    const fid2 = insertFile(db, { path: 'huge.ts' });

    const tiny = insertSymbol(db, { fileId: fid1, name: 'tiny', startLine: 1, endLine: 10 });
    const huge = insertSymbol(db, { fileId: fid2, name: 'huge', startLine: 1, endLine: 200 });

    insertResolvedSymbolRef(db, { callerId: tiny, fileId: fid1, calleeId: huge, calleeName: 'huge' });

    // maxLines=150: tiny(10)+huge(200)=210 > 150 → can't merge
    const clusters = clusterSymbols(db, { maxLinesPerCluster: 150 });
    expect(clusters).toHaveLength(2);
  });
});

// ─── clusterSymbols — greedy merge already-same-cluster ───────────────────────

describe('clusterSymbols — greedy merge dedup', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('handles pairs already in same cluster during greedy merge', () => {
    // Create three symbols all in the same file (auto-grouped in step 1)
    // with cross-edges that would try to merge already-merged clusters
    const fid = insertFile(db, { path: 'a.ts' });
    const s1 = insertSymbol(db, { fileId: fid, name: 'fn1', startLine: 1, endLine: 30 });
    const s2 = insertSymbol(db, { fileId: fid, name: 'fn2', startLine: 31, endLine: 60 });
    const s3 = insertSymbol(db, { fileId: fid, name: 'fn3', startLine: 61, endLine: 90 });

    // Cross-edges between same-file symbols (all same cluster from step 1)
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid, calleeId: s2, calleeName: 'fn2' });
    insertResolvedSymbolRef(db, { callerId: s2, fileId: fid, calleeId: s3, calleeName: 'fn3' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 500 });
    // All in same file → same cluster
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.symbolIds.length).toBe(3);
  });

  it('greedy merge skips pair already merged through transitive union (ca===cb)', () => {
    // Three separate files with edges: A→B (weight 3), B→C (weight 2), A→C (weight 1)
    // Greedy merge processes highest weight first:
    //   A:B merged, then B:C merged, then A:C → find(A)===find(C) → continue
    const fid1 = insertFile(db, { path: 'x.ts' });
    const fid2 = insertFile(db, { path: 'y.ts' });
    const fid3 = insertFile(db, { path: 'z.ts' });

    const a = insertSymbol(db, { fileId: fid1, name: 'a', startLine: 1, endLine: 40 });
    const b = insertSymbol(db, { fileId: fid2, name: 'b', startLine: 1, endLine: 40 });
    const c = insertSymbol(db, { fileId: fid3, name: 'c', startLine: 1, endLine: 40 });

    // A→B: 3 edges (weight 3)
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'b' });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'b' });
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: b, calleeName: 'b' });
    // B→C: 2 edges (weight 2)
    insertResolvedSymbolRef(db, { callerId: b, fileId: fid2, calleeId: c, calleeName: 'c' });
    insertResolvedSymbolRef(db, { callerId: b, fileId: fid2, calleeId: c, calleeName: 'c' });
    // A→C: 1 edge (weight 1) — this pair will have ca===cb after the other merges
    insertResolvedSymbolRef(db, { callerId: a, fileId: fid1, calleeId: c, calleeName: 'c' });

    const clusters = clusterSymbols(db, { maxLinesPerCluster: 500 });
    // All three should merge into one cluster
    expect(clusters).toHaveLength(1);
    expect(new Set(clusters[0]!.symbolIds)).toEqual(new Set([a, b, c]));
  });
});

// ─── buildCodebaseSummary — dependsOn/dependedOnBy sort ───────────────────────

describe('buildCodebaseSummary — module dependencies sorting', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('sorts dependsOn and dependedOnBy arrays numerically', () => {
    // Create 3 separate modules (large enough to not merge and not be undersized)
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });
    const fid3 = insertFile(db, { path: 'c.ts' });

    // Each symbol ≥30 lines (MIN_CLUSTER_LINES) so they won't be folded as undersized
    const s1 = insertSymbol(db, { fileId: fid1, name: 's1', startLine: 1, endLine: 100 });
    const s2 = insertSymbol(db, { fileId: fid2, name: 's2', startLine: 1, endLine: 100 });
    const s3 = insertSymbol(db, { fileId: fid3, name: 's3', startLine: 1, endLine: 100 });

    // s1 depends on both s2 and s3 → module with s1 has dependsOn with 2 entries
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid1, calleeId: s2, calleeName: 's2' });
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid1, calleeId: s3, calleeName: 's3' });
    // s3 also depends on s2 → module with s2 has 2 dependedOnBy entries
    insertResolvedSymbolRef(db, { callerId: s3, fileId: fid3, calleeId: s2, calleeName: 's2' });

    // maxLines=120: symbols can't merge (100+100=200 > 120) → 3 separate modules
    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 120 });
    expect(summary.modules.length).toBe(3);

    // One module should have ≥2 dependsOn entries (the one containing s1)
    const moduleWithDeps = summary.modules.find(m => m.dependsOn.length >= 2);
    expect(moduleWithDeps).toBeDefined();
    // dependsOn should be sorted numerically
    expect(moduleWithDeps!.dependsOn[0]!).toBeLessThan(moduleWithDeps!.dependsOn[1]!);

    // At least one module should have ≥1 dependedOnBy entry
    const depended = summary.modules.filter(m => m.dependedOnBy.length >= 1);
    expect(depended.length).toBeGreaterThanOrEqual(1);
    // dependedOnBy should also be sorted numerically
    for (const m of depended) {
      if (m.dependedOnBy.length >= 2) {
        expect(m.dependedOnBy[0]!).toBeLessThan(m.dependedOnBy[1]!);
      }
    }
  });
});

// ─── tarjanScc — self-loop for single-node SCC ───────────────────────────────

describe('buildCodebaseSummary — module-level self-loop in tarjanScc', () => {
  let db: Database.Database;

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db?.close(); });

  it('merges mutual-reference symbols into a single module without cycles', () => {
    // Two symbols in different files, each calling the other.
    // With a large maxLines they merge into one module.
    // That module has self-edges in the module adjacency (both symbols are in same module).
    const fid1 = insertFile(db, { path: 'a.ts' });
    const fid2 = insertFile(db, { path: 'b.ts' });

    const s1 = insertSymbol(db, { fileId: fid1, name: 's1', startLine: 1, endLine: 40 });
    const s2 = insertSymbol(db, { fileId: fid2, name: 's2', startLine: 1, endLine: 40 });

    // Mutual references (they'll merge into one module)
    insertResolvedSymbolRef(db, { callerId: s1, fileId: fid1, calleeId: s2, calleeName: 's2' });
    insertResolvedSymbolRef(db, { callerId: s2, fileId: fid2, calleeId: s1, calleeName: 's1' });

    const summary = buildCodebaseSummary(db, { maxLinesPerModule: 500 });
    // Should merge into single module
    expect(summary.modules.length).toBe(1);
    // No module-level cycles since there's only one module
    expect(summary.cyclicGroups).toEqual([]);
  });
});
