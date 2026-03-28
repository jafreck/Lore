/**
 * @module lore-server/db/queries/semantic
 *
 * Vector / semantic search queries.
 */

import type Database from 'better-sqlite3';
import type { SymbolRow } from './symbols.js';
import { hasSymbolEmbeddingsTable } from './helpers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SemanticSearchSymbolsArgs {
  queryVector: number[];
  branch?: string;
  limit?: number;
}

export interface SemanticSymbolRow extends SymbolRow {
  file_path: string;
  file_branch: string;
  score: number;
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
  const params: Array<string | number> = [JSON.stringify(args.queryVector), limit];

  if (args.branch !== undefined) {
    where.push('f.branch = ?');
    params.push(args.branch);
  }

  return db
    .prepare(
      `SELECT s.*, sp.name AS parent_name, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting,
              f.path AS file_path,
              f.branch AS file_branch,
              distance AS score
         FROM symbol_embeddings se
         JOIN symbols s ON s.rowid = se.rowid
         JOIN files f ON f.id = s.file_id
         LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id
         LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id
        WHERE ${where.join(' AND ')}
        ORDER BY distance ASC,
                 f.path ASC,
                 f.branch ASC,
                 s.name COLLATE NOCASE ASC,
                 s.kind ASC,
                 s.start_line ASC,
                 s.end_line ASC,
                 s.id ASC`,
    )
    .all(...params) as SemanticSymbolRow[];
}
