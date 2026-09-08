/**
 * @module indexer/stages/overlay-cleanup
 *
 * Baseline promotion and post-promotion garbage collection.
 *
 * Steps:
 * The visibility switch is intentionally tiny: update the promoted generation,
 * clear dirty selectors, and publish candidate metadata in one transaction.
 * Superseded rows are already invisible after that commit and are reclaimed in
 * bounded transactions so a large repository never turns promotion into a
 * long-running SQLite write lock.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import {
  assertWriterGeneration,
  clearPendingBaselineGeneration,
  deleteLoreMeta,
  getGeneration,
  setLoreMeta,
  LORE_META_GENERATION,
  LORE_META_BASELINE_HEAD_SHA,
} from '../../db/schema.js';

export interface OverlayCleanupOptions {
  /** The new generation that was just written by the baseline rebuild. */
  newGeneration: number;
  /** Unix timestamp when the baseline rebuild started. */
  rebuildStartedAt: number;
  /** HEAD SHA of the new baseline. */
  headSha?: string;
  /** Metadata produced while the generation was hidden. */
  stagedMetadata?: ReadonlyMap<string, string | null>;
}

const CLEANUP_BATCH_SIZE = 200;

export class OverlayCleanupStage implements PipelineStage {
  readonly name = 'overlay-cleanup';

  private options: OverlayCleanupOptions;

  constructor(options: OverlayCleanupOptions) {
    this.options = options;
  }

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const { db, branch } = context;
    const options = {
      ...this.options,
      stagedMetadata: this.options.stagedMetadata ?? context.stagedMetadata,
    };
    db.transaction(() => applyBaselinePromotion(
      db,
      branch,
      options,
      context.writerGeneration,
    )).immediate();
    cleanupSupersededBaselineRows(
      db,
      branch,
      this.options.newGeneration,
      context.writerGeneration,
    );
  }
}

/** Apply only the atomic visibility and metadata switch. Caller owns the transaction. */
export function applyBaselinePromotion(
  db: PipelineContext['db'],
  branch: string,
  options: OverlayCleanupOptions,
  writerGeneration?: number,
): void {
  const { newGeneration, headSha, stagedMetadata } = options;
  if (!Number.isSafeInteger(newGeneration) || newGeneration <= 0) {
    throw new Error(`Invalid baseline generation: ${newGeneration}`);
  }
  if (writerGeneration !== undefined) assertWriterGeneration(db, writerGeneration);
  const promotion = db.prepare(
    `INSERT INTO baseline_generations (branch, generation) VALUES (?, ?)
     ON CONFLICT(branch) DO UPDATE SET generation = excluded.generation
       WHERE baseline_generations.generation < excluded.generation`,
  ).run(branch, newGeneration);
  if (promotion.changes !== 1) {
    const current = db.prepare(
      'SELECT generation FROM baseline_generations WHERE branch = ?',
    ).get(branch) as { generation: number } | undefined;
    throw new Error(
      `Refusing to promote baseline generation ${newGeneration}; branch ${branch} is already at generation ${current?.generation ?? 'unknown'}`,
    );
  }
  const globalGeneration = getGeneration(db);
  if (!Number.isFinite(globalGeneration) || newGeneration > globalGeneration) {
    setLoreMeta(db, LORE_META_GENERATION, String(newGeneration));
  }
  db.prepare('DELETE FROM dirty_files WHERE branch = ?').run(branch);
  clearPendingBaselineGeneration(db, newGeneration);
  if (headSha) setLoreMeta(db, LORE_META_BASELINE_HEAD_SHA, headSha);

  for (const [key, value] of stagedMetadata ?? []) {
    if (value === null) deleteLoreMeta(db, key);
    else setLoreMeta(db, key, value);
  }
}

/** Reclaim rows made invisible by promotion using short, bounded transactions. */
export function cleanupSupersededBaselineRows(
  db: PipelineContext['db'],
  branch: string,
  promotedGeneration: number,
  writerGeneration?: number,
): void {
  const selectFiles = db.prepare(
    `SELECT id FROM files
      WHERE branch = ?
        AND (layer = 'overlay' OR (layer = 'baseline' AND generation < ?))
      ORDER BY id
      LIMIT ?`,
  );

  for (;;) {
    const fileIds = (selectFiles.all(
      branch,
      promotedGeneration,
      CLEANUP_BATCH_SIZE,
    ) as Array<{ id: number }>).map((row) => row.id);
    if (fileIds.length === 0) break;
    const placeholders = fileIds.map(() => '?').join(', ');
    const symbolIds = (db.prepare(
      `SELECT id FROM symbols WHERE file_id IN (${placeholders})`,
    ).all(...fileIds) as Array<{ id: number }>).map((row) => row.id);

    db.transaction(() => {
      if (writerGeneration !== undefined) assertWriterGeneration(db, writerGeneration);
      assertPromotedGeneration(db, branch, promotedGeneration);
      deleteDerivedSymbolRows(db, symbolIds);
      db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...fileIds);
    }).immediate();
  }
}

/** Remove all rows belonging to a failed hidden generation, retaining provenance. */
export function cleanupFailedBaselineGeneration(
  db: PipelineContext['db'],
  branch: string,
  generation: number,
): void {
  const promoted = db.prepare(
    'SELECT generation FROM baseline_generations WHERE branch = ?',
  ).get(branch) as { generation: number } | undefined;
  if (promoted?.generation === generation) {
    throw new Error(`Refusing to clean promoted baseline generation ${generation}`);
  }
  const fileIds = (db.prepare(
    "SELECT id FROM files WHERE branch = ? AND layer = 'baseline' AND generation = ?",
  ).all(branch, generation) as Array<{ id: number }>).map((row) => row.id);
  for (let offset = 0; offset < fileIds.length; offset += CLEANUP_BATCH_SIZE) {
    const batch = fileIds.slice(offset, offset + CLEANUP_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    const symbolIds = (db.prepare(
      `SELECT id FROM symbols WHERE file_id IN (${placeholders})`,
    ).all(...batch) as Array<{ id: number }>).map((row) => row.id);
    db.transaction(() => {
      assertGenerationNotPromoted(db, branch, generation);
      deleteDerivedSymbolRows(db, symbolIds);
      db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...batch);
    }).immediate();
  }
  clearPendingBaselineGeneration(db, generation);
}

function assertGenerationNotPromoted(
  db: PipelineContext['db'],
  branch: string,
  generation: number,
): void {
  const promoted = db.prepare(
    'SELECT generation FROM baseline_generations WHERE branch = ?',
  ).get(branch) as { generation: number } | undefined;
  if (promoted?.generation === generation) {
    throw new Error(`Refusing to clean promoted baseline generation ${generation}`);
  }
}

function assertPromotedGeneration(
  db: PipelineContext['db'],
  branch: string,
  expectedGeneration: number,
): void {
  const promoted = db.prepare(
    'SELECT generation FROM baseline_generations WHERE branch = ?',
  ).get(branch) as { generation: number } | undefined;
  if (promoted?.generation !== expectedGeneration) {
    throw new Error(
      `Baseline cleanup generation ${expectedGeneration} is no longer promoted for branch ${branch}`,
    );
  }
}

function deleteDerivedSymbolRows(db: PipelineContext['db'], symbolIds: readonly number[]): void {
  if (symbolIds.length === 0) return;
  const placeholders = symbolIds.map(() => '?').join(', ');
  for (const table of [
    'symbols_fts',
    'symbol_embeddings',
    'symbol_semantic_embeddings',
    'symbol_embeddings_hashes',
  ]) {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (exists) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`).run(...symbolIds);
      } catch {
        // A connection that did not configure embeddings may not have loaded
        // sqlite-vec. Orphan vectors are inert because searches join through
        // effective_symbols; relational generation cleanup must still finish.
      }
    }
  }
}
