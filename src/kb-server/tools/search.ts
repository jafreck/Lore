/**
 * @module kb-server/tools/search
 *
 * MCP tool: multi-modal knowledge-base search.
 *
 * Modes:
 *  - "structural"  — BM25 full-text search via FTS5 (symbols_fts).
 *  - "semantic"    — cosine similarity via sqlite-vec vec0 tables (requires embeddings).
 *  - "fused"       — Reciprocal Rank Fusion (k=60) combining structural + semantic.
 *
 * Semantic and fused modes fall back to structural-only when no EmbeddingProvider
 * is supplied, clearly indicating the degradation in `mode_used`.
 */

import type { Database } from '../db.js';
import type { EmbeddingProvider } from '../../indexer/embedder.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_search',
  description:
    'Search the knowledge-base index for symbols matching a natural-language or code query. ' +
    'mode="structural" uses BM25 FTS5 (fast, exact-ish). ' +
    'mode="semantic" uses cosine similarity over embedding vectors (requires indexed embeddings). ' +
    'mode="fused" combines both with Reciprocal Rank Fusion (RRF k=60).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query string.',
      },
      mode: {
        type: 'string',
        enum: ['structural', 'semantic', 'fused'],
        description: 'Search mode (default: "structural").',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 20).',
      },
    },
    required: ['query'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface SearchArgs {
  query: string;
  mode?: 'structural' | 'semantic' | 'fused';
  limit?: number;
  branch?: string;
}

export interface SearchResult {
  results: Array<{
    symbol_id: number;
    name: string;
    kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    score: number;
    branch: string;
  }>;
  mode_used: string;
}

/**
 * Sanitise a user-provided query string for FTS5 MATCH.
 *
 * FTS5 has its own query grammar where characters like `*`, `OR`, `NOT`, `-`,
 * `^`, `"`, `(`, `)` carry special meaning.  Wrapping the query in escaped
 * double-quotes forces FTS5 to treat it as a literal phrase, preventing
 * syntax errors and injection from symbol names like `operator+` or `T*`.
 */
function sanitizeFts5Query(query: string): string {
  // Escape interior double-quotes, then wrap in double-quotes for a phrase query.
  return `"${query.replace(/"/g, '""')}"`;
}

/** Run a structural BM25 FTS5 search and return ranked rows. */
function structuralSearch(
  db: Database.Database,
  query: string,
  limit: number,
  branch?: string,
): SearchResult['results'] {
  const safeQuery = sanitizeFts5Query(query);
  const branchClause = branch !== undefined ? ' AND f.branch = ?' : '';
  try {
    const sql = `SELECT s.id AS symbol_id, s.name, s.kind, f.path AS file_path,
                s.start_line, s.end_line,
                bm25(symbols_fts) AS score,
                f.branch AS branch
           FROM symbols_fts
           JOIN symbols s ON s.rowid = symbols_fts.rowid
           JOIN files   f ON f.id   = s.file_id
          WHERE symbols_fts MATCH ?${branchClause}
          ORDER BY score
          LIMIT ?`;
    const params = branch !== undefined ? [safeQuery, branch, limit] : [safeQuery, limit];
    const rows = db.prepare(sql).all(...params) as SearchResult['results'];
    return rows;
  } catch {
    // FTS5 parse error — fall back to LIKE-based search.
    const likeQuery = `%${query}%`;
    const sql = `SELECT s.id AS symbol_id, s.name, s.kind, f.path AS file_path,
                s.start_line, s.end_line,
                0.0 AS score,
                f.branch AS branch
           FROM symbols s
           JOIN files f ON f.id = s.file_id
          WHERE s.name LIKE ?${branchClause}
          LIMIT ?`;
    const params = branch !== undefined ? [likeQuery, branch, limit] : [likeQuery, limit];
    return db.prepare(sql).all(...params) as SearchResult['results'];
  }
}

/**
 * Attempt a semantic (cosine) search via the vec0 virtual table.
 * Returns `null` when no embedder is available or the table has no rows.
 */
async function semanticSearch(
  db: Database.Database,
  query: string,
  limit: number,
  embedder: EmbeddingProvider,
  branch?: string,
): Promise<SearchResult['results'] | null> {
  try {
    const [queryVec] = await embedder.embed([query]);
    if (!queryVec) return null;

    const branchClause = branch !== undefined ? ' AND f.branch = ?' : '';
    const sql = `SELECT s.id AS symbol_id, s.name, s.kind, f.path AS file_path,
                s.start_line, s.end_line,
                distance AS score,
                f.branch AS branch
           FROM symbol_embeddings
           JOIN symbols s ON s.rowid = symbol_embeddings.rowid
           JOIN files   f ON f.id   = s.file_id
          WHERE embedding MATCH ?${branchClause}
          ORDER BY distance
          LIMIT ?`;
    const params = branch !== undefined
      ? [JSON.stringify(queryVec), branch, limit]
      : [JSON.stringify(queryVec), limit];
    const rows = db.prepare(sql).all(...params) as SearchResult['results'];

    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Reciprocal Rank Fusion (k=60) over structural and semantic result lists.
 *
 * RRF score = Σ 1/(k + rank_i) for each list i where the item appears.
 * Higher score → better rank.
 */
function rrfFuse(
  structural: SearchResult['results'],
  semantic: SearchResult['results'] | null,
  limit: number,
): SearchResult['results'] {
  const k = 60;
  const scores = new Map<number, { item: SearchResult['results'][number]; score: number }>();

  const addList = (list: SearchResult['results']): void => {
    list.forEach((item, idx) => {
      const existing = scores.get(item.symbol_id);
      const contrib = 1 / (k + idx + 1);
      if (existing) {
        existing.score += contrib;
      } else {
        scores.set(item.symbol_id, { item, score: contrib });
      }
    });
  };

  addList(structural);
  if (semantic) addList(semantic);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score }));
}

/** Execute a knowledge-base search in the requested mode. */
export async function handler(
  db: Database.Database,
  args: SearchArgs,
  embedder?: EmbeddingProvider,
): Promise<SearchResult> {
  const limit = args.limit ?? 20;
  const mode = args.mode ?? 'structural';

  const structural = structuralSearch(db, args.query, limit, args.branch);

  if (mode === 'structural') {
    return { results: structural, mode_used: 'structural' };
  }

  if (!embedder) {
    // No query-time embedder available — callers can detect this degradation.
    return { results: structural, mode_used: 'structural (no query-time embedder)' };
  }

  const semantic = await semanticSearch(db, args.query, limit, embedder, args.branch);

  if (mode === 'semantic') {
    if (semantic) {
      return { results: semantic, mode_used: 'semantic' };
    }
    return { results: structural, mode_used: 'structural (fallback: no embeddings)' };
  }

  // mode === 'fused'
  const fused = rrfFuse(structural, semantic, limit);
  const modeUsed = semantic ? 'fused' : 'structural (fallback: no embeddings)';
  return { results: fused, mode_used: modeUsed };
}
