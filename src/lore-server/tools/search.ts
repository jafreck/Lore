/**
 * @module lore-server/tools/search
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
import { semanticSearchDocSections } from '../db.js';

// ─── Observability ────────────────────────────────────────────────────────────

/**
 * Observation emitted after every `lore_search` invocation.
 * Consumers can use this to log, collect metrics, or detect search-quality issues.
 */
export interface SearchObservation {
  /** ISO-8601 timestamp when the search completed. */
  timestamp: string;
  /** The raw query string sent by the caller. */
  query: string;
  /** The mode the caller requested (defaults to 'structural'). */
  requestedMode: 'structural' | 'semantic' | 'fused';
  /** The mode that was actually used (may differ due to fallback). */
  modeUsed: string;
  /** Number of results returned. */
  resultCount: number;
  /** Best (lowest distance / highest BM25) score among results, or `null` if empty. */
  topScore: number | null;
  /** Wall-clock milliseconds for the entire handler call. */
  latencyMs: number;
  /** Branch filter applied, if any. */
  branch?: string;
}

/** Callback invoked after each search completes. Fire-and-forget — errors are swallowed. */
export type SearchObserver = (observation: SearchObservation) => void;

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_search',
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
      path_prefix: {
        type: 'string',
        description: 'Optional source file path prefix filter for symbol results.',
      },
      language: {
        type: 'string',
        description: 'Optional source language filter for symbol results.',
      },
      kind: {
        type: 'string',
        description: 'Optional symbol kind filter for symbol results.',
      },
      doc_path_prefix: {
        type: 'string',
        description: 'Optional documentation path prefix filter for semantic/fused doc-section results.',
      },
      doc_kind: {
        type: 'string',
        description: 'Optional documentation kind filter for semantic/fused doc-section results.',
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
  path_prefix?: string;
  language?: string;
  kind?: string;
  doc_path_prefix?: string;
  doc_kind?: string;
}

export interface SearchResult {
  results: SearchResultItem[];
  mode_used: string;
}

export interface SearchSymbolResult {
  result_type: 'symbol';
  symbol_id: number;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  score: number;
  branch: string;
}

export interface SearchDocSectionResult {
  result_type: 'doc_section';
  doc_section_id: number;
  doc_id: number;
  doc_kind: string;
  doc_title: string;
  section_index: number;
  heading_path: string;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  score: number;
  branch: string;
}

export type SearchResultItem = SearchSymbolResult | SearchDocSectionResult;

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

/** Escape SQL LIKE wildcard characters (`%` and `_`) so they match literally. */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[%_]/g, (ch) => `\\${ch}`);
}

function symbolEnrichmentProjection(db: Database.Database): string {
  let columns = new Set<string>();
  try {
    const rows = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>;
    columns = new Set(rows.map((row) => row.name));
  } catch {
    columns = new Set<string>();
  }

  const column = (name: string): string => (
    columns.has(name) ? `s.${name} AS ${name}` : `NULL AS ${name}`
  );

  return [
    column('resolved_type_signature'),
    column('resolved_return_type'),
    column('definition_uri'),
    column('definition_path'),
  ].join(',\n                ');
}

/** Filters for structural/symbol search. */
interface SymbolSearchFilters {
  path_prefix?: string;
  language?: string;
  kind?: string;
}

/** Run a structural BM25 FTS5 search and return ranked rows. */
function structuralSearch(
  db: Database.Database,
  query: string,
  limit: number,
  branch?: string,
  filters?: SymbolSearchFilters,
): SearchSymbolResult[] {
  const safeQuery = sanitizeFts5Query(query);
  const extraClauses: string[] = [];
  const extraParams: Array<string | number> = [];
  if (branch !== undefined) { extraClauses.push('f.branch = ?'); extraParams.push(branch); }
  if (filters?.path_prefix) { extraClauses.push(`f.path LIKE ? ESCAPE '\\'`); extraParams.push(`${escapeLikeWildcards(filters.path_prefix)}%`); }
  if (filters?.language) { extraClauses.push('f.language = ?'); extraParams.push(filters.language); }
  if (filters?.kind) { extraClauses.push('s.kind = ?'); extraParams.push(filters.kind); }
  const extraSql = extraClauses.length > 0 ? ` AND ${extraClauses.join(' AND ')}` : '';
  const enrichmentProjection = symbolEnrichmentProjection(db);
  try {
    const sql = `SELECT 'symbol' AS result_type,
                s.id AS symbol_id, s.name, s.kind, f.path AS file_path,
                s.start_line, s.end_line,
                ${enrichmentProjection},
                bm25(symbols_fts) AS score,
                f.branch AS branch
           FROM symbols_fts
           JOIN symbols s ON s.rowid = symbols_fts.rowid
           JOIN files   f ON f.id   = s.file_id
          WHERE symbols_fts MATCH ?${extraSql}
          ORDER BY score
           LIMIT ?`;
    const params = [safeQuery, ...extraParams, limit];
    const rows = db.prepare(sql).all(...params) as SearchSymbolResult[];
    return rows;
  } catch {
    // FTS5 parse error — fall back to LIKE-based search.
    const likeQuery = `%${query}%`;
    const sql = `SELECT 'symbol' AS result_type,
                s.id AS symbol_id, s.name, s.kind, f.path AS file_path,
                s.start_line, s.end_line,
                ${enrichmentProjection},
                0.0 AS score,
                f.branch AS branch
           FROM symbols s
           JOIN files f ON f.id = s.file_id
          WHERE s.name LIKE ?${extraSql}
           LIMIT ?`;
    const params = [likeQuery, ...extraParams, limit];
    return db.prepare(sql).all(...params) as SearchSymbolResult[];
  }
}

function hasVirtualTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ? LIMIT 1",
    )
    .get(name) as { present: number } | undefined;
  return row?.present === 1;
}

function semanticSymbolSearch(
  db: Database.Database,
  queryVector: number[],
  limit: number,
  branch?: string,
): SearchSymbolResult[] {
  if (!hasVirtualTable(db, 'symbol_embeddings')) {
    return [];
  }

  const branchClause = branch !== undefined ? ' AND f.branch = ?' : '';
  const enrichment = symbolEnrichmentProjection(db);
  const sql = `SELECT 'symbol' AS result_type,
              s.id AS symbol_id, s.name, s.kind, f.path AS file_path,
              s.start_line, s.end_line,
              ${enrichment},
              distance AS score,
              f.branch AS branch
         FROM symbol_embeddings
         JOIN symbols s ON s.rowid = symbol_embeddings.rowid
         JOIN files   f ON f.id   = s.file_id
        WHERE embedding MATCH ?
          AND k = ?${branchClause}
        ORDER BY distance
        LIMIT ?`;
  const params = branch !== undefined
    ? [JSON.stringify(queryVector), limit, branch, limit]
    : [JSON.stringify(queryVector), limit, limit];

  try {
    return db.prepare(sql).all(...params) as SearchSymbolResult[];
  } catch {
    return [];
  }
}

function semanticDocSectionSearch(
  db: Database.Database,
  queryVector: number[],
  limit: number,
  branch?: string,
  docFilters?: { doc_path_prefix?: string; doc_kind?: string },
): SearchDocSectionResult[] {
  if (!hasVirtualTable(db, 'doc_section_embeddings')) {
    return [];
  }

  try {
    const rows = semanticSearchDocSections(db, {
      queryVector,
      branch,
      limit,
      ...(docFilters?.doc_path_prefix && { path: docFilters.doc_path_prefix }),
      ...(docFilters?.doc_kind && { kind: docFilters.doc_kind }),
    });
    return rows.map((row) => ({
      result_type: 'doc_section',
      doc_section_id: row.id,
      doc_id: row.doc_id,
      doc_kind: row.doc_kind,
      doc_title: row.doc_title,
      section_index: row.section_index,
      heading_path: row.heading_path,
      name: row.title || row.doc_title,
      kind: 'doc_section',
      file_path: row.doc_path,
      start_line: row.line_start,
      end_line: row.line_end,
      score: row.score,
      branch: row.doc_branch,
    }));
  } catch {
    return [];
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
  docFilters?: { doc_path_prefix?: string; doc_kind?: string },
): Promise<SearchResultItem[] | null> {
  try {
    const [queryVec] = await embedder.embed([query]);
    if (!queryVec) return null;

    const symbolRows = semanticSymbolSearch(db, queryVec, limit, branch);
    const docRows = semanticDocSectionSearch(db, queryVec, limit, branch, docFilters);
    const rows = [...symbolRows, ...docRows]
      .sort((a, b) => a.score - b.score)
      .slice(0, limit);

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
  structural: SearchSymbolResult[],
  semantic: SearchResultItem[] | null,
  limit: number,
): SearchResultItem[] {
  const k = 60;
  const scores = new Map<string, { item: SearchResultItem; score: number }>();

  const resultKey = (item: SearchResultItem): string =>
    item.result_type === 'symbol' ? `symbol:${item.symbol_id}` : `doc:${item.doc_section_id}`;

  const addList = (list: SearchResultItem[]): void => {
    list.forEach((item, idx) => {
      const key = resultKey(item);
      const existing = scores.get(key);
      const contrib = 1 / (k + idx + 1);
      if (existing) {
        existing.score += contrib;
      } else {
        scores.set(key, { item, score: contrib });
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
  observer?: SearchObserver,
): Promise<SearchResult> {
  const start = Date.now();
  const limit = args.limit ?? 20;
  const mode = args.mode ?? 'structural';

  const structural = structuralSearch(db, args.query, limit, args.branch, {
    path_prefix: args.path_prefix,
    language: args.language,
    kind: args.kind,
  });

  let result: SearchResult;

  if (mode === 'structural') {
    result = { results: structural, mode_used: 'structural' };
  } else if (!embedder) {
    // No query-time embedder available — callers can detect this degradation.
    result = { results: structural, mode_used: 'structural (no query-time embedder)' };
  } else {
    const semantic = await semanticSearch(db, args.query, limit, embedder, args.branch, {
      doc_path_prefix: args.doc_path_prefix,
      doc_kind: args.doc_kind,
    });

    if (mode === 'semantic') {
      result = semantic
        ? { results: semantic, mode_used: 'semantic' }
        : { results: structural, mode_used: 'structural (fallback: no embeddings)' };
    } else {
      // mode === 'fused'
      const fused = rrfFuse(structural, semantic, limit);
      const modeUsed = semantic ? 'fused' : 'structural (fallback: no embeddings)';
      result = { results: fused, mode_used: modeUsed };
    }
  }

  // ── Emit observation ─────────────────────────────────────────────────────
  if (observer) {
    try {
      observer({
        timestamp: new Date().toISOString(),
        query: args.query,
        requestedMode: mode,
        modeUsed: result.mode_used,
        resultCount: result.results.length,
        topScore: result.results.length > 0 ? result.results[0]!.score : null,
        latencyMs: Date.now() - start,
        branch: args.branch,
      });
    } catch {
      // Observer errors must never break search.
    }
  }

  return result;
}
