/**
 * @module indexer/stages/reverse-deps
 *
 * Pipeline stage: build/update the `reverse_deps` table from resolved
 * imports and symbol refs.  Maps "file X is depended on by files Y, Z"
 * for impact-set computation during overlay updates.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';

export class ReverseDepsStage implements PipelineStage {
  readonly name = 'reverse-deps';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    const { db } = context;

    if (mode === 'build') {
      // Hidden baseline generations use distinct file IDs, so their derived
      // rows can be populated alongside the active generation. Superseded
      // rows are removed in bounded batches after promotion.
      db.transaction(() => {
        // From resolved file_imports: if file A imports file B, then B→A is a dep.
        db.exec(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT fi.resolved_id, fi.file_id, 'import'
          FROM effective_file_imports fi
          JOIN effective_files target ON target.id = fi.resolved_id
          WHERE fi.resolved_id IS NOT NULL
        `);
        // From resolved symbol_refs: if a ref in file A targets a symbol in file B,
        // then B→A is a ref dependency.
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
    } else {
      // Update mode: refresh reverse_deps for changed files only.
      const changedFiles = context.affectedFilePaths ?? context.changedFiles ?? [];
      if (changedFiles.length === 0) return;

      const staleFileIds = new Set<number>();
      const effectiveFileIds = new Set<number>();
      const getRawFileIds = db.prepare(
        'SELECT id FROM files WHERE path = ? AND branch = ?',
      );
      const getEffectiveFileId = db.prepare(
        'SELECT id FROM effective_files WHERE path = ? AND branch = ?',
      );
      for (const path of changedFiles) {
        const rows = getRawFileIds.all(path, context.branch) as Array<{ id: number }>;
        for (const row of rows) staleFileIds.add(row.id);
        const effective = getEffectiveFileId.get(path, context.branch) as { id: number } | undefined;
        if (effective) effectiveFileIds.add(effective.id);
      }
      if (staleFileIds.size === 0) return;

      db.transaction(() => {
        const deleteByFile = db.prepare(
          'DELETE FROM reverse_deps WHERE file_id = ?',
        );
        const deleteByDependent = db.prepare(
          'DELETE FROM reverse_deps WHERE dependent_id = ?',
        );
        for (const fid of staleFileIds) {
          deleteByFile.run(fid);
          deleteByDependent.run(fid);
        }

        // Re-insert outbound edges from changed files
        // Use effective views (not raw tables) to stay consistent with build mode
        // and respect branch/layer filtering.
        const insertFromImports = db.prepare(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT fi.resolved_id, fi.file_id, 'import'
          FROM effective_file_imports fi
          JOIN effective_files target ON target.id = fi.resolved_id
          WHERE fi.resolved_id IS NOT NULL AND fi.file_id = ?
        `);
        const insertFromRefs = db.prepare(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT s_callee.file_id, sr.file_id, 'ref'
          FROM effective_symbol_refs sr
          JOIN effective_symbols s_callee ON s_callee.id = sr.callee_id
          WHERE sr.callee_id IS NOT NULL
            AND sr.file_id = ?
            AND sr.file_id != s_callee.file_id
        `);

        // Re-insert inbound edges to changed files (from unchanged files)
        const insertInboundImports = db.prepare(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT fi.resolved_id, fi.file_id, 'import'
          FROM effective_file_imports fi
          JOIN effective_files target ON target.id = fi.resolved_id
          WHERE fi.resolved_id IS NOT NULL AND fi.resolved_id = ?
        `);
        const insertInboundRefs = db.prepare(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT s_callee.file_id, sr.file_id, 'ref'
          FROM effective_symbol_refs sr
          JOIN effective_symbols s_callee ON s_callee.id = sr.callee_id
          WHERE sr.callee_id IS NOT NULL
            AND s_callee.file_id = ?
            AND sr.file_id != s_callee.file_id
        `);

        for (const fid of effectiveFileIds) {
          insertFromImports.run(fid);
          insertFromRefs.run(fid);
          insertInboundImports.run(fid);
          insertInboundRefs.run(fid);
        }
      })();
    }
  }
}
