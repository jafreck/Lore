/**
 * @module lore-server/tools/lookup
 *
 * MCP tool: look up symbols by name or files by path.
 */

import type { Database } from '../../db/read-only.js';
import {
  getSymbolsByName,
  getExternalSymbolsByName,
  getFileByPath,
  listSymbols,
  listFiles,
  semanticSearchSymbols,
  type SymbolRow,
  type SemanticSymbolRow,
} from '../../db/read-only.js';
import type { EmbeddingProvider } from '../../embeddings/embedder.js';
import { getCachedEmbedding, setCachedEmbedding } from './embedding-cache.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_lookup',
  description:
    'Look up symbols by name or source files by path in the knowledge-base index. ' +
    'Set `kind` to "symbol" or "file". For kind="symbol", mode="exact" matches names, mode="semantic" prioritizes embedding-nearest symbols, and mode="fused" combines both. ' +
    'Returns an array of matching rows, including persisted enrichment metadata when available.',
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
          'Symbol name or file path to look up (includes persisted enrichment metadata when available).',
      },
      mode: {
        type: 'string',
        enum: ['exact', 'semantic', 'fused'],
        description: 'For kind="symbol", choose exact, semantic, or fused retrieval mode (default: "exact").',
      },
      branch: {
        type: 'string',
        description: 'Optional branch to filter results.',
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
        type: 'integer',
        minimum: 0,
        description:
          'For kind="symbol" with empty query: maximum rows to return (default 20).',
      },
      offset: {
        type: 'integer',
        minimum: 0,
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
  mode?: 'exact' | 'semantic' | 'fused';
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
  mode_used?: string;
}

const SYMBOL_LIMIT = 20;

function symbolKey(row: Pick<SymbolRow, 'id'>): string {
  return `symbol:${row.id}`;
}

function mergeSemanticPreferred(
  exactRows: SymbolRow[],
  semanticRows: SemanticSymbolRow[],
): Array<SymbolRow | SemanticSymbolRow> {
  const seen = new Set(semanticRows.map((row) => symbolKey(row)));
  return [...semanticRows, ...exactRows.filter((row) => !seen.has(symbolKey(row)))];
}

function mergeFused(
  exactRows: SymbolRow[],
  semanticRows: SemanticSymbolRow[],
): Array<SymbolRow | SemanticSymbolRow> {
  const seen = new Set(exactRows.map((row) => symbolKey(row)));
  return [...exactRows, ...semanticRows.filter((row) => !seen.has(symbolKey(row)))];
}

async function semanticLookup(
  db: Database.Database,
  query: string,
  branch: string | undefined,
  embedder: EmbeddingProvider,
): Promise<SemanticSymbolRow[] | null> {
  try {
    let queryVector = getCachedEmbedding(query);
    if (!queryVector) {
      [queryVector] = await embedder.embed([query]);
      if (queryVector) setCachedEmbedding(query, queryVector);
    }
    if (!queryVector || queryVector.length === 0) {
      return null;
    }
    return semanticSearchSymbols(db, { queryVector, branch, limit: SYMBOL_LIMIT });
  } catch {
    return null;
  }
}

/** Resolve a lookup request against the open read-only database. */
export async function handler(
  db: Database.Database,
  args: LookupArgs,
  embedder?: EmbeddingProvider,
): Promise<LookupResult> {
  if (args.kind === 'symbol') {
    const query = args.query.trim();
    const mode = args.mode ?? 'exact';
    const matchMode = args.match_mode ?? 'exact';
    const symbolLookupOptions = {
      branch: args.branch,
      matchMode,
      kind: args.symbol_kind,
      pathPrefix: args.path_prefix,
      language: args.language,
    };

    const exactInternalRows: SymbolRow[] = query
      ? getSymbolsByName(db, query, symbolLookupOptions)
      : listSymbols(db, {
        ...symbolLookupOptions,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      });

    const includeExternalRows =
      !!query
      && matchMode === 'exact'
      && args.path_prefix === undefined
      && args.language === undefined;

    const externalRows = includeExternalRows
      ? getExternalSymbolsByName(db, query).filter((row) => (
        args.symbol_kind === undefined || row.symbol_kind === args.symbol_kind
      ))
      : [];

    const exactRows = [...exactInternalRows, ...externalRows];

    if (!query) {
      return { results: exactRows, mode_used: 'exact' };
    }

    if (mode === 'exact') {
      return { results: exactRows, mode_used: 'exact' };
    }
    if (!embedder) {
      return {
        results: exactRows,
        mode_used: 'exact (fallback: no query-time embedder)',
      };
    }

    const semanticRows = await semanticLookup(db, query, args.branch, embedder);
    if (!semanticRows) {
      return {
        results: exactRows,
        mode_used: 'exact (fallback: no embeddings)',
      };
    }

    if (mode === 'semantic') {
      return {
        results: [...mergeSemanticPreferred(exactInternalRows, semanticRows), ...externalRows],
        mode_used: 'semantic',
      };
    }

    return {
      results: [...mergeFused(exactInternalRows, semanticRows), ...externalRows],
      mode_used: 'fused',
    };
  }

  if (args.query.trim()) {
    const row = getFileByPath(db, args.query, args.branch);
    return { results: row ? [row] : [] };
  }
  return { results: listFiles(db, SYMBOL_LIMIT, args.branch) };
}
