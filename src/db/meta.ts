/**
 * @module db/meta
 *
 * Key-value metadata API backed by the `lore_meta` table.
 * Provides getters, setters, and generation counter helpers used
 * by the indexer and server layers.
 */

import type Database from 'better-sqlite3';

// ─── lore_meta key constants ────────────────────────────────────────────────

export const LORE_META_INDEX_CHECKPOINT = 'index_checkpoint';
export const LORE_META_LAST_HEAD_SHA = 'last_known_head_sha';

// Incremental indexing metadata keys
export const LORE_META_GENERATION = 'generation';
export const LORE_META_GENERATION_PENDING = 'generation_pending';
export const LORE_META_OVERLAY_DIRTY_FILES = 'overlay_dirty_files';
export const LORE_META_BASELINE_HEAD_SHA = 'baseline_head_sha';
export const LORE_META_OVERLAY_HEAD_SHA = 'overlay_head_sha';

// ─── lore_meta helpers ─────────────────────────────────────────────────────

/** Write (or overwrite) a key-value pair in `lore_meta`. */
export function setLoreMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO lore_meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Delete a key from `lore_meta`. */
export function deleteLoreMeta(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM lore_meta WHERE key = ?').run(key);
}

/** Read a value from `lore_meta`; returns `undefined` if the key is absent. */
export function getLoreMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM lore_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Get the current baseline generation counter (defaults to 0). */
export function getGeneration(db: Database.Database): number {
  const val = getLoreMeta(db, LORE_META_GENERATION);
  return val ? parseInt(val, 10) : 0;
}

/** Increment and return the next generation counter (atomic via IMMEDIATE txn). */
export function incrementGeneration(db: Database.Database): number {
  return db.transaction(() => {
    const next = getGeneration(db) + 1;
    setLoreMeta(db, LORE_META_GENERATION, String(next));
    return next;
  }).immediate();
}
