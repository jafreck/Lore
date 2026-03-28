/**
 * @module indexer/stages/overlay-cleanup
 *
 * Pipeline stage: remove stale overlay rows after a baseline promotion.
 * Called after a background baseline rebuild completes and atomically
 * promotes the new generation.
 *
 * Steps:
 * 1. Delete old baseline rows (generation < new generation).
 * 2. Clear overlay rows for files that are no longer dirty
 *    (i.e. dirty_since < the rebuild start timestamp).
 * 3. Remove promoted paths from `dirty_files`.
 * 4. Update generation metadata.
 * 5. Rebuild reverse_deps from new baseline.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import {
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
}

export class OverlayCleanupStage implements PipelineStage {
  readonly name = 'overlay-cleanup';

  private options: OverlayCleanupOptions;

  constructor(options: OverlayCleanupOptions) {
    this.options = options;
  }

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const { db, branch } = context;
    const { newGeneration, rebuildStartedAt, headSha } = this.options;

    db.transaction(() => {
      // 1. Delete old baseline rows (previous generation).
      db.prepare(
        "DELETE FROM files WHERE layer = 'baseline' AND branch = ? AND generation < ?",
      ).run(branch, newGeneration);

      // 2. Clear overlay rows for files whose dirty_since is before the rebuild started
      //    (they were not edited during the rebuild, so the new baseline covers them).
      db.prepare(`
        DELETE FROM files WHERE layer = 'overlay'
          AND branch = ?
          AND path IN (SELECT path FROM dirty_files WHERE branch = ? AND dirty_since < ?)
      `).run(branch, branch, rebuildStartedAt);

      // 3. Remove promoted paths from dirty_files.
      db.prepare('DELETE FROM dirty_files WHERE branch = ? AND dirty_since < ?').run(branch, rebuildStartedAt);

      // 4. Update generation metadata.
      setLoreMeta(db, LORE_META_GENERATION, String(newGeneration));
      if (headSha) {
        setLoreMeta(db, LORE_META_BASELINE_HEAD_SHA, headSha);
      }

      // 5. Rebuild reverse_deps from the new baseline.
      db.exec('DELETE FROM reverse_deps');
      db.exec(`
        INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
        SELECT fi.resolved_id, fi.file_id, 'import'
        FROM effective_file_imports fi
        WHERE fi.resolved_id IS NOT NULL
      `);
      db.exec(`
        INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
        SELECT s_callee.file_id, sr.file_id, 'ref'
        FROM effective_symbol_refs sr
        JOIN effective_symbols s_callee ON s_callee.id = sr.callee_id
        WHERE sr.callee_id IS NOT NULL
          AND sr.file_id IS NOT NULL
          AND sr.file_id != s_callee.file_id
      `);
    })();

    // 6. Reclaim space from deleted rows.
    db.pragma('incremental_vacuum');
  }
}
