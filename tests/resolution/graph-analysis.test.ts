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
    // Connected components should group modules A and B
    expect(summary.connectedComponents.length).toBeGreaterThanOrEqual(1);
  });
});
