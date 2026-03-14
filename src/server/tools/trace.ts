/**
 * @module lore-server/tools/trace
 *
 * MCP tool: trace an execution path from an entry point and return an ordered
 * call sequence with source code inlined — a self-contained reasoning bundle
 * for LLM agents.
 *
 * Entry modes:
 *   1. Symbol ID:   `from=symbolId`
 *   2. Symbol name: `from_name="handleCreateUser"`
 *   3. Point-to-point: `from` + `to` (BFS shortest path)
 */

import type { Database } from '../../db/read-only.js';
import { getSymbolsByName, getCoveragePercentBySymbolIds } from '../../db/read-only.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_trace',
  description:
    'Trace an execution path from an entry point (symbol or symbol name) and ' +
    'return an ordered call sequence with source code for each step. Designed for ' +
    'reasoning about data flow, config propagation, and side effects.',
  inputSchema: {
    type: 'object',
    properties: {
      from: {
        type: 'number',
        description: 'Symbol ID to start the trace from (forward trace).',
      },
      from_name: {
        type: 'string',
        description:
          'Symbol name to start the trace from (resolved via lore_lookup). Use when you don\'t have the ID.',
      },
      to: {
        type: 'number',
        description:
          'Optional target symbol ID. When provided, returns the shortest call path from `from` to `to` instead of a full forward trace.',
      },
      to_name: {
        type: 'string',
        description: 'Optional target symbol name. Resolved via lore_lookup.',
      },
      depth: {
        type: 'number',
        description: 'Max call depth to trace (default 5, max 10).',
        minimum: 1,
        maximum: 10,
      },
      max_source_lines: {
        type: 'number',
        description:
          'Max source lines per step (default 50). Larger functions are truncated with a comment indicating remaining lines.',
      },
      branch: {
        type: 'string',
        description: 'Optional branch name to filter symbols.',
      },
    },
  },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TraceArgs {
  from?: number;
  from_name?: string;
  to?: number;
  to_name?: string;
  depth?: number;
  max_source_lines?: number;
  branch?: string;
}

export interface TraceStep {
  depth: number;
  symbol_id: number;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature?: string;
  source: string;
  call_line?: number;
  resolution_method?: string;
  cyclomatic?: number;
  coverage_percent?: number;
}

export interface TraceResult {
  entry: string;
  steps: TraceStep[];
  truncated: boolean;
  total_nodes: number;
}

// ─── Internal DB row types ────────────────────────────────────────────────────

interface SymbolWithSource {
  id: number;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  source: string;
  cyclomatic: number | null;
}

interface CalleeEdge {
  callee_id: number;
  callee_name: string;
  call_line: number;
  resolution_method: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a symbol name to a single symbol ID, throwing if ambiguous or missing. */
function resolveSymbolName(db: Database.Database, name: string, branch?: string): number {
  const rows = getSymbolsByName(db, name, branch);
  if (rows.length === 0) {
    throw new Error(`Symbol not found: "${name}"`);
  }
  if (rows.length > 1) {
    const locations = rows
      .slice(0, 5)
      .map((r) => `  id=${r.id} kind=${r.kind}`)
      .join('\n');
    throw new Error(
      `Ambiguous symbol name "${name}" (${rows.length} matches). Provide \`from\`/\`to\` with a specific symbol ID instead.\n${locations}`,
    );
  }
  return rows[0]!.id;
}

/** Check whether a table exists in the database. */
function hasTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ? LIMIT 1",
    )
    .get(name) as { present: number } | undefined;
  return row?.present === 1;
}

/** Fetch full symbol info with source for a batch of symbol IDs. */
function getSymbolsWithSource(
  db: Database.Database,
  symbolIds: number[],
): Map<number, SymbolWithSource> {
  if (symbolIds.length === 0) return new Map();

  const hasMetrics = hasTable(db, 'symbol_metrics');
  const placeholders = symbolIds.map(() => '?').join(', ');
  const sql = `
    SELECT s.id, s.name, s.kind, f.path AS file_path,
           s.start_line, s.end_line, s.signature, f.source
           ${hasMetrics ? ', sm.cyclomatic' : ''}
      FROM symbols s
      JOIN files f ON f.id = s.file_id
      ${hasMetrics ? 'LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id' : ''}
     WHERE s.id IN (${placeholders})`;

  const rows = db.prepare(sql).all(...symbolIds) as Array<{
    id: number;
    name: string;
    kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    signature: string | null;
    source: string;
    cyclomatic: number | null;
  }>;

  const map = new Map<number, SymbolWithSource>();
  for (const row of rows) {
    map.set(row.id, {
      ...row,
      cyclomatic: hasMetrics ? row.cyclomatic : null,
    });
  }
  return map;
}

/** Get outbound call edges for a symbol. */
function getCallees(db: Database.Database, callerId: number): CalleeEdge[] {
  return db
    .prepare(
      `SELECT callee_id, callee_name, call_line, resolution_method
         FROM symbol_refs
        WHERE caller_id = ? AND callee_id IS NOT NULL
        ORDER BY call_line ASC`,
    )
    .all(callerId) as CalleeEdge[];
}

/** Extract source lines for a symbol, applying truncation. */
function extractSource(sym: SymbolWithSource, maxLines: number): string {
  const allLines = sym.source.split('\n');
  const start = Math.max(0, sym.start_line - 1);
  const end = Math.min(allLines.length, sym.end_line);
  const lines = allLines.slice(start, end);

  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  const truncated = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  truncated.push(`// ... (${remaining} more lines)`);
  return truncated.join('\n');
}

/**
 * Build a TraceStep from a symbol, with optional caller context.
 */
function buildStep(
  sym: SymbolWithSource,
  depthLevel: number,
  maxLines: number,
  callLine?: number,
  resolutionMethod?: string,
  coveragePercent?: number | null,
): TraceStep {
  const step: TraceStep = {
    depth: depthLevel,
    symbol_id: sym.id,
    name: sym.name,
    kind: sym.kind,
    file_path: sym.file_path,
    start_line: sym.start_line,
    end_line: sym.end_line,
    source: extractSource(sym, maxLines),
  };
  if (sym.signature) step.signature = sym.signature;
  if (callLine !== undefined) step.call_line = callLine;
  if (resolutionMethod !== undefined) step.resolution_method = resolutionMethod;
  if (sym.cyclomatic !== null && sym.cyclomatic !== undefined) step.cyclomatic = sym.cyclomatic;
  if (coveragePercent !== undefined && coveragePercent !== null) step.coverage_percent = coveragePercent;
  return step;
}

// ─── DFS forward trace ───────────────────────────────────────────────────────

function forwardTrace(
  db: Database.Database,
  entryId: number,
  maxDepth: number,
  maxLines: number,
  branch?: string,
): { steps: TraceStep[]; truncated: boolean; visitedIds: Set<number> } {
  const steps: TraceStep[] = [];
  const visited = new Set<number>();
  let truncated = false;

  // Collect all symbol IDs we'll visit via iterative DFS planning pass
  // then batch-fetch source and coverage.

  interface DfsFrame {
    symbolId: number;
    depthLevel: number;
    callLine?: number;
    resolutionMethod?: string;
  }

  // First pass: plan the traversal to discover all needed symbol IDs.
  const planned: DfsFrame[] = [];
  const planStack: DfsFrame[] = [{ symbolId: entryId, depthLevel: 0 }];
  const planVisited = new Set<number>();

  while (planStack.length > 0) {
    const frame = planStack.pop()!;
    if (planVisited.has(frame.symbolId)) continue;
    planVisited.add(frame.symbolId);
    planned.push(frame);

    if (frame.depthLevel < maxDepth) {
      const edges = getCallees(db, frame.symbolId);
      // Push in reverse order so first callee is processed first (stack is LIFO)
      for (let i = edges.length - 1; i >= 0; i--) {
        const edge = edges[i]!;
        if (!planVisited.has(edge.callee_id)) {
          planStack.push({
            symbolId: edge.callee_id,
            depthLevel: frame.depthLevel + 1,
            callLine: edge.call_line + 1, // 0-indexed → 1-indexed
            resolutionMethod: edge.resolution_method,
          });
        }
      }
    } else if (frame.depthLevel === maxDepth) {
      // Check if there are further edges we're cutting off
      const edges = getCallees(db, frame.symbolId);
      if (edges.length > 0) truncated = true;
    }
  }

  // Batch-fetch all symbols with source
  const allIds = planned.map((f) => f.symbolId);
  const symbolMap = getSymbolsWithSource(db, allIds);
  const coverageMap = getCoveragePercentBySymbolIds(db, allIds, branch);

  // Second pass: replay the planned traversal in order, building steps.
  // Re-run the DFS to ensure correct pre-order.
  const dfsStack: DfsFrame[] = [{ symbolId: entryId, depthLevel: 0 }];

  while (dfsStack.length > 0) {
    const frame = dfsStack.pop()!;
    if (visited.has(frame.symbolId)) continue;
    visited.add(frame.symbolId);

    const sym = symbolMap.get(frame.symbolId);
    if (!sym) continue;

    const coverage = coverageMap.get(frame.symbolId) ?? null;
    steps.push(
      buildStep(sym, frame.depthLevel, maxLines, frame.callLine, frame.resolutionMethod, coverage),
    );

    if (frame.depthLevel < maxDepth) {
      const edges = getCallees(db, frame.symbolId);
      for (let i = edges.length - 1; i >= 0; i--) {
        const edge = edges[i]!;
        if (!visited.has(edge.callee_id)) {
          dfsStack.push({
            symbolId: edge.callee_id,
            depthLevel: frame.depthLevel + 1,
            callLine: edge.call_line + 1,
            resolutionMethod: edge.resolution_method,
          });
        }
      }
    }
  }

  return { steps, truncated, visitedIds: visited };
}

// ─── BFS point-to-point ──────────────────────────────────────────────────────

function pointToPointTrace(
  db: Database.Database,
  fromId: number,
  toId: number,
  maxDepth: number,
  maxLines: number,
  branch?: string,
): { steps: TraceStep[]; truncated: boolean; visitedIds: Set<number> } {
  // BFS to find shortest path from → to
  const parentMap = new Map<number, { parentId: number; callLine: number; resolutionMethod: string }>();
  const visited = new Set<number>();
  const queue: Array<{ id: number; depth: number }> = [{ id: fromId, depth: 0 }];
  visited.add(fromId);
  let found = false;

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (id === toId) {
      found = true;
      break;
    }
    if (depth >= maxDepth) continue;

    const edges = getCallees(db, id);
    for (const edge of edges) {
      if (!visited.has(edge.callee_id)) {
        visited.add(edge.callee_id);
        parentMap.set(edge.callee_id, {
          parentId: id,
          callLine: edge.call_line + 1,
          resolutionMethod: edge.resolution_method,
        });
        queue.push({ id: edge.callee_id, depth: depth + 1 });
      }
    }
  }

  if (!found) {
    throw new Error(
      `No call path found from symbol ${fromId} to symbol ${toId} within depth ${maxDepth}.`,
    );
  }

  // Reconstruct path from `to` back to `from`
  const path: Array<{ id: number; callLine?: number; resolutionMethod?: string }> = [];
  let current = toId;
  while (current !== fromId) {
    const parent = parentMap.get(current)!;
    path.push({ id: current, callLine: parent.callLine, resolutionMethod: parent.resolutionMethod });
    current = parent.parentId;
  }
  path.push({ id: fromId });
  path.reverse();

  // Batch-fetch symbols and coverage
  const pathIds = path.map((p) => p.id);
  const symbolMap = getSymbolsWithSource(db, pathIds);
  const coverageMap = getCoveragePercentBySymbolIds(db, pathIds, branch);

  const steps: TraceStep[] = [];
  for (let i = 0; i < path.length; i++) {
    const node = path[i]!;
    const sym = symbolMap.get(node.id);
    if (!sym) continue;
    const coverage = coverageMap.get(node.id) ?? null;
    steps.push(buildStep(sym, i, maxLines, node.callLine, node.resolutionMethod, coverage));
  }

  return { steps, truncated: false, visitedIds: new Set(pathIds) };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(db: Database.Database, args: TraceArgs): TraceResult {
  const maxDepth = Math.max(1, Math.min(args.depth ?? 5, 10));
  const maxLines = args.max_source_lines ?? 50;

  // Resolve entry point
  let fromId: number | undefined = args.from;
  if (fromId === undefined && args.from_name !== undefined) {
    fromId = resolveSymbolName(db, args.from_name, args.branch);
  }
  if (fromId === undefined) {
    throw new Error('Provide `from` (symbol ID) or `from_name` (symbol name) to start the trace.');
  }

  // Resolve optional target
  let toId: number | undefined = args.to;
  if (toId === undefined && args.to_name !== undefined) {
    toId = resolveSymbolName(db, args.to_name, args.branch);
  }

  // Fetch entry symbol name for the result description
  const entrySymbols = getSymbolsWithSource(db, [fromId]);
  const entrySym = entrySymbols.get(fromId);
  if (!entrySym) {
    throw new Error(`Entry symbol not found: id=${fromId}`);
  }
  const entryDesc = toId !== undefined
    ? `${entrySym.name} → symbol ${toId}`
    : entrySym.name;

  // Dispatch to the appropriate trace strategy
  const { steps, truncated, visitedIds } =
    toId !== undefined
      ? pointToPointTrace(db, fromId, toId, maxDepth, maxLines, args.branch)
      : forwardTrace(db, fromId, maxDepth, maxLines, args.branch);

  return {
    entry: entryDesc,
    steps,
    truncated,
    total_nodes: visitedIds.size,
  };
}
