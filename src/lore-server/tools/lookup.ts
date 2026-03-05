/**
 * @module lore-server/tools/lookup
 *
 * MCP tool: look up symbols by name or files by path.
 */

import type { Database } from '../db.js';
import {
  getSymbolsByName,
  getExternalSymbolsByName,
  getFileByPath,
  listSymbols,
  listFiles,
} from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_lookup',
  description:
    'Look up symbols by name or source files by path in the knowledge-base index. ' +
    'Set `kind` to "symbol" or "file". Returns an array of matching rows, including persisted enrichment metadata when available.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['symbol', 'file'],
        description: 'Whether to look up a symbol or a file.',
      },
      query: {
        type: 'string',
        description:
          'For kind="symbol": the symbol name to look up (case-insensitive). ' +
          'For kind="file": the exact file path stored in the index.',
      },
      match_mode: {
        type: 'string',
        enum: ['exact', 'prefix', 'contains'],
        description:
          'For kind="symbol": name matching mode. Defaults to "exact" (case-insensitive).',
      },
      symbol_kind: {
        type: 'string',
        description:
          'For kind="symbol": optional symbol kind filter (for example "function" or "class").',
      },
      path_prefix: {
        type: 'string',
        description: 'For kind="symbol": optional indexed file-path prefix filter.',
      },
      language: {
        type: 'string',
        description: 'For kind="symbol": optional indexed file language filter.',
      },
      limit: {
        type: 'number',
        description:
          'For kind="symbol" with empty query: maximum rows to return (default 20).',
      },
      offset: {
        type: 'number',
        description:
          'For kind="symbol" with empty query: rows to skip before returning results (default 0).',
      },
    },
    required: ['kind', 'query'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface LookupArgs {
  kind: 'symbol' | 'file';
  query: string;
  branch?: string;
  match_mode?: 'exact' | 'prefix' | 'contains';
  symbol_kind?: string;
  path_prefix?: string;
  language?: string;
  limit?: number;
  offset?: number;
}

export interface LookupResult {
  results: unknown[];
}

/** Resolve a lookup request against the open read-only database. */
export function handler(db: Database.Database, args: LookupArgs): LookupResult {
  if (args.kind === 'symbol') {
    const query = args.query.trim();
    const matchMode = args.match_mode ?? 'exact';
    const symbolLookupOptions = {
      branch: args.branch,
      matchMode,
      kind: args.symbol_kind,
      pathPrefix: args.path_prefix,
      language: args.language,
    };
    const rows = query
      ? [
        ...getSymbolsByName(db, query, symbolLookupOptions),
        ...(
          matchMode === 'exact' && args.path_prefix === undefined && args.language === undefined
            ? getExternalSymbolsByName(db, query).filter((row) => (
              args.symbol_kind === undefined || row.symbol_kind === args.symbol_kind
            ))
            : []
        ),
      ]
      : listSymbols(db, {
        ...symbolLookupOptions,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      });
    return { results: rows };
  } else {
    if (args.query.trim()) {
      const row = getFileByPath(db, args.query, args.branch);
      return { results: row ? [row] : [] };
    }
    return { results: listFiles(db, 20, args.branch) };
  }
}
