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
    expect(clusters.length).toBeGreaterThanOrEqual(1);
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
    // Each module should have symbolCount > 0
    expect(summary.modules[0]!.symbolCount).toBe(1);
    expect(summary.modules[0]!.totalLines).toBe(10);
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
