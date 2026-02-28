/**
 * @module kb-server/tools/metrics
 *
 * MCP tool: return high-level code metrics from the knowledge-base index.
 */

import type { Database } from '../db.js';
import { getCoverageStaleness, getLatestCoverageTotals } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_metrics',
  description:
    'Return high-level code metrics from the knowledge-base index: ' +
    'total symbol count, total file count, and total import-edge count.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

// No meaningful args for this tool.
export type MetricsArgs = Record<string, never>;

export interface MetricsResult {
  symbol_count: number;
  file_count: number;
  import_edge_count: number;
  coverage_available: boolean;
  coverage_commit: string | null;
  current_commit: string | null;
  commits_behind: number;
  stale: boolean;
  global_lines_found: number | null;
  global_lines_hit: number | null;
  global_coverage_percent: number | null;
  per_branch: Array<{ branch: string; file_count: number; symbol_count: number }>;
}

/** Collect aggregate counts from the knowledge-base tables. */
export function handler(db: Database.Database, _args: MetricsArgs): MetricsResult {
  const symbolCount = (
    db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }
  ).c;

  const fileCount = (
    db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }
  ).c;

  const importEdgeCount = (
    db.prepare('SELECT COUNT(*) AS c FROM file_imports').get() as { c: number }
  ).c;

  const perBranch = db
    .prepare(
      `SELECT f.branch,
              COUNT(DISTINCT f.id) AS file_count,
              COUNT(DISTINCT s.id) AS symbol_count
         FROM files f
         LEFT JOIN symbols s ON s.file_id = f.id
        GROUP BY f.branch
        ORDER BY f.branch`,
    )
    .all() as Array<{ branch: string; file_count: number; symbol_count: number }>;

  const coverageTotals = getLatestCoverageTotals(db);
  const staleness = getCoverageStaleness(db);

  return {
    symbol_count: symbolCount,
    file_count: fileCount,
    import_edge_count: importEdgeCount,
    coverage_available: coverageTotals !== undefined,
    coverage_commit: staleness.coverage_commit,
    current_commit: staleness.current_commit,
    commits_behind: staleness.commits_behind,
    stale: staleness.stale,
    global_lines_found: coverageTotals?.lines_found ?? null,
    global_lines_hit: coverageTotals?.lines_hit ?? null,
    global_coverage_percent: coverageTotals?.coverage_percent ?? null,
    per_branch: perBranch,
  };
}
