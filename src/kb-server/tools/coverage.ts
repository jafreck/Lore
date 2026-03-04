/**
 * @module kb-server/tools/coverage
 *
 * MCP tool: query symbol-level coverage and coverage staleness metadata.
 */

import type { Database } from '../db.js';
import {
  getCoverageStaleness,
  getLatestCoverageRun,
  getLatestCoverageTotals,
  getSymbolCoverageAggregates,
  getSymbolsByName,
} from '../db.js';

export const toolDef = {
  name: 'lore_coverage',
  description:
    'Return symbol-level coverage percentages, uncovered lines, and staleness metadata ' +
    'for the latest ingested coverage run.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol_id: {
        type: 'number',
        description: 'Optional symbol id to fetch exact coverage for.',
      },
      symbol_name: {
        type: 'string',
        description: 'Optional symbol name filter (case-insensitive).',
      },
      path: {
        type: 'string',
        description: 'Optional file path filter.',
      },
      branch: {
        type: 'string',
        description: 'Optional branch filter.',
      },
      limit: {
        type: 'number',
        description: 'Maximum symbols to return (default 50).',
      },
    },
    required: [],
  },
} as const;

export interface CoverageArgs {
  symbol_id?: number;
  symbol_name?: string;
  path?: string;
  branch?: string;
  limit?: number;
}

export interface CoverageSymbolResult {
  symbol_id: number;
  symbol_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  covered_lines: number;
  uncovered_lines: number[];
  coverage_percent: number | null;
}

export interface CoverageResult {
  coverage_available: boolean;
  coverage_commit: string | null;
  current_commit: string | null;
  commits_behind: number;
  stale: boolean;
  global_lines_found: number | null;
  global_lines_hit: number | null;
  global_coverage_percent: number | null;
  symbols: CoverageSymbolResult[];
}

const DEFAULT_LIMIT = 50;

export function handler(db: Database.Database, args: CoverageArgs): CoverageResult {
  const latestRun = getLatestCoverageRun(db);
  const staleness = getCoverageStaleness(db);
  const totals = getLatestCoverageTotals(db);
  const limit = Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT));

  let symbolIds: number[] | undefined;
  if (args.symbol_id !== undefined) {
    symbolIds = [args.symbol_id];
  } else if (args.symbol_name !== undefined) {
    symbolIds = getSymbolsByName(db, args.symbol_name, args.branch).map((symbol) => symbol.id);
    if (symbolIds.length === 0) {
      symbolIds = [-1];
    }
  }

  const symbols = latestRun
    ? getSymbolCoverageAggregates(db, {
        symbolIds,
        path: args.path,
        branch: args.branch,
        limit,
      })
    : [];

  return {
    coverage_available: latestRun !== undefined,
    coverage_commit: staleness.coverage_commit,
    current_commit: staleness.current_commit,
    commits_behind: staleness.commits_behind,
    stale: staleness.stale,
    global_lines_found: totals?.lines_found ?? null,
    global_lines_hit: totals?.lines_hit ?? null,
    global_coverage_percent: totals?.coverage_percent ?? null,
    symbols,
  };
}
