/**
 * @module lore-server/tools/metrics
 *
 * MCP tool: return a global ranking of the most complex symbols in the codebase.
 */

import type { Database } from '../../db/read-only.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_metrics',
  description:
    'Return a global ranking of the most complex symbols across the entire codebase, ' +
    'ranked by cyclomatic complexity. Use limit and min_cyclomatic to filter.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max symbols to return (default 20, max 200).',
      },
      min_cyclomatic: {
        type: 'number',
        description: 'Minimum cyclomatic score filter (default 0).',
      },
    },
    required: [],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface MetricsArgs {
  limit?: number;
  min_cyclomatic?: number;
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

export interface MetricsResult {
  symbols: ComplexitySymbolRow[];
}

/** Return symbols ranked by cyclomatic complexity. */
export function handler(db: Database.Database, args: MetricsArgs): MetricsResult {
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
