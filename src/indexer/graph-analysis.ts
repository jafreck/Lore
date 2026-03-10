/**
 * @module indexer/graph-analysis
 *
 * Higher-level graph analysis primitives operating on the SQLite
 * knowledge-base:
 *
 *  - `detectSymbolCycles(db, opts)` — Tarjan's SCC on the symbol adjacency
 *    graph (call_refs, type_refs, or both).
 *  - `findConnectedComponents(db, opts)` — union-find connected components
 *    at file or symbol scope.
 *  - `clusterSymbols(db, opts)` — partitions the call graph into bounded-
 *    size coherent chunks via SCC contraction, same-file merge, greedy
 *    edge-weight consolidation, and affinity folding.
 *  - `buildCodebaseSummary(db, opts)` — condensed dependency summary with
 *    per-module files, symbol counts, line spans, and SCCs.
 */

import type { Database } from './db.js';
import type { ResolutionMethod } from './resolution-method.js';
import { RESOLVED_METHODS } from './resolution-method.js';

// ─── Shared types ─────────────────────────────────────────────────────────────

export type EdgeKind = 'call' | 'type' | 'both';

export interface GraphAnalysisOptions {
  /** Which edge kinds to traverse. Default: 'both'. */
  edgeKinds?: EdgeKind;
  /** Resolution methods to include. Default: RESOLVED_METHODS. */
  methods?: ResolutionMethod[];
  /** Branch filter. */
  branch?: string;
}

// ─── Edge loading (shared) ────────────────────────────────────────────────────

interface SymbolEdge {
  source: number;
  target: number;
}

/**
 * Loads resolved symbol-level edges from the database.
 * Returns only edges where both source and target are non-NULL and the
 * resolution_method passes the configured filter.
 */
function loadSymbolEdges(
  db: Database.Database,
  options: GraphAnalysisOptions = {},
): SymbolEdge[] {
  const edgeKinds = options.edgeKinds ?? 'both';
  const methods = options.methods ?? [...RESOLVED_METHODS];
  const branch = options.branch;

  if (methods.length === 0) return [];

  const placeholders = methods.map(() => '?').join(', ');
  const edges: SymbolEdge[] = [];

  if (edgeKinds === 'call' || edgeKinds === 'both') {
    const where = [`sr.callee_id IS NOT NULL`, `sr.resolution_method IN (${placeholders})`];
    const params: Array<string | number> = [...methods];

    if (branch !== undefined) {
      where.push('f.branch = ?');
      params.push(branch);
    }

    const rows = db.prepare(
      `SELECT sr.caller_id AS source, sr.callee_id AS target
         FROM symbol_refs sr
         JOIN symbols s ON s.id = sr.caller_id
         JOIN files f ON f.id = s.file_id
        WHERE ${where.join(' AND ')}`,
    ).all(...params) as SymbolEdge[];
    edges.push(...rows);
  }

  if (edgeKinds === 'type' || edgeKinds === 'both') {
    const where = [`tr.type_id IS NOT NULL`, `tr.resolution_method IN (${placeholders})`];
    const params: Array<string | number> = [...methods];

    if (branch !== undefined) {
      where.push('f.branch = ?');
      params.push(branch);
    }

    const rows = db.prepare(
      `SELECT tr.symbol_id AS source, tr.type_id AS target
         FROM type_refs tr
         JOIN files f ON f.id = tr.file_id
        WHERE tr.symbol_id IS NOT NULL AND ${where.join(' AND ')}`,
    ).all(...params) as SymbolEdge[];
    edges.push(...rows);
  }

  return edges;
}

// ─── detectSymbolCycles ───────────────────────────────────────────────────────

/**
 * Detects strongly connected components (mutual recursion, circular type
 * dependencies) in the **symbol** adjacency graph using Tarjan's algorithm.
 *
 * Returns arrays of symbol IDs where each SCC has 2+ members (or a single
 * member with a self-edge).
 */
export function detectSymbolCycles(
  db: Database.Database,
  options: GraphAnalysisOptions = {},
): number[][] {
  const edges = loadSymbolEdges(db, options);

  // Build directed adjacency list
  const adjacency = new Map<number, number[]>();
  const allNodes = new Set<number>();

  for (const { source, target } of edges) {
    allNodes.add(source);
    allNodes.add(target);
    let list = adjacency.get(source);
    if (!list) {
      list = [];
      adjacency.set(source, list);
    }
    list.push(target);
  }

  // Tarjan's SCC
  let index = 0;
  const indices = new Map<number, number>();
  const lowlink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccs: number[][] = [];

  function strongConnect(v: number): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      if (scc.length > 1) {
        sccs.push(scc);
      } else {
        // Single-node SCC — only report if self-loop exists
        const selfLoop = (adjacency.get(scc[0]!) ?? []).includes(scc[0]!);
        if (selfLoop) sccs.push(scc);
      }
    }
  }

  for (const node of allNodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return sccs;
}

// ─── findConnectedComponents ──────────────────────────────────────────────────

export interface ConnectedComponentsOptions extends GraphAnalysisOptions {
  /** Scope of the analysis. Default: 'symbol'. */
  scope?: 'file' | 'symbol';
}

/**
 * Finds connected components in the **undirected** graph of files or symbols
 * using a union-find (disjoint set) data structure.
 *
 * Returns arrays of IDs where each component has 2+ members.
 */
export function findConnectedComponents(
  db: Database.Database,
  options: ConnectedComponentsOptions = {},
): number[][] {
  const scope = options.scope ?? 'symbol';

  if (scope === 'file') {
    return findFileComponents(db, options);
  }
  return findSymbolComponents(db, options);
}

function findFileComponents(
  db: Database.Database,
  options: GraphAnalysisOptions,
): number[][] {
  const branch = options.branch;

  const allFiles = (
    branch !== undefined
      ? db.prepare('SELECT id FROM files WHERE branch = ?').all(branch)
      : db.prepare('SELECT id FROM files').all()
  ) as Array<{ id: number }>;

  const edges = (
    branch !== undefined
      ? db.prepare(
          `SELECT fi.file_id AS source, fi.resolved_id AS target
             FROM file_imports fi
             JOIN files f ON f.id = fi.file_id
            WHERE fi.resolved_id IS NOT NULL AND f.branch = ?`,
        ).all(branch)
      : db.prepare(
          `SELECT fi.file_id AS source, fi.resolved_id AS target
             FROM file_imports fi
            WHERE fi.resolved_id IS NOT NULL`,
        ).all()
  ) as SymbolEdge[];

  const uf = new UnionFind<number>();
  for (const f of allFiles) uf.makeSet(f.id);
  for (const { source, target } of edges) uf.union(source, target);

  return uf.components().filter(c => c.length > 1);
}

function findSymbolComponents(
  db: Database.Database,
  options: GraphAnalysisOptions,
): number[][] {
  const edges = loadSymbolEdges(db, options);

  const uf = new UnionFind<number>();
  for (const { source, target } of edges) {
    uf.makeSet(source);
    uf.makeSet(target);
    uf.union(source, target);
  }

  return uf.components().filter(c => c.length > 1);
}

/** Simple union-find with path compression and union by rank. */
class UnionFind<T> {
  private parent = new Map<T, T>();
  private rank = new Map<T, number>();

  makeSet(x: T): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: T): T {
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(a: T, b: T): void {
    this.makeSet(a);
    this.makeSet(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  components(): T[][] {
    const groups = new Map<T, T[]>();
    for (const x of this.parent.keys()) {
      const root = this.find(x);
      let list = groups.get(root);
      if (!list) {
        list = [];
        groups.set(root, list);
      }
      list.push(x);
    }
    return [...groups.values()];
  }
}

// ─── clusterSymbols ───────────────────────────────────────────────────────────

export interface ClusterOptions extends GraphAnalysisOptions {
  /** Maximum total line span per cluster. Default: 500. */
  maxLinesPerCluster?: number;
}

export interface SymbolCluster {
  /** Cluster index (0-based). */
  id: number;
  /** Symbol IDs belonging to this cluster. */
  symbolIds: number[];
  /** Total line count across all symbols. */
  totalLines: number;
  /** File IDs that have at least one symbol in this cluster. */
  fileIds: number[];
  /** Number of internal edges (edges within the cluster). */
  internalEdges: number;
  /** Number of external edges (edges crossing cluster boundaries). */
  externalEdges: number;
}

interface SymbolInfo {
  id: number;
  fileId: number;
  lines: number;
}

/**
 * Partition the symbol call graph into bounded-size coherent clusters.
 *
 * Algorithm:
 * 1. Contract SCCs (mutually dependent symbols → same cluster)
 * 2. Merge same-file symbols into one cluster per file
 * 3. Greedy merge by edge weight (respecting maxLines)
 * 4. Fold undersized clusters into their heaviest-edge neighbor
 */
export function clusterSymbols(
  db: Database.Database,
  options: ClusterOptions = {},
): SymbolCluster[] {
  const maxLines = options.maxLinesPerCluster ?? 500;
  const branch = options.branch;

  // Load all symbols with line spans
  const symbolRows = (
    branch !== undefined
      ? db.prepare(
          `SELECT s.id, s.file_id, (s.end_line - s.start_line + 1) AS lines
             FROM symbols s JOIN files f ON f.id = s.file_id
            WHERE f.branch = ?`,
        ).all(branch)
      : db.prepare(
          'SELECT id, file_id, (end_line - start_line + 1) AS lines FROM symbols',
        ).all()
  ) as SymbolInfo[];

  if (symbolRows.length === 0) return [];

  const symbolById = new Map<number, SymbolInfo>();
  for (const s of symbolRows) symbolById.set(s.id, s);

  const edges = loadSymbolEdges(db, options);

  // Filter edges to only include symbols we loaded
  const validEdges = edges.filter(e => symbolById.has(e.source) && symbolById.has(e.target));

  // Step 1: SCC contraction — assign each symbol to a cluster
  const sccs = detectSymbolCycles(db, options);
  const clusterOf = new Map<number, number>(); // symbol → cluster representative
  let nextCluster = 0;

  for (const scc of sccs) {
    const cid = nextCluster++;
    for (const sid of scc) clusterOf.set(sid, cid);
  }
  // Assign singletons
  for (const s of symbolRows) {
    if (!clusterOf.has(s.id)) {
      clusterOf.set(s.id, nextCluster++);
    }
  }

  // Step 2: Same-file merge — merge clusters whose symbols share a file
  const fileToClusterIds = new Map<number, Set<number>>();
  for (const s of symbolRows) {
    const cid = clusterOf.get(s.id)!;
    let set = fileToClusterIds.get(s.fileId);
    if (!set) {
      set = new Set();
      fileToClusterIds.set(s.fileId, set);
    }
    set.add(cid);
  }

  // Use union-find for merging
  const clusterUf = new UnionFind<number>();
  for (const cid of new Set(clusterOf.values())) clusterUf.makeSet(cid);

  for (const clusterIds of fileToClusterIds.values()) {
    const ids = [...clusterIds];
    for (let i = 1; i < ids.length; i++) {
      // Only merge if combined size stays within bounds
      const rootA = clusterUf.find(ids[0]!);
      const rootB = clusterUf.find(ids[i]!);
      if (rootA !== rootB) {
        const sizeA = clusterLineCount(rootA, clusterOf, clusterUf, symbolById);
        const sizeB = clusterLineCount(rootB, clusterOf, clusterUf, symbolById);
        if (sizeA + sizeB <= maxLines) {
          clusterUf.union(rootA, rootB);
        }
      }
    }
  }

  // Step 3: Greedy merge by edge weight
  const crossEdgeWeights = new Map<string, number>();
  for (const { source, target } of validEdges) {
    const ca = clusterUf.find(clusterOf.get(source)!);
    const cb = clusterUf.find(clusterOf.get(target)!);
    if (ca === cb) continue;
    const key = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
    crossEdgeWeights.set(key, (crossEdgeWeights.get(key) ?? 0) + 1);
  }

  // Sort by edge weight descending and greedily merge
  const sortedPairs = [...crossEdgeWeights.entries()]
    .sort((a, b) => b[1] - a[1]);

  for (const [key] of sortedPairs) {
    const [aStr, bStr] = key.split(':');
    const ca = clusterUf.find(Number(aStr));
    const cb = clusterUf.find(Number(bStr));
    if (ca === cb) continue;
    const sizeA = clusterLineCount(ca, clusterOf, clusterUf, symbolById);
    const sizeB = clusterLineCount(cb, clusterOf, clusterUf, symbolById);
    if (sizeA + sizeB <= maxLines) {
      clusterUf.union(ca, cb);
    }
  }

  // Step 4: Fold undersized clusters (<30 lines) into heaviest neighbor
  const MIN_CLUSTER_LINES = 30;
  const finalClusters = new Map<number, number[]>(); // root → symbol ids
  for (const s of symbolRows) {
    const root = clusterUf.find(clusterOf.get(s.id)!);
    let list = finalClusters.get(root);
    if (!list) {
      list = [];
      finalClusters.set(root, list);
    }
    list.push(s.id);
  }

  // Find undersized clusters and their best merge target
  for (const [root, symbolIds] of finalClusters) {
    const totalLines = symbolIds.reduce((sum, id) => sum + (symbolById.get(id)?.lines ?? 0), 0);
    if (totalLines >= MIN_CLUSTER_LINES) continue;

    // Find the neighbor cluster with the most edges
    let bestNeighbor: number | undefined;
    let bestWeight = 0;
    for (const { source, target } of validEdges) {
      const cs = clusterUf.find(clusterOf.get(source)!);
      const ct = clusterUf.find(clusterOf.get(target)!);
      if (cs === root && ct !== root) {
        const neighborLines = clusterLineCount(ct, clusterOf, clusterUf, symbolById);
        if (neighborLines + totalLines <= maxLines) {
          const key = root < ct ? `${root}:${ct}` : `${ct}:${root}`;
          const w = crossEdgeWeights.get(key) ?? 1;
          if (w > bestWeight) {
            bestWeight = w;
            bestNeighbor = ct;
          }
        }
      } else if (ct === root && cs !== root) {
        const neighborLines = clusterLineCount(cs, clusterOf, clusterUf, symbolById);
        if (neighborLines + totalLines <= maxLines) {
          const key = root < cs ? `${root}:${cs}` : `${cs}:${root}`;
          const w = crossEdgeWeights.get(key) ?? 1;
          if (w > bestWeight) {
            bestWeight = w;
            bestNeighbor = cs;
          }
        }
      }
    }

    if (bestNeighbor !== undefined) {
      clusterUf.union(root, bestNeighbor);
    }
  }

  // Build final result
  const resultMap = new Map<number, { symbolIds: number[]; fileIds: Set<number>; totalLines: number }>();
  for (const s of symbolRows) {
    const root = clusterUf.find(clusterOf.get(s.id)!);
    let entry = resultMap.get(root);
    if (!entry) {
      entry = { symbolIds: [], fileIds: new Set(), totalLines: 0 };
      resultMap.set(root, entry);
    }
    entry.symbolIds.push(s.id);
    entry.fileIds.add(s.fileId);
    entry.totalLines += s.lines;
  }

  // Count internal/external edges per cluster
  const results: SymbolCluster[] = [];
  let idx = 0;
  for (const entry of resultMap.values()) {
    const memberSet = new Set(entry.symbolIds);
    let internalEdges = 0;
    let externalEdges = 0;
    for (const { source, target } of validEdges) {
      const sIn = memberSet.has(source);
      const tIn = memberSet.has(target);
      if (sIn && tIn) internalEdges++;
      else if (sIn || tIn) externalEdges++;
    }
    results.push({
      id: idx++,
      symbolIds: entry.symbolIds,
      totalLines: entry.totalLines,
      fileIds: [...entry.fileIds],
      internalEdges,
      externalEdges,
    });
  }

  return results.sort((a, b) => b.totalLines - a.totalLines);
}

function clusterLineCount(
  clusterRoot: number,
  clusterOf: Map<number, number>,
  uf: UnionFind<number>,
  symbolById: Map<number, SymbolInfo>,
): number {
  let total = 0;
  for (const [symId, cid] of clusterOf) {
    if (uf.find(cid) === clusterRoot) {
      total += symbolById.get(symId)?.lines ?? 0;
    }
  }
  return total;
}

// ─── buildCodebaseSummary ─────────────────────────────────────────────────────

export interface CodebaseSummaryOptions extends GraphAnalysisOptions {
  /** Maximum lines per module for clustering. Default: 500. */
  maxLinesPerModule?: number;
}

export interface ModuleSummary {
  /** Module index. */
  id: number;
  /** File paths in this module. */
  files: string[];
  /** Total symbol count. */
  symbolCount: number;
  /** Total line span. */
  totalLines: number;
  /** IDs of modules this module depends on. */
  dependsOn: number[];
  /** IDs of modules that depend on this module. */
  dependedOnBy: number[];
}

export interface CodebaseSummary {
  /** Total indexed files. */
  totalFiles: number;
  /** Total indexed symbols. */
  totalSymbols: number;
  /** Total resolved edges. */
  totalEdges: number;
  /** Modules grouped by clustering. */
  modules: ModuleSummary[];
  /** Connected component groups (module IDs). */
  connectedComponents: number[][];
  /** Strongly connected component groups (module IDs). */
  cyclicGroups: number[][];
}

/**
 * Produces a condensed dependency summary of the codebase — the "30-second
 * architecture overview."
 *
 * Combines symbol clustering with inter-module edge analysis and SCC/CC
 * detection at the module level.
 */
export function buildCodebaseSummary(
  db: Database.Database,
  options: CodebaseSummaryOptions = {},
): CodebaseSummary {
  const branch = options.branch;

  // Counts
  const totalFiles = (
    branch !== undefined
      ? db.prepare('SELECT COUNT(*) AS cnt FROM files WHERE branch = ?').get(branch)
      : db.prepare('SELECT COUNT(*) AS cnt FROM files').get()
  ) as { cnt: number };

  const totalSymbols = (
    branch !== undefined
      ? db.prepare('SELECT COUNT(*) AS cnt FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.branch = ?').get(branch)
      : db.prepare('SELECT COUNT(*) AS cnt FROM symbols').get()
  ) as { cnt: number };

  const totalEdges = (
    branch !== undefined
      ? db.prepare(
          `SELECT COUNT(*) AS cnt FROM symbol_refs sr
           JOIN symbols s ON s.id = sr.caller_id
           JOIN files f ON f.id = s.file_id
           WHERE sr.callee_id IS NOT NULL AND f.branch = ?`,
        ).get(branch)
      : db.prepare('SELECT COUNT(*) AS cnt FROM symbol_refs WHERE callee_id IS NOT NULL').get()
  ) as { cnt: number };

  // Cluster symbols into modules
  const clusters = clusterSymbols(db, {
    ...options,
    maxLinesPerCluster: options.maxLinesPerModule ?? 500,
  });

  if (clusters.length === 0) {
    return {
      totalFiles: totalFiles.cnt,
      totalSymbols: totalSymbols.cnt,
      totalEdges: totalEdges.cnt,
      modules: [],
      connectedComponents: [],
      cyclicGroups: [],
    };
  }

  // Build symbol → cluster mapping
  const symbolToCluster = new Map<number, number>();
  for (const c of clusters) {
    for (const sid of c.symbolIds) {
      symbolToCluster.set(sid, c.id);
    }
  }

  // Load file paths for each cluster
  const filePathById = new Map<number, string>(
    (
      branch !== undefined
        ? db.prepare('SELECT id, path FROM files WHERE branch = ?').all(branch)
        : db.prepare('SELECT id, path FROM files').all()
    ).map((r: any) => [r.id, r.path]),
  );

  // Build module summaries
  const edges = loadSymbolEdges(db, options);
  const moduleAdj = new Map<number, Set<number>>(); // module → set of modules it depends on
  const moduleRevAdj = new Map<number, Set<number>>(); // module → set of modules that depend on it

  for (const c of clusters) {
    moduleAdj.set(c.id, new Set());
    moduleRevAdj.set(c.id, new Set());
  }

  for (const { source, target } of edges) {
    const cm = symbolToCluster.get(source);
    const cn = symbolToCluster.get(target);
    if (cm === undefined || cn === undefined || cm === cn) continue;
    moduleAdj.get(cm)!.add(cn);
    moduleRevAdj.get(cn)!.add(cm);
  }

  const modules: ModuleSummary[] = clusters.map(c => ({
    id: c.id,
    files: c.fileIds.map(fid => filePathById.get(fid) ?? `file:${fid}`).sort(),
    symbolCount: c.symbolIds.length,
    totalLines: c.totalLines,
    dependsOn: [...(moduleAdj.get(c.id) ?? [])].sort((a, b) => a - b),
    dependedOnBy: [...(moduleRevAdj.get(c.id) ?? [])].sort((a, b) => a - b),
  }));

  // Module-level connected components
  const moduleUf = new UnionFind<number>();
  for (const c of clusters) moduleUf.makeSet(c.id);
  for (const { source, target } of edges) {
    const cm = symbolToCluster.get(source);
    const cn = symbolToCluster.get(target);
    if (cm !== undefined && cn !== undefined && cm !== cn) {
      moduleUf.union(cm, cn);
    }
  }
  const connectedComponents = moduleUf.components().filter(c => c.length > 1);

  // Module-level SCCs
  const moduleSccAdj = new Map<number, number[]>();
  for (const c of clusters) moduleSccAdj.set(c.id, []);
  for (const [mid, deps] of moduleAdj) {
    moduleSccAdj.set(mid, [...deps]);
  }

  const cyclicGroups = tarjanScc(moduleSccAdj);

  return {
    totalFiles: totalFiles.cnt,
    totalSymbols: totalSymbols.cnt,
    totalEdges: totalEdges.cnt,
    modules,
    connectedComponents,
    cyclicGroups,
  };
}

/** Generic Tarjan's SCC for number-keyed adjacency. */
function tarjanScc(adjacency: Map<number, number[]>): number[][] {
  let index = 0;
  const indices = new Map<number, number>();
  const lowlink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccs: number[][] = [];

  function strongConnect(v: number): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      if (scc.length > 1) {
        sccs.push(scc);
      } else {
        const selfLoop = (adjacency.get(scc[0]!) ?? []).includes(scc[0]!);
        if (selfLoop) sccs.push(scc);
      }
    }
  }

  for (const node of adjacency.keys()) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return sccs;
}
