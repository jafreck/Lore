/**
 * @module indexer/stages/file-discovery
 *
 * Pipeline stage: walk files and populate `context.files` and `context.sourceCache`.
 *
 * After the SCIP+LSP migration, this stage no longer performs tree-sitter
 * extraction. Its remaining responsibilities are:
 *
 * 1. Walk the project tree to discover source files.
 * 2. Read source file contents into `context.sourceCache` for downstream stages.
 * 3. Insert `files` rows for non-SCIP-sourced files.
 * 4. Handle file deletion in overlay (incremental update) mode.
 *
 * Full extraction is handled by:
 * - `ScipIndexerStage` (baseline builds)
 * - `LspExtractionStage` (overlay/incremental updates)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import {
  setLoreMeta,
  getLoreMeta,
  LORE_META_INDEX_CHECKPOINT,
} from '../../db/schema.js';
import { walkFiles, detectLanguageForPath } from '../../discovery/walker.js';

// ─── Stage implementation ────────────────────────────────────────────────────

export class FileDiscoveryStage implements PipelineStage {
  readonly name = 'file-discovery';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    const log = context.log;
    const db = context.db;
    const rootDir = context.walkerConfig.rootDir;
    const branch = context.branch;
    const layer = context.layer;
    const generation = context.generation;

    // Prepared statements
    const insertFile = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    if (mode === 'update' && context.changedFiles) {
      // ── Overlay update mode ──────────────────────────────────────────────
      // Process only changed files.
      for (const absPath of context.changedFiles) {
        const language = detectLanguageForPath(absPath, context.walkerConfig);
        if (!language) continue;

        // Skip files already sourced from SCIP
        if (context.scipSourcedFiles?.has(absPath)) continue;

        let source: string;
        try {
          source = fs.readFileSync(absPath, 'utf8');
        } catch {
          // File may have been deleted — handle deletion
          const existing = db.prepare(
            'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?',
          ).get(absPath, branch, layer) as { id: number } | undefined;
          if (existing) {
            db.prepare('DELETE FROM symbol_relationships WHERE file_id = ?').run(existing.id);
            db.prepare('DELETE FROM type_refs WHERE file_id = ?').run(existing.id);
            db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existing.id);
            db.prepare('DELETE FROM symbols WHERE file_id = ?').run(existing.id);
            db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(existing.id);
            db.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
          }
          // Insert dirty_files sentinel for overlay cleanup
          db.prepare(
            'INSERT OR REPLACE INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES (?, ?, unixepoch(), ?)',
          ).run(absPath, branch, generation);
          continue;
        }

        context.sourceCache.set(absPath, source);
        const sizeBytes = Buffer.byteLength(source, 'utf8');
        const hash = crypto.createHash('sha256').update(source).digest('hex');

        // Delete existing data for this file
        const existing = db.prepare(
          'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?',
        ).get(absPath, branch, layer) as { id: number } | undefined;
        if (existing) {
          db.prepare('DELETE FROM symbol_relationships WHERE file_id = ?').run(existing.id);
          db.prepare('DELETE FROM type_refs WHERE file_id = ?').run(existing.id);
          db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existing.id);
          db.prepare('DELETE FROM symbols WHERE file_id = ?').run(existing.id);
          db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(existing.id);
          db.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
        }

        // Insert file row
        insertFile.run(absPath, branch, language, sizeBytes, hash, source, layer, generation);

        // Mark dirty for overlay tracking
        db.prepare(
          'INSERT OR REPLACE INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES (?, ?, unixepoch(), ?)',
        ).run(absPath, branch, generation);

        context.files.push({ path: absPath, language });
        context.changedSourcePaths.push(absPath);
      }

      log.indexing('file-discovery: overlay files processed', {
        files: context.files.length,
      });
    } else {
      // ── Build mode ─────────────────────────────────────────────────────────
      // Walk entire project tree.
      const allFiles = await walkFiles(context.walkerConfig);
      let filesProcessed = 0;
      let filesSkippedScip = 0;

      const BATCH_SIZE = 200;
      const batch: Array<{ absPath: string; language: string; source: string; sizeBytes: number; hash: string }> = [];

      const processBatch = db.transaction((items: typeof batch) => {
        for (const { absPath, language, source, sizeBytes, hash } of items) {
          // Delete existing data for this file
          const existing = db.prepare(
            'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?',
          ).get(absPath, branch, layer) as { id: number } | undefined;
          if (existing) {
            db.prepare('DELETE FROM symbol_relationships WHERE file_id = ?').run(existing.id);
            db.prepare('DELETE FROM type_refs WHERE file_id = ?').run(existing.id);
            db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existing.id);
            db.prepare('DELETE FROM symbols WHERE file_id = ?').run(existing.id);
            db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(existing.id);
            db.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
          }

          insertFile.run(absPath, branch, language, sizeBytes, hash, source, layer, generation);
          context.files.push({ path: absPath, language });
          filesProcessed++;
        }
      });

      for (const file of allFiles) {
        const absPath = path.resolve(rootDir, file.path);

        // Skip files already sourced from SCIP
        if (context.scipSourcedFiles?.has(absPath)) {
          filesSkippedScip++;
          continue;
        }

        const language = file.language ?? detectLanguageForPath(absPath, context.walkerConfig);
        if (!language) continue;

        // Skip languages fully covered by SCIP
        if (context.scipSourcedLanguages?.has(language)) {
          filesSkippedScip++;
          continue;
        }

        let source: string;
        try {
          source = fs.readFileSync(absPath, 'utf8');
        } catch {
          continue;
        }

        context.sourceCache.set(absPath, source);
        const sizeBytes = Buffer.byteLength(source, 'utf8');
        const hash = crypto.createHash('sha256').update(source).digest('hex');

        batch.push({ absPath, language, source, sizeBytes, hash });
        if (batch.length >= BATCH_SIZE) {
          processBatch([...batch]);
          batch.length = 0;
        }
      }

      // Process remaining batch
      if (batch.length > 0) {
        processBatch(batch);
      }

      // Save checkpoint
      setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, new Date().toISOString());

      log.indexing('file-discovery: build complete', {
        filesProcessed,
        filesSkippedScip,
      });
    }
  }

  async dispose(): Promise<void> {
    // No persistent resources
  }
}
