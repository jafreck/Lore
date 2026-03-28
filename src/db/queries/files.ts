/**
 * @module lore-server/db/queries/files
 *
 * File lookup and listing queries.
 */

import type Database from 'better-sqlite3';
import { clampLimit, escapeLikeWildcards, filesTable } from './helpers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FileRow {
  id: number;
  path: string;
  branch: string;
  language: string;
  size_bytes: number;
  last_hash: string | null;
  indexed_at: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Fetch a single file row by primary key. */
export function getFileById(db: Database.Database, id: number, branch?: string): FileRow | undefined {
  const ft = filesTable(db);
  if (branch !== undefined) {
    return db.prepare(`SELECT * FROM ${ft} WHERE id = ? AND branch = ?`).get(id, branch) as FileRow | undefined;
  }
  return db.prepare(`SELECT * FROM ${ft} WHERE id = ?`).get(id) as FileRow | undefined;
}

/** Fetch a single file row by its path. */
export function getFileByPath(db: Database.Database, path: string, branch?: string): FileRow | undefined {
  const ft = filesTable(db);
  if (branch !== undefined) {
    return db.prepare(`SELECT * FROM ${ft} WHERE path = ? AND branch = ? LIMIT 1`).get(path, branch) as FileRow | undefined;
  }
  return db.prepare(`SELECT * FROM ${ft} WHERE path = ? ORDER BY indexed_at DESC, id DESC LIMIT 1`).get(path) as FileRow | undefined;
}

/**
 * Return all indexed files, optionally filtered and paginated.
 *
 * A hard cap of {@link MAX_RESULT_LIMIT} is applied even when no explicit
 * `limit` is passed, using a default of 1 000 rows to prevent unbounded
 * result sets from consuming excessive memory.  Pass an explicit `limit`
 * to retrieve a different number of rows (still subject to the hard cap).
 */
export function listFiles(db: Database.Database, limit?: number, branch?: string): FileRow[] {
  const effectiveLimit = clampLimit(limit);
  const ft = filesTable(db);
  if (branch !== undefined) {
    return db.prepare(`SELECT * FROM ${ft} WHERE branch = ? LIMIT ?`).all(branch, effectiveLimit) as FileRow[];
  }
  return db.prepare(`SELECT * FROM ${ft} LIMIT ?`).all(effectiveLimit) as FileRow[];
}

/** Return indexed files matching an exact path or directory prefix. */
export function listFilesByPathPrefix(
  db: Database.Database,
  pathPrefix: string,
  branch?: string,
  limit = 1000,
): FileRow[] {
  const trimmed = pathPrefix.trim();
  if (!trimmed) return [];
  const normalized = trimmed.endsWith('/') && trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed;
  const likePattern = normalized === '/' ? '/%' : `${escapeLikeWildcards(normalized)}/%`;
  if (branch !== undefined) {
    return db
      .prepare(
        `SELECT * FROM ${filesTable(db)}
         WHERE branch = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
         ORDER BY path ASC, branch ASC
         LIMIT ?`,
      )
      .all(branch, normalized, likePattern, limit) as FileRow[];
  }
  return db
    .prepare(
      `SELECT * FROM ${filesTable(db)}
       WHERE path = ? OR path LIKE ? ESCAPE '\\'
       ORDER BY path ASC, branch ASC
       LIMIT ?`,
    )
    .all(normalized, likePattern, limit) as FileRow[];
}
