/**
 * @module indexer/stages/import-resolution
 *
 * Pipeline stage: resolve raw import strings to file IDs (internal) or
 * external package names. Populates `file_imports.resolved_id` and
 * `external_deps` rows.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { ImportResolver } from '../resolver.js';

// ─── Stage ────────────────────────────────────────────────────────────────────

/**
 * Resolves raw imports in `file_imports` to internal file IDs (`resolved_id`)
 * or external package names (`external_deps`).
 */
export class ImportResolutionStage implements PipelineStage {
  readonly name = 'import-resolution';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const { db, branch, walkerConfig } = context;
    const rootDir = walkerConfig.rootDir;
    const resolver = new ImportResolver();

    // Fetch all unresolved imports with their file's path, language, and file_id
    const rows = db
      .prepare(
        `SELECT fi.id, fi.file_id, fi.raw_import, f.path, f.language
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_id IS NULL AND f.branch = ?`,
      )
      .all(branch) as Array<{
        id: number;
        file_id: number;
        raw_import: string;
        path: string;
        language: string;
      }>;

    const updateResolved = db.prepare(
      'UPDATE file_imports SET resolved_id = ? WHERE id = ?',
    );
    const insertExternalDep = db.prepare(
      'INSERT OR IGNORE INTO external_deps (file_id, package) VALUES (?, ?)',
    );

    for (const row of rows) {
      const resolved = resolver.resolve(
        { source: row.raw_import, importedNames: [] },
        row.path,
        rootDir,
        row.language,
      );

      if (resolved.resolvedPath) {
        const targetFile = db
          .prepare('SELECT id FROM files WHERE path = ? AND branch = ?')
          .get(resolved.resolvedPath, branch) as { id: number } | undefined;
        if (targetFile) {
          updateResolved.run(targetFile.id, row.id);
        }
      } else if (resolved.isExternal && resolved.externalName) {
        insertExternalDep.run(row.file_id, resolved.externalName);
      }
    }

    context.log.indexing('imports resolved', { totalUnresolved: rows.length });
  }
}
