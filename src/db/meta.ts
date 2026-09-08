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
export const LORE_META_SCIP_C_CPP_REPRODUCIBILITY = 'scip_c_cpp_reproducibility';

// Incremental indexing metadata keys
export const LORE_META_GENERATION = 'generation';
export const LORE_META_GENERATION_PENDING = 'generation_pending';
export const LORE_META_GENERATION_SEQUENCE = 'generation_sequence';
export const LORE_META_WRITER_GENERATION = 'writer_generation';
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

/** Error raised when a reclaimed writer attempts to mutate protected state. */
export class WriterLeaseFenceError extends Error {
  readonly expectedGeneration: number;
  readonly currentGeneration: number;

  constructor(expectedGeneration: number, currentGeneration: number) {
    super(
      `Lost database writer lease: generation ${expectedGeneration} was fenced by generation ${currentGeneration}`,
    );
    this.name = 'WriterLeaseFenceError';
    this.expectedGeneration = expectedGeneration;
    this.currentGeneration = currentGeneration;
  }
}

/** Atomically claim the next monotonic database-backed writer generation. */
export function claimWriterGeneration(db: Database.Database): number {
  return db.transaction(() => {
    const current = readNonNegativeInteger(getLoreMeta(db, LORE_META_WRITER_GENERATION));
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Database writer generation is exhausted');
    }
    const next = current + 1;
    setLoreMeta(db, LORE_META_WRITER_GENERATION, String(next));
    return next;
  }).immediate();
}

/** Return the most recently claimed database-backed writer generation. */
export function getWriterGeneration(db: Database.Database): number {
  return readNonNegativeInteger(getLoreMeta(db, LORE_META_WRITER_GENERATION));
}

/** Fence a stale writer before it changes promotion-sensitive state. */
export function assertWriterGeneration(
  db: Database.Database,
  expectedGeneration: number,
): void {
  const current = getWriterGeneration(db);
  if (current !== expectedGeneration) {
    throw new WriterLeaseFenceError(expectedGeneration, current);
  }
}

/** Return the baseline generation currently promoted for `branch`. */
export function getPromotedGeneration(db: Database.Database, branch: string): number {
  const promoted = db.prepare(
    'SELECT generation FROM baseline_generations WHERE branch = ?',
  ).get(branch) as { generation: number } | undefined;
  return promoted?.generation ?? 0;
}

/**
 * Reserve a generation number without making it visible. The pending marker
 * is diagnostic only; promotion happens later inside the complete build
 * transaction.
 */
export function reserveBaselineGeneration(
  db: Database.Database,
  branch: string,
  writerGeneration?: number,
): number {
  return db.transaction(() => {
    if (writerGeneration !== undefined) assertWriterGeneration(db, writerGeneration);
    const promoted = getPromotedGeneration(db, branch);
    const storedMaximum = db.prepare(
      `SELECT MAX(generation) AS generation FROM (
         SELECT generation FROM files WHERE layer = 'baseline'
         UNION ALL
         SELECT generation FROM index_runs WHERE layer = 'baseline'
         UNION ALL
         SELECT generation FROM baseline_generations
       )`,
    ).get() as { generation: number | null };
    const pending = readNonNegativeInteger(getLoreMeta(db, LORE_META_GENERATION_PENDING));
    const sequence = readNonNegativeInteger(getLoreMeta(db, LORE_META_GENERATION_SEQUENCE));
    const lastPromoted = getGeneration(db);
    const next = Math.max(
      promoted,
      storedMaximum.generation ?? 0,
      pending,
      sequence,
      lastPromoted,
    ) + 1;
    if (!Number.isSafeInteger(next)) throw new Error('Baseline generation is exhausted');
    setLoreMeta(db, LORE_META_GENERATION_SEQUENCE, String(next));
    setLoreMeta(db, LORE_META_GENERATION_PENDING, String(next));
    return next;
  }).immediate();
}

/** Remove the reservation only when it still belongs to this run. */
export function clearPendingBaselineGeneration(
  db: Database.Database,
  generation: number,
): void {
  db.prepare(
    'DELETE FROM lore_meta WHERE key = ? AND value = ?',
  ).run(LORE_META_GENERATION_PENDING, String(generation));
}

function readNonNegativeInteger(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
