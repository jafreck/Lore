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
    'Return aggregate KB metrics or top symbols by stored complexity.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['aggregate', 'complexity'],
        description: 'Metrics mode: aggregate counts (default) or complexity-ranked symbols.',
      },
      limit: {
        type: 'number',
        description: 'Max symbols returned for complexity mode (default 20, max 200).',
      },
      min_cyclomatic: {
        type: 'number',
        description: 'Minimum cyclomatic score filter for complexity mode (default 0).',
      },
    },
    required: [],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface MetricsArgs {
  mode?: 'aggregate' | 'complexity';
  limit?: number;
  min_cyclomatic?: number;
}

export interface AggregateMetricsResult {
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

export interface ComplexitySymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc_comment: string | null;
  line_count: number;
  param_count: number;
  cyclomatic: number;
  max_nesting: number;
}

export interface ComplexityMetricsResult {
  symbols: ComplexitySymbolRow[];
}

export type MetricsResult = AggregateMetricsResult | ComplexityMetricsResult;

/** Collect aggregate counts from the knowledge-base tables. */
export function handler(db: Database.Database, args: MetricsArgs): MetricsResult {
  if (args.mode === 'complexity') {
    const minCyclomatic = Math.max(0, args.min_cyclomatic ?? 0);
    const limit = Math.min(Math.max(1, args.limit ?? 20), 200);
    const symbols = db
      .prepare(
        `SELECT s.*,
                sm.line_count,
                sm.param_count,
                sm.cyclomatic,
                sm.max_nesting
           FROM symbol_metrics sm
           JOIN symbols s ON s.id = sm.symbol_id
          WHERE sm.cyclomatic >= ?
          ORDER BY sm.cyclomatic DESC, s.id ASC
          LIMIT ?`,
      )
      .all(minCyclomatic, limit) as ComplexitySymbolRow[];

    return { symbols };
  }

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
