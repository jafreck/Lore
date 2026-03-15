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
      // Full rebuild: clear and repopulate from all resolved imports and refs.
      db.transaction(() => {
        db.exec('DELETE FROM reverse_deps');
        // From resolved file_imports: if file A imports file B, then B→A is a dep.
        db.exec(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT fi.resolved_id, fi.file_id, 'import'
          FROM effective_file_imports fi
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
      const changedFiles = context.changedFiles ?? [];
      if (changedFiles.length === 0) return;

      const changedFileIds = new Set<number>();
      const getFileId = db.prepare(
        'SELECT id FROM effective_files WHERE path = ?',
      );
      for (const path of changedFiles) {
        const row = getFileId.get(path) as { id: number } | undefined;
        if (row) changedFileIds.add(row.id);
      }
      if (changedFileIds.size === 0) return;

      db.transaction(() => {
        const deleteByFile = db.prepare(
          'DELETE FROM reverse_deps WHERE file_id = ?',
        );
        const deleteByDependent = db.prepare(
          'DELETE FROM reverse_deps WHERE dependent_id = ?',
        );
        for (const fid of changedFileIds) {
          deleteByFile.run(fid);
          deleteByDependent.run(fid);
        }

        // Re-insert for changed files
        const insertFromImports = db.prepare(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT fi.resolved_id, fi.file_id, 'import'
          FROM file_imports fi
          WHERE fi.resolved_id IS NOT NULL AND fi.file_id = ?
        `);
        const insertFromRefs = db.prepare(`
          INSERT OR IGNORE INTO reverse_deps (file_id, dependent_id, dep_kind)
          SELECT s_callee.file_id, sr.file_id, 'ref'
          FROM symbol_refs sr
          JOIN symbols s_callee ON s_callee.id = sr.callee_id
          WHERE sr.callee_id IS NOT NULL
            AND sr.file_id = ?
            AND sr.file_id != s_callee.file_id
        `);
        for (const fid of changedFileIds) {
          insertFromImports.run(fid);
          insertFromRefs.run(fid);
        }
      })();
    }
  }
}
