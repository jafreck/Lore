/**
 * @module indexer/stages/file-discovery
 *
 * Pipeline stage: walk files and populate `context.files` and `context.sourceCache`.
 *
 * Its responsibilities are:
 *
 * 1. Walk the project tree to discover source files.
 * 2. Read source file contents into `context.sourceCache` for downstream stages.
 * 3. Insert `files` rows for non-SCIP-sourced files.
 * 4. Handle file deletion in overlay (incremental update) mode.
 *
 * Structural extraction is handled by:
 * - `ScipIndexerStage` (baseline builds)
 * - `LspExtractionStage` (overlay/incremental updates)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  throwIfPipelineCancelled,
  setPipelineLoreMeta,
  type PipelineContext,
  type PipelineStage,
} from '../pipeline.js';
import {
  LORE_META_INDEX_CHECKPOINT,
  recordIndexerRun,
} from '../../db/schema.js';
import { walkFiles, detectLanguageForPath } from '../../discovery/walker.js';
import { discoverCompilationDatabase } from '../../scip/compdb.js';
import { reconcileEffectiveTargets } from '../../resolution/effective-targets.js';

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
    let discoveredFiles = 0;
    let skippedScipFiles = 0;
    context.compilationDatabase ??= discoverCompilationDatabase(rootDir, undefined, {
      approvedExternalRoots: context.approvedExternalBuildRoots,
      responseFileLimits: context.responseFileLimits,
    });
    const cFamilyOptions = {
      rootDir,
      compilationDatabase: context.compilationDatabase.database,
      sourceCache: context.sourceCache,
    };

    // Prepared statements
    const insertFile = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectExistingFile = db.prepare(
      'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ? AND generation = ?',
    );
    const selectEffectiveFile = db.prepare(
      'SELECT id, last_hash FROM effective_files WHERE path = ? AND branch = ?',
    );
    const deleteRelationshipsForFile = db.prepare(
      'DELETE FROM symbol_relationships WHERE file_id = ?',
    );
    const deleteTypeRefsForFile = db.prepare('DELETE FROM type_refs WHERE file_id = ?');
    const clearCalleeIdsForFile = db.prepare(
      "UPDATE symbol_refs SET callee_id = NULL, resolution_method = 'unresolved' WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)",
    );
    const clearTypeIdsForFile = db.prepare(
      "UPDATE type_refs SET type_id = NULL, resolution_method = 'unresolved' WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)",
    );
    const clearRelationshipTargetIdsForFile = db.prepare(
      "UPDATE symbol_relationships SET target_symbol_id = NULL, resolution_method = 'unresolved' WHERE target_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)",
    );
    const deleteSymbolsForFile = db.prepare('DELETE FROM symbols WHERE file_id = ?');
    const selectSymbolsForFile = db.prepare('SELECT id FROM symbols WHERE file_id = ?');
    const deleteImportsForFile = db.prepare('DELETE FROM file_imports WHERE file_id = ?');
    const deleteFile = db.prepare('DELETE FROM files WHERE id = ?');
    const markDirty = db.prepare(
      'INSERT OR REPLACE INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES (?, ?, unixepoch(), ?)',
    );
    const deleteExistingFile = (id: number): void => {
      const staleSymbols = selectSymbolsForFile.all(id) as Array<{ id: number }>;
      for (const symbol of staleSymbols) context.staleSymbolIds.push(symbol.id);
      deleteRelationshipsForFile.run(id);
      deleteTypeRefsForFile.run(id);
      clearCalleeIdsForFile.run(id);
      clearTypeIdsForFile.run(id);
      clearRelationshipTargetIdsForFile.run(id);
      deleteSymbolsForFile.run(id);
      deleteImportsForFile.run(id);
      deleteFile.run(id);
    };
    const markEffectiveSymbolsStale = (fileId: number): void => {
      const staleSymbols = selectSymbolsForFile.all(fileId) as Array<{ id: number }>;
      for (const symbol of staleSymbols) context.staleSymbolIds.push(symbol.id);
    };

    if (mode === 'update' && context.changedFiles) {
      // ── Overlay update mode ──────────────────────────────────────────────
      // Process only changed files that belong to the exact walker scope.
      // A full walk is used as the authoritative include/exclude/language
      // filter; deleted paths are retained only when they were indexed before.
      const scopedFiles = new Map(
        (await walkFiles(context.walkerConfig, cFamilyOptions))
          .map((file) => [file.path, file.language]),
      );
      context.affectedFilePaths ??= [];
      const affectedPathSet = new Set(context.affectedFilePaths);
      const recordAffectedPath = (filePath: string): void => {
        if (!affectedPathSet.has(filePath)) {
          affectedPathSet.add(filePath);
          context.affectedFilePaths!.push(filePath);
        }
      };
      for (const changedPath of context.changedFiles) {
        throwIfPipelineCancelled(context);
        const requestedPath = path.resolve(changedPath);
        let absPath: string;
        try {
          absPath = fs.realpathSync(requestedPath);
        } catch {
          // Deleted paths cannot be canonicalized directly. Canonicalizing the
          // containing directory still handles aliases such as /var → /private/var.
          try {
            absPath = path.join(fs.realpathSync(path.dirname(requestedPath)), path.basename(requestedPath));
          } catch {
            absPath = requestedPath;
          }
        }
        const language = scopedFiles.get(absPath)
          ?? detectLanguageForPath(absPath, context.walkerConfig);
        const isInCurrentScope = scopedFiles.has(absPath);
        const persisted = selectEffectiveFile.get(absPath, branch) as
          | { id: number; last_hash: string | null }
          | undefined;

        // Skip files already sourced from SCIP
        if (context.scipSourcedFiles?.has(absPath)) continue;

        if (!isInCurrentScope || !language) {
          if (!persisted) continue;
          markEffectiveSymbolsStale(persisted.id);
          const existing = selectExistingFile.get(absPath, branch, layer, generation) as
            | { id: number }
            | undefined;
          if (existing) deleteExistingFile(existing.id);
          recordAffectedPath(absPath);
          markDirty.run(absPath, branch, generation);
          continue;
        }

        let source: string;
        try {
          source = fs.readFileSync(absPath, 'utf8');
        } catch {
          // File may have been deleted — handle deletion
          if (persisted) markEffectiveSymbolsStale(persisted.id);
          const existing = selectExistingFile.get(absPath, branch, layer, generation) as { id: number } | undefined;
          if (existing) {
            deleteExistingFile(existing.id);
          }
          // Insert dirty_files sentinel for overlay cleanup
          recordAffectedPath(absPath);
          markDirty.run(absPath, branch, generation);
          continue;
        }

        context.sourceCache.set(absPath, source);
        const sizeBytes = Buffer.byteLength(source, 'utf8');
        const hash = crypto.createHash('sha256').update(source).digest('hex');
        if (persisted?.last_hash === hash) continue;

        if (persisted) markEffectiveSymbolsStale(persisted.id);
        // Delete existing data for this file
        const existing = selectExistingFile.get(absPath, branch, layer, generation) as { id: number } | undefined;
        if (existing) {
          deleteExistingFile(existing.id);
        }

        // Insert file row
        insertFile.run(absPath, branch, language, sizeBytes, hash, source, layer, generation);

        // Mark dirty for overlay tracking
        recordAffectedPath(absPath);
        markDirty.run(absPath, branch, generation);

        context.files.push({ path: absPath, language });
        context.changedSourcePaths.push(absPath);
        discoveredFiles++;
      }

      const reconciliation = reconcileEffectiveTargets(db, branch);

      log.indexing('file-discovery: overlay files processed', {
        files: context.files.length,
        affectedPaths: context.affectedFilePaths.length,
        ...reconciliation,
      });
    } else {
      // ── Build mode ─────────────────────────────────────────────────────────
      // Walk entire project tree.
      const allFiles = await walkFiles(context.walkerConfig, cFamilyOptions);
      let filesProcessed = 0;
      let filesSkippedScip = 0;

      const BATCH_SIZE = 200;
      const batch: Array<{ absPath: string; language: string; source: string; sizeBytes: number; hash: string }> = [];

      const processBatch = db.transaction((items: typeof batch) => {
        for (const { absPath, language, source, sizeBytes, hash } of items) {
          // Delete existing data for this file
          const existing = selectExistingFile.get(absPath, branch, layer, generation) as { id: number } | undefined;
          if (existing) {
            deleteExistingFile(existing.id);
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
          throwIfPipelineCancelled(context);
          processBatch(batch);
          batch.length = 0;
        }
      }

      // Process remaining batch
      if (batch.length > 0) {
        processBatch(batch);
      }

      // Save checkpoint
      setPipelineLoreMeta(context, LORE_META_INDEX_CHECKPOINT, new Date().toISOString());

      log.indexing('file-discovery: build complete', {
        filesProcessed,
        filesSkippedScip,
      });
      discoveredFiles = filesProcessed;
      skippedScipFiles = filesSkippedScip;
    }

    if (context.runId) {
      recordIndexerRun(db, {
        runId: context.runId,
        provider: 'discovery',
        indexer: 'source-walker',
        languages: [...new Set(context.files.map((file) => file.language))],
        status: 'succeeded',
        attempted: true,
        fallback: discoveredFiles > 0,
        files: discoveredFiles,
        details: { skippedScipFiles },
      });
    }
  }

  async dispose(): Promise<void> {
    // No persistent resources
  }
}
