/**
 * @module lore-server/db/queries/helpers
 *
 * Shared helpers used by all domain-focused query modules.
 */

import type Database from 'better-sqlite3';

/** Escape SQL LIKE wildcard characters (`%` and `_`) so they match literally. */
export function escapeLikeWildcards(value: string): string {
  return value.replace(/[%_]/g, (ch) => `\\${ch}`);
}

/** Hard ceiling applied to all result-set limits to prevent OOM on unbounded queries. */
export const MAX_RESULT_LIMIT = 10_000;

/**
 * Cache whether a database has effective_* views, keyed by file path.
 * Using a path-keyed Map ensures that invalidation from a write handle
 * also clears the cache for read-only handles on the same database file.
 */
const effectiveViewCache = new Map<string, boolean>();

/** Check (and cache) whether this db has the effective_files view. */
export function hasEffectiveViews(db: Database.Database): boolean {
  const key = db.name;
  let result = effectiveViewCache.get(key);
  if (result === undefined) {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'view' AND name = 'effective_files' LIMIT 1")
      .get() as { ok: number } | undefined;
    result = row?.ok === 1;
    effectiveViewCache.set(key, result);
  }
  return result;
}

/**
 * Invalidate the cached effective-views check for the given database.
 * Accepts either a Database handle or a file path string.
 * Call this after creating or dropping effective_* views so subsequent queries
 * pick up the new state instead of using the stale cached value.
 */
export function resetEffectiveViewsCache(db: Database.Database | string): void {
  const key = typeof db === 'string' ? db : db.name;
  effectiveViewCache.delete(key);
}

/** Return the right table/view name for file lookups. */
export function filesTable(db: Database.Database): string {
  return hasEffectiveViews(db) ? 'effective_files' : 'files';
}

/** Return the right table/view name for symbol lookups. */
export function symbolsTable(db: Database.Database): string {
  return hasEffectiveViews(db) ? 'effective_symbols' : 'symbols';
}

/**
 * Clamp a caller-supplied limit to the hard ceiling.
 * When no limit is given, `defaultLimit` is used (default: 1 000).
 */
export function clampLimit(limit: number | undefined, defaultLimit = 1000): number {
  if (limit === undefined) return defaultLimit;
  return Math.min(Math.max(1, limit), MAX_RESULT_LIMIT);
}

export function hasSymbolEmbeddingsTable(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'symbol_embeddings' LIMIT 1",
    )
    .get() as { ok: number } | undefined;
  return row?.ok === 1;
}

export function hasCommitEmbeddingsTable(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'commit_embeddings' LIMIT 1",
    )
    .get() as { ok: number } | undefined;
  return row?.ok === 1;
}
