/**
 * @module lore-server/tools/metrics
 *
 * Unregistered tool module: return a global ranking of the most complex
 * symbols. Used directly by tests/benchmark helpers, but not included in the
 * production MCP registry.
 */

import type { Database } from '../../db/read-only.js';
import {
  nullableStorageCharacterToPresentation,
  nullableStorageLineToPresentation,
  storageLineToPresentation,
} from '../../source-coordinates.js';

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
  start_character: number | null;
  end_line: number;
  end_character: number | null;
  selection_line: number | null;
  selection_character: number | null;
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
  const storedSymbols = db
    .prepare(
      `SELECT s.*,
              sm.line_count,
              sm.param_count,
              sm.cyclomatic,
              sm.max_nesting
         FROM effective_symbol_metrics sm
         JOIN effective_symbols s ON s.id = sm.symbol_id
        WHERE sm.cyclomatic >= ?
        ORDER BY sm.cyclomatic DESC, s.id ASC
        LIMIT ?`,
    )
    .all(minCyclomatic, limit) as ComplexitySymbolRow[];

  const symbols = storedSymbols.map((symbol) => ({
    ...symbol,
    start_line: storageLineToPresentation(symbol.start_line),
    start_character: nullableStorageCharacterToPresentation(symbol.start_character),
    end_line: storageLineToPresentation(symbol.end_line),
    end_character: nullableStorageCharacterToPresentation(symbol.end_character),
    selection_line: nullableStorageLineToPresentation(symbol.selection_line),
    selection_character: nullableStorageCharacterToPresentation(symbol.selection_character),
  }));

  return { symbols };
}
