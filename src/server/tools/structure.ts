/**
 * @module lore-server/tools/structure
 *
 * MCP tool: detect structural anomalies in the codebase at the directory level.
 *
 * Analyses:
 *   - **cycles**: Directory-level import cycles via Tarjan's SCC.
 *   - **layers**: Topological layering violations via Kahn's algorithm.
 *   - **outliers**: Anomalous cross-directory couplings by edge-count statistics.
 */

import type { Database } from '../../db/read-only.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_structure',
  description:
    'Detect structural anomalies in the codebase at the directory level. ' +
    'Aggregates file-level imports into directory-level edges and runs: ' +
    "(A) Tarjan's SCC for import cycle detection, " +
    "(B) Kahn's topological sort for layering violation detection, " +
    '(C) outlier detection for anomalous cross-directory couplings. ' +
    'Set `analysis` to "cycles", "layers", "outliers", or "all" (default). ' +
    'Use `depth` to control directory aggregation depth (default 2). ' +
    'Use `branch` to filter by source branch.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      analysis: {
        type: 'string',
        enum: ['cycles', 'layers', 'outliers', 'all'] as const,
        description:
          'Which analysis to run. "cycles" detects directory-level import cycles, ' +
          '"layers" detects topological layering violations, ' +
          '"outliers" detects anomalous cross-directory couplings, ' +
          '"all" runs all three. Default: "all".',
      },
      depth: {
        type: 'number',
        description:
          'Directory aggregation depth. Controls how many path segments from the repo root ' +
          'are used to group files into directories (e.g., depth=2 maps src/server/tools/graph.ts ' +
          'to src/server). Default: 2.',
        minimum: 1,
        maximum: 10,
      },
      branch: {
        type: 'string',
        description: 'Optional branch name to filter file_imports by source file branch.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results per analysis (default 20).',
        minimum: 1,
        maximum: 500,
      },
    },
    required: [] as readonly string[],
  },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type AnalysisMode = 'cycles' | 'layers' | 'outliers' | 'all';

export interface StructureArgs {
  analysis?: AnalysisMode;
  depth?: number;
  branch?: string;
  limit?: number;
}

export interface StructureCycle {
  directories: string[];
  edge_count: number;
}

export interface LayerViolation {
  from_dir: string;
  to_dir: string;
  from_rank: number;
  to_rank: number;
  edge_count: number;
  sample_files: string[];
}

export interface OutlierEdge {
  from_dir: string;
  to_dir: string;
  edge_count: number;
  reverse_edge_count: number;
  sample_files: string[];
}

export interface StructureResult {
  cycles?: StructureCycle[];
  layer_violations?: LayerViolation[];
  outliers?: OutlierEdge[];
}

// ─── Directory graph construction ─────────────────────────────────────────────

interface DirEdge {
  from_dir: string;
  to_dir: string;
  count: number;
  sample_files: string[];
}

interface DirGraph {
  /** All unique directory nodes. */
  directories: Set<string>;
  /** Adjacency: from_dir → to_dir → DirEdge */
  adjacency: Map<string, Map<string, DirEdge>>;
}

/**
 * Truncate a file path to the given depth of directory segments.
 * E.g., depth=2: "src/server/tools/graph.ts" → "src/server"
 */
function dirPrefix(filePath: string, depth: number): string {
  const segments = filePath.split('/');
  // Take min(depth, segments.length - 1) to exclude the filename
  const dirSegments = segments.slice(0, Math.min(depth, segments.length - 1));
  return dirSegments.length > 0 ? dirSegments.join('/') : '.';
}

/**
 * Build a directory-level graph by aggregating file_imports edges.
 * Each file is mapped to its directory prefix at the given depth,
 * and edges between distinct directories are deduplicated with counts.
 */
function buildDirGraph(db: Database.Database, depth: number, branch?: string): DirGraph {
  const conditions: string[] = ['fi.resolved_id IS NOT NULL'];
  const params: Array<string | number> = [];

  if (branch !== undefined) {
    conditions.push('f_src.branch = ?');
    params.push(branch);
  }

  const whereClause = conditions.join(' AND ');

  const directories = new Set<string>();
  const adjacency = new Map<string, Map<string, DirEdge>>();

  for (const { src_path, dst_path } of db.prepare(
    `SELECT f_src.path AS src_path, f_dst.path AS dst_path
       FROM file_imports fi
       JOIN files f_src ON f_src.id = fi.file_id
       JOIN files f_dst ON f_dst.id = fi.resolved_id
      WHERE ${whereClause}`,
  ).iterate(...params) as Iterable<{ src_path: string; dst_path: string }>) {
    const srcDir = dirPrefix(src_path, depth);
    const dstDir = dirPrefix(dst_path, depth);

    directories.add(srcDir);
    directories.add(dstDir);

    // Skip self-loops at the directory level
    if (srcDir === dstDir) continue;

    let targets = adjacency.get(srcDir);
    if (!targets) {
      targets = new Map();
      adjacency.set(srcDir, targets);
    }

    let edge = targets.get(dstDir);
    if (!edge) {
      edge = { from_dir: srcDir, to_dir: dstDir, count: 0, sample_files: [] };
      targets.set(dstDir, edge);
    }

    edge.count++;
    if (edge.sample_files.length < 3) {
      const sample = `${src_path} → ${dst_path}`;
      if (!edge.sample_files.includes(sample)) {
        edge.sample_files.push(sample);
      }
    }
  }

  return { directories, adjacency };
}

// ─── Analysis A: Tarjan's SCC for directory-level cycles ──────────────────────

function detectDirCycles(graph: DirGraph, limit: number): StructureCycle[] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.set(v, true);

    const targets = graph.adjacency.get(v);
    if (targets) {
      for (const w of targets.keys()) {
        if (!indices.has(w)) {
          strongConnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.get(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
        }
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);

      if (scc.length > 1) {
        sccs.push(scc);
      } else {
        // Single-node SCC: only a cycle if there's a self-loop
        const selfTargets = graph.adjacency.get(scc[0]!);
        if (selfTargets?.has(scc[0]!)) {
          sccs.push(scc);
        }
      }
    }
  }

  for (const dir of graph.directories) {
    if (!indices.has(dir)) {
      strongConnect(dir);
    }
  }

  // Convert SCCs to StructureCycle with edge counts
  const cycles: StructureCycle[] = sccs
    .map((scc) => {
      const sccSet = new Set(scc);
      let edgeCount = 0;
      for (const dir of scc) {
        const targets = graph.adjacency.get(dir);
        if (targets) {
          for (const [target, edge] of targets) {
            if (sccSet.has(target)) {
              edgeCount += edge.count;
            }
          }
        }
      }
      return { directories: scc.sort(), edge_count: edgeCount };
    })
    .sort((a, b) => b.edge_count - a.edge_count)
    .slice(0, limit);

  return cycles;
}

// ─── Analysis B: DFS-based layering violations ───────────────────────────────

function detectLayerViolations(graph: DirGraph, limit: number): LayerViolation[] {
  // Assign layers using DFS finish time.  Nodes that finish earlier are more
  // foundational (deeper in the dependency chain).  Back-edges — edges from a
  // node to an ancestor still on the DFS stack — represent layering violations
  // where a downstream directory imports an upstream one.

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const finishRank = new Map<string, number>();
  const violations: LayerViolation[] = [];
  let finishTimer = 0;

  // Compute traditional in-degree (how many dirs import this one) so we can
  // seed the DFS from source nodes (entry points imported by nobody).
  const inDeg = new Map<string, number>();
  for (const dir of graph.directories) inDeg.set(dir, 0);
  for (const targets of graph.adjacency.values()) {
    for (const dst of targets.keys()) {
      inDeg.set(dst, (inDeg.get(dst) ?? 0) + 1);
    }
  }

  // Sort so source nodes (low in-degree) are visited first for determinism.
  const sorted = [...graph.directories].sort(
    (a, b) => (inDeg.get(a) ?? 0) - (inDeg.get(b) ?? 0) || a.localeCompare(b),
  );

  function dfs(v: string): void {
    visited.add(v);
    onStack.add(v);

    const targets = graph.adjacency.get(v);
    if (targets) {
      for (const [w, edge] of targets) {
        if (!visited.has(w)) {
          dfs(w);
        } else if (onStack.has(w)) {
          // Back-edge: v → w where w is an ancestor on the current path.
          violations.push({
            from_dir: v,
            to_dir: w,
            from_rank: -1, // patched after DFS completes
            to_rank: -1,
            edge_count: edge.count,
            sample_files: edge.sample_files,
          });
        }
      }
    }

    onStack.delete(v);
    finishRank.set(v, finishTimer++);
  }

  for (const dir of sorted) {
    if (!visited.has(dir)) {
      dfs(dir);
    }
  }

  // Patch ranks using finish times (lower = more foundational).
  for (const v of violations) {
    v.from_rank = finishRank.get(v.from_dir) ?? -1;
    v.to_rank = finishRank.get(v.to_dir) ?? -1;
  }

  return violations
    .sort((a, b) => b.edge_count - a.edge_count)
    .slice(0, limit);
}

// ─── Analysis C: Outlier detection ────────────────────────────────────────────

function detectOutliers(graph: DirGraph, limit: number): OutlierEdge[] {
  // Collect all directed edges with their counts
  const allEdges: DirEdge[] = [];
  for (const targets of graph.adjacency.values()) {
    for (const edge of targets.values()) {
      allEdges.push(edge);
    }
  }

  if (allEdges.length === 0) return [];

  // Compute mean edge count
  const totalCount = allEdges.reduce((sum, e) => sum + e.count, 0);
  const mean = totalCount / allEdges.length;

  // Compute standard deviation
  const variance = allEdges.reduce((sum, e) => sum + (e.count - mean) ** 2, 0) / allEdges.length;
  const stddev = Math.sqrt(variance);

  // Outliers are edges with unusually low edge counts.
  // Threshold: count < mean - 1*stddev, but at least count == 1 to be meaningful.
  // If stddev is 0 (all edges same count), no outliers.
  const threshold = stddev > 0 ? Math.max(1, mean - stddev) : 0;

  if (threshold === 0) return [];

  const outliers: OutlierEdge[] = [];

  for (const edge of allEdges) {
    if (edge.count >= threshold) continue;

    // Look up reverse edge count
    const reverseTargets = graph.adjacency.get(edge.to_dir);
    const reverseEdge = reverseTargets?.get(edge.from_dir);
    const reverseCount = reverseEdge?.count ?? 0;

    outliers.push({
      from_dir: edge.from_dir,
      to_dir: edge.to_dir,
      edge_count: edge.count,
      reverse_edge_count: reverseCount,
      sample_files: edge.sample_files,
    });
  }

  return outliers
    .sort((a, b) => a.edge_count - b.edge_count)
    .slice(0, limit);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Analyse directory-level structural anomalies in the codebase. */
export function handler(db: Database.Database, args: StructureArgs): StructureResult {
  const analysis = args.analysis ?? 'all';
  const depth = Math.max(1, Math.min(args.depth ?? 2, 10));
  const limit = Math.max(1, Math.min(args.limit ?? 20, 500));

  const graph = buildDirGraph(db, depth, args.branch);
  const result: StructureResult = {};

  if (analysis === 'cycles' || analysis === 'all') {
    result.cycles = detectDirCycles(graph, limit);
  }

  if (analysis === 'layers' || analysis === 'all') {
    result.layer_violations = detectLayerViolations(graph, limit);
  }

  if (analysis === 'outliers' || analysis === 'all') {
    result.outliers = detectOutliers(graph, limit);
  }

  return result;
}
