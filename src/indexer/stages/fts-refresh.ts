/**
 * Keep the FTS5 symbol index synchronized with the effective symbol layer.
 *
 * Baseline builds rebuild the derived index in one bulk pass. Overlay updates
 * delete only symbols made ineffective by the update and replace rows for the
 * changed files, leaving every unrelated FTS row untouched.
 */

import type { Database } from '../../db/schema.js';
import type { PipelineContext, PipelineStage } from '../pipeline.js';

interface FtsSymbolRow {
  id: number;
  name: string;
  signature: string;
  kind: string;
}

const SQLITE_PARAMETER_BATCH = 400;

export class FtsRefreshStage implements PipelineStage {
  readonly name = 'fts-refresh';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    if (mode === 'build' || context.layer === 'baseline') {
      rebuildFts(context.db);
      return;
    }
    refreshOverlayFts(context);
  }
}

function rebuildFts(db: Database.Database): void {
  db.transaction(() => {
    // Candidate baseline symbol IDs are globally unique. Insert/replace their
    // rows without deleting the active generation, which remains queryable by
    // concurrent readers until the promotion pointer changes.
    db.exec(`
      INSERT INTO symbols_fts(rowid, name, signature, kind)
      SELECT s.id,
             s.name,
             COALESCE(s.resolved_type_signature, '') || char(10) ||
             COALESCE(s.resolved_return_type, '')    || char(10) ||
             COALESCE(s.signature, '')               || char(10) ||
             s.name,
             s.kind
      FROM effective_symbols s
    `);
  })();
}

function refreshOverlayFts(context: PipelineContext): void {
  const staleIds = uniqueIds(context.staleSymbolIds);
  const changedPaths = [...new Set(context.changedSourcePaths)];
  const rows: FtsSymbolRow[] = [];

  for (let offset = 0; offset < changedPaths.length; offset += SQLITE_PARAMETER_BATCH) {
    const batch = changedPaths.slice(offset, offset + SQLITE_PARAMETER_BATCH);
    const placeholders = batch.map(() => '?').join(', ');
    rows.push(...context.db.prepare(
      `SELECT s.id,
              s.name,
              COALESCE(s.resolved_type_signature, '') || char(10) ||
              COALESCE(s.resolved_return_type, '')    || char(10) ||
              COALESCE(s.signature, '')               || char(10) ||
              s.name AS signature,
              s.kind
         FROM effective_symbols s
         JOIN effective_files f ON f.id = s.file_id
        WHERE f.branch = ? AND f.path IN (${placeholders})
        ORDER BY s.id`,
    ).all(context.branch, ...batch) as FtsSymbolRow[]);
  }

  const currentIds = uniqueIds(rows.map((row) => row.id));
  context.db.transaction(() => {
    deleteFtsRows(context.db, staleIds);
    // Existing IDs can be enriched in place, so replace their searchable text
    // even when they were not in the stale-ID set.
    deleteFtsRows(context.db, currentIds);
    const insert = context.db.prepare(
      'INSERT INTO symbols_fts(rowid, name, signature, kind) VALUES (?, ?, ?, ?)',
    );
    for (const row of rows) insert.run(row.id, row.name, row.signature, row.kind);
  })();
}

function deleteFtsRows(db: Database.Database, ids: readonly number[]): void {
  for (let offset = 0; offset < ids.length; offset += SQLITE_PARAMETER_BATCH) {
    const batch = ids.slice(offset, offset + SQLITE_PARAMETER_BATCH);
    db.prepare(
      `DELETE FROM symbols_fts WHERE rowid IN (${batch.map(() => '?').join(', ')})`,
    ).run(...batch);
  }
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
}
