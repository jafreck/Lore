/**
 * @module lore-server/db/queries/semantic
 *
 * Vector / semantic search queries.
 */

import type Database from 'better-sqlite3';
import { presentSymbolRow, type SymbolRow } from './symbols.js';
import {
  escapeLikeWildcards,
  filesTable,
  hasSymbolEmbeddingsTable,
  symbolsTable,
} from './helpers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SemanticSearchSymbolsArgs {
  queryVector: number[];
  branch?: string;
  kind?: string;
  pathPrefix?: string;
  language?: string;
  limit?: number;
}

export interface SemanticSymbolRow extends SymbolRow {
  file_path: string;
  file_branch: string;
  file_language: string;
  score: number;
}

/** Bound the extra KNN work used to recover rows hidden by join-time filters. */
const MAX_FILTERED_SEMANTIC_CANDIDATES = 4096;

function hasSemanticFilters(args: SemanticSearchSymbolsArgs): boolean {
  return args.branch !== undefined
    || args.kind !== undefined
    || args.pathPrefix !== undefined
    || args.language !== undefined;
}

function matchesSemanticFilters(
  row: SemanticSymbolRow,
  args: SemanticSearchSymbolsArgs,
): boolean {
  if (args.branch !== undefined && row.file_branch !== args.branch) return false;
  if (args.kind !== undefined && row.kind !== args.kind) return false;
  if (args.pathPrefix !== undefined && !row.file_path.startsWith(args.pathPrefix)) return false;
  if (args.language !== undefined && row.file_language !== args.language) return false;
  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Search symbols by embedding distance with optional branch filtering. */
export function semanticSearchSymbols(
  db: Database.Database,
  args: SemanticSearchSymbolsArgs,
): SemanticSymbolRow[] {
  if (args.queryVector.length === 0) return [];
  if (!hasSymbolEmbeddingsTable(db)) return [];

  const limit = Math.max(1, Math.floor(args.limit ?? 20));
  const where: string[] = ['se.embedding MATCH ?', 'se.k = ?'];
  const filterParams: Array<string | number> = [];

  if (args.branch !== undefined) {
    where.push('f.branch = ?');
    filterParams.push(args.branch);
  }
  if (args.kind !== undefined) {
    where.push('s.kind = ?');
    filterParams.push(args.kind);
  }
  if (args.pathPrefix !== undefined) {
    where.push(`f.path LIKE ? ESCAPE '\\'`);
    filterParams.push(`${escapeLikeWildcards(args.pathPrefix)}%`);
  }
  if (args.language !== undefined) {
    where.push('f.language = ?');
    filterParams.push(args.language);
  }

  const statement = db.prepare(
      `SELECT s.*, sp.name AS parent_name,
              f.path AS file_path,
              f.branch AS file_branch,
              f.language AS file_language,
              distance AS score
         FROM symbol_embeddings se
         JOIN ${symbolsTable(db)} s ON s.id = se.rowid
         JOIN ${filesTable(db)} f ON f.id = s.file_id
         LEFT JOIN ${symbolsTable(db)} sp ON sp.id = s.parent_symbol_id
        WHERE ${where.join(' AND ')}
        ORDER BY distance ASC,
                 f.path ASC,
                 f.branch ASC,
                 s.name COLLATE NOCASE ASC,
                 s.kind ASC,
                 s.start_line ASC,
                 s.end_line ASC,
                 s.id ASC
        LIMIT ?`,
    );

  const filtered = hasSemanticFilters(args);
  const candidateCap = filtered
    ? Math.max(limit, MAX_FILTERED_SEMANTIC_CANDIDATES)
    : limit;
  let candidateLimit = limit;

  while (true) {
    const candidateRows = statement.all(
      JSON.stringify(args.queryVector),
      candidateLimit,
      ...filterParams,
      limit,
    ) as SemanticSymbolRow[];
    const rows = candidateRows
      .filter((row) => matchesSemanticFilters(row, args))
      .slice(0, limit);

    if (!filtered || rows.length >= limit || candidateLimit >= candidateCap) {
      return rows.map(presentSymbolRow);
    }

    candidateLimit = Math.min(candidateCap, candidateLimit * 2);
  }
}
