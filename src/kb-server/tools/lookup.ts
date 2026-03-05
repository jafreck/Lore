/**
 * @module kb-server/tools/lookup
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
  semanticSearchSymbols,
  type SymbolRow,
  type SemanticSymbolRow,
} from '../db.js';
import type { EmbeddingProvider } from '../../indexer/embedder.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_lookup',
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
          'For kind="symbol": the symbol name to look up (case-insensitive). ' +
          'For kind="file": the exact file path stored in the index.',
      },
      mode: {
        type: 'string',
        enum: ['exact', 'semantic', 'fused'],
        description: 'For kind="symbol", choose exact, semantic, or fused retrieval mode (default: "exact").',
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
    const [queryVector] = await embedder.embed([query]);
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
    if (!query) {
      return { results: listSymbols(db, SYMBOL_LIMIT, args.branch), mode_used: 'exact' };
    }

    const exactInternalRows = getSymbolsByName(db, query, args.branch);
    const externalRows = getExternalSymbolsByName(db, query);
    const exactRows = [...exactInternalRows, ...externalRows];

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
  } else {
    if (args.query.trim()) {
      const row = getFileByPath(db, args.query, args.branch);
      return { results: row ? [row] : [] };
    }
    return { results: listFiles(db, SYMBOL_LIMIT, args.branch) };
  }
}
