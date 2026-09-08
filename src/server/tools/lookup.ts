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

const queryEmbeddingCache = new Map<string, { vector: number[]; ts: number }>();
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Clear the query embedding cache. Exposed for testing. */
export function clearQueryEmbeddingCache(): void {
  queryEmbeddingCache.clear();
}

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
  filters: Pick<LookupArgs, 'symbol_kind' | 'path_prefix' | 'language'>,
  embedder: EmbeddingProvider,
): Promise<SemanticSymbolRow[] | null> {
  const searchArgs = (queryVector: number[]) => ({
    queryVector,
    branch,
    kind: filters.symbol_kind,
    pathPrefix: filters.path_prefix,
    language: filters.language,
    limit: SYMBOL_LIMIT,
  });
  try {
    const cacheKey = query;
    const now = Date.now();
    const cached = queryEmbeddingCache.get(cacheKey);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return semanticSearchSymbols(db, searchArgs(cached.vector));
    }
    const [queryVector] = await embedder.embed([query]);
    if (!queryVector || queryVector.length === 0) {
      return null;
    }
    // Evict oldest if at capacity
    if (queryEmbeddingCache.size >= CACHE_MAX_SIZE) {
      const oldestKey = queryEmbeddingCache.keys().next().value;
      if (oldestKey !== undefined) queryEmbeddingCache.delete(oldestKey);
    }
    queryEmbeddingCache.set(cacheKey, { vector: queryVector, ts: now });
    return semanticSearchSymbols(db, searchArgs(queryVector));
  } catch {
    return null;
  }
}

function semanticRowMatchesFilters(
  row: SemanticSymbolRow,
  args: Pick<LookupArgs, 'symbol_kind' | 'path_prefix' | 'language'>,
): boolean {
  if (args.symbol_kind !== undefined && row.kind !== args.symbol_kind) return false;
  if (args.path_prefix !== undefined && !row.file_path.startsWith(args.path_prefix)) return false;
  const rowLanguage = row.file_language
    ?? (row as SemanticSymbolRow & { language?: string }).language;
  if (args.language !== undefined && rowLanguage !== args.language) return false;
  return true;
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

    const semanticRows = await semanticLookup(db, query, args.branch, args, embedder);
    if (!semanticRows) {
      return {
        results: exactRows,
        mode_used: 'exact (fallback: no embeddings)',
      };
    }
    const filteredSemanticRows = semanticRows.filter((row) => semanticRowMatchesFilters(row, args));

    if (mode === 'semantic') {
      return {
        results: [...mergeSemanticPreferred(exactInternalRows, filteredSemanticRows), ...externalRows],
        mode_used: 'semantic',
      };
    }

    return {
      results: [...mergeFused(exactInternalRows, filteredSemanticRows), ...externalRows],
      mode_used: 'fused',
    };
  }

  if (args.query.trim()) {
    const row = getFileByPath(db, args.query, args.branch);
    return { results: row ? [row] : [] };
  }
  return { results: listFiles(db, SYMBOL_LIMIT, args.branch) };
}
