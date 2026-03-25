/**
 * @module indexer/stages/source-index
 *
 * Pipeline stage: walk, parse, extract, and insert symbols/imports/callRefs/
 * typeRefs/relationships/annotations for all source files.
 *
 * This is the first stage in the pipeline and populates `context.files`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../../db/schema.js';
import {
  setLoreMeta,
  getLoreMeta,
  LORE_META_INDEX_CHECKPOINT,
} from '../../db/schema.js';
import { walkFiles, detectLanguageForPath } from '../../discovery/walker.js';
import { ParserPool } from '../../parsing/parser.js';
import { normalizeTypeName } from '../../resolution/call-graph.js';
import { computeSymbolMetrics } from '../../parsing/complexity.js';
import {
  type ExtractionResult,
  type RawSymbol,
  type SymbolExtractor,
} from '../../parsing/extractors/types.js';
import { CExtractor } from '../../parsing/extractors/c.js';
import { RustExtractor } from '../../parsing/extractors/rust.js';
import { PythonExtractor } from '../../parsing/extractors/python.js';
import { CppExtractor } from '../../parsing/extractors/cpp.js';
import { TypeScriptExtractor } from '../../parsing/extractors/typescript.js';
import { JavaScriptExtractor } from '../../parsing/extractors/javascript.js';
import { GoExtractor } from '../../parsing/extractors/go.js';
import { JavaExtractor } from '../../parsing/extractors/java.js';
import { CSharpExtractor } from '../../parsing/extractors/csharp.js';
import { RubyExtractor } from '../../parsing/extractors/ruby.js';
import { PhpExtractor } from '../../parsing/extractors/php.js';
import { SwiftExtractor } from '../../parsing/extractors/swift.js';
import { KotlinExtractor } from '../../parsing/extractors/kotlin.js';
import { ScalaExtractor } from '../../parsing/extractors/scala.js';
import { LuaExtractor } from '../../parsing/extractors/lua.js';
import { BashExtractor } from '../../parsing/extractors/bash.js';
import { ElixirExtractor } from '../../parsing/extractors/elixir.js';
import { ZigExtractor } from '../../parsing/extractors/zig.js';
import { OcamlExtractor } from '../../parsing/extractors/ocaml.js';
import { HaskellExtractor } from '../../parsing/extractors/haskell.js';
import { JuliaExtractor } from '../../parsing/extractors/julia.js';
import { ElmExtractor } from '../../parsing/extractors/elm.js';
import { ObjcExtractor } from '../../parsing/extractors/objc.js';
import type { ParseTask, ParseResult, ParseResultSuccess, WorkerMessage } from './parse-worker.js';

// ─── Extractor registry ───────────────────────────────────────────────────────

const EXTRACTORS: Record<string, SymbolExtractor> = {
  c: new CExtractor(),
  rust: new RustExtractor(),
  python: new PythonExtractor(),
  cpp: new CppExtractor(),
  typescript: new TypeScriptExtractor(),
  javascript: new JavaScriptExtractor(),
  go: new GoExtractor(),
  java: new JavaExtractor(),
  csharp: new CSharpExtractor(),
  ruby: new RubyExtractor(),
  php: new PhpExtractor(),
  swift: new SwiftExtractor(),
  kotlin: new KotlinExtractor(),
  scala: new ScalaExtractor(),
  lua: new LuaExtractor(),
  bash: new BashExtractor(),
  elixir: new ElixirExtractor(),
  zig: new ZigExtractor(),
  ocaml: new OcamlExtractor(),
  haskell: new HaskellExtractor(),
  julia: new JuliaExtractor(),
  elm: new ElmExtractor(),
  objc: new ObjcExtractor(),
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileRow {
  id: number;
  last_hash: string | null;
  size_bytes: number;
}

interface BuildCheckpoint {
  branch: string;
  rootDir: string;
  totalFiles: number;
  nextFileIndex: number;
  updatedAt: number;
}

// ─── Stage ────────────────────────────────────────────────────────────────────

/**
 * Walk source files, parse with tree-sitter, extract symbols/imports/callRefs/
 * typeRefs/relationships/annotations, and persist to the database.
 *
 * Populates `context.files` for use by later stages.
 */
export class SourceIndexStage implements PipelineStage {
  readonly name = 'source-index';

  private pool: ParserPool | null = null;

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    this.pool = new ParserPool();

    if (mode === 'build') {
      const allFiles = await walkFiles(context.walkerConfig);
      let files: Array<{ path: string; language: string }>;

      // Skip files already sourced from SCIP
      if (context.scipSourcedFiles && context.scipSourcedFiles.size > 0) {
        const scipFiles = allFiles.filter(f => context.scipSourcedFiles!.has(f.path));
        files = allFiles.filter(f => !context.scipSourcedFiles!.has(f.path));
        context.log.indexing('source-index: skipping SCIP-sourced files', {
          skipped: context.scipSourcedFiles.size,
          remaining: files.length,
        });

        // Compute symbol metrics for SCIP-sourced files (SCIP doesn't provide
        // cyclomatic complexity data, but tree-sitter can compute it).
        if (scipFiles.length > 0) {
          computeMetricsForScipFiles(context.db, this.pool!, scipFiles, context.branch, context.sourceCache, context.layer, context.generation);
        }
      } else {
        files = allFiles;
      }

      // Merge with any files already added by ScipIndexerStage
      context.files = [...context.files, ...files];
      context.log.indexing('walk complete', { fileCount: files.length });
      await this.processBuild(context, files);
    } else {
      await this.processUpdate(context);
    }
  }

  async dispose(): Promise<void> {
    this.pool = null;
  }

  // ─── Build mode ──────────────────────────────────────────────────────────

  private async processBuild(
    context: PipelineContext,
    files: Array<{ path: string; language: string }>,
  ): Promise<void> {
    const { db, branch } = context;

    const resumeAt = loadBuildCheckpoint(db, branch, context.walkerConfig.rootDir, files.length);
    if (resumeAt > 0) {
      context.log.indexing('resuming from checkpoint', { resumeAt, totalFiles: files.length });
    }

    const remaining = files.slice(resumeAt);
    if (remaining.length === 0) return;

    // Use worker threads for parallel parse+extract on multi-core machines.
    // Workers own their own ParserPool + extractors; main thread handles all DB writes.
    const workerCount = Math.max(1, Math.min(remaining.length, availableParallelism() - 1));

    if (workerCount <= 1) {
      // Single-core fallback: use the serial path
      const pool = this.pool!;
      const BATCH_SIZE = 1000;
      for (let batchStart = resumeAt; batchStart < files.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
        db.transaction(() => {
          for (let i = batchStart; i < batchEnd; i++) {
            const file = files[i];
            if (!file) continue;
            processFile(db, pool, file.path, file.language, branch, context.sourceCache, context.layer, context.generation);
          }
        })();
        if (batchEnd >= files.length || batchEnd % (BATCH_SIZE * 5) < BATCH_SIZE) {
        saveBuildCheckpoint(db, branch, context.walkerConfig.rootDir, batchEnd, files.length);
      }
      }
      return;
    }

    // Pre-fetch existing file hashes from DB so workers can skip unchanged files.
    const existingRows = new Map<string, { hash: string | null; sizeBytes: number }>();
    const layerForLookup = context.layer === 'overlay' ? 'overlay' : 'baseline';
    for (const row of db.prepare(
      'SELECT path, last_hash, size_bytes FROM files WHERE branch = ? AND layer = ?',
    ).iterate(branch, layerForLookup) as Iterable<{ path: string; last_hash: string | null; size_bytes: number }>) {
      existingRows.set(row.path, { hash: row.last_hash, sizeBytes: row.size_bytes });
    }

    // Build tasks for workers
    const tasks: ParseTask[] = remaining.map(f => {
      const existing = existingRows.get(f.path);
      return {
        filePath: f.path,
        language: f.language,
        existingHash: existing?.hash ?? null,
        existingSizeBytes: existing?.sizeBytes ?? 0,
      };
    });

    // Resolve worker script path (compiled JS alongside this file).
    // Fall back to serial path if the compiled worker script isn't available
    // (e.g., running from TypeScript source via vitest).
    const thisFile = fileURLToPath(import.meta.url);
    const workerScript = path.join(path.dirname(thisFile), 'parse-worker.js');

    if (!fs.existsSync(workerScript)) {
      // Serial fallback when worker script is unavailable
      const pool = this.pool!;
      const BATCH_SIZE = 1000;
      for (let batchStart = resumeAt; batchStart < files.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
        db.transaction(() => {
          for (let i = batchStart; i < batchEnd; i++) {
            const file = files[i];
            if (!file) continue;
            processFile(db, pool, file.path, file.language, branch, context.sourceCache, context.layer, context.generation);
          }
        })();
        if (batchEnd >= files.length || batchEnd % (BATCH_SIZE * 5) < BATCH_SIZE) {
        saveBuildCheckpoint(db, branch, context.walkerConfig.rootDir, batchEnd, files.length);
      }
      }
      return;
    }

    // v8 ignore start — parallel path requires compiled worker JS, unreachable in vitest
    context.log.indexing('parallel parse: starting workers', {
      workers: workerCount,
      files: tasks.length,
    });

    // Distribute tasks across workers in round-robin chunks
    const WORKER_BATCH_SIZE = 50;
    const taskChunks: ParseTask[][] = [];
    for (let i = 0; i < tasks.length; i += WORKER_BATCH_SIZE) {
      taskChunks.push(tasks.slice(i, i + WORKER_BATCH_SIZE));
    }

    // Spawn workers and collect results
    const allResults = await runParseWorkers(workerScript, workerCount, taskChunks);

    // Build a path→result map so we can insert in original file order.
    // This preserves checkpoint semantics: checkpoint N means all files
    // before index N in the original `files` array have been inserted.
    const resultsByPath = new Map<string, ParseResult>();
    for (const r of allResults) {
      resultsByPath.set(r.filePath, r);
    }

    // Insert results into DB in batched transactions, in original file order
    const BATCH_SIZE = 1000;
    let processed = 0;
    let skipped = 0;
    let errors = 0;
    for (let batchStart = resumeAt; batchStart < files.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
      db.transaction(() => {
        for (let i = batchStart; i < batchEnd; i++) {
          const file = files[i];
          if (!file) continue;
          const r = resultsByPath.get(file.path);
          if (!r || r.kind === 'error') { errors++; continue; }
          if (r.kind === 'skipped') { skipped++; continue; }
          const existing = db.prepare(
            'SELECT id, last_hash, size_bytes FROM files WHERE path = ? AND branch = ? AND layer = ?',
          ).get(r.filePath, branch, layerForLookup) as FileRow | undefined;
          insertParsedFile(db, r, branch, existing, context.sourceCache, context.layer, context.generation);
          processed++;
        }
      })();
      if (batchEnd >= files.length || batchEnd % (BATCH_SIZE * 5) < BATCH_SIZE) {
        saveBuildCheckpoint(db, branch, context.walkerConfig.rootDir, batchEnd, files.length);
      }
    }

    context.log.indexing('parallel parse: complete', {
      processed,
      skipped,
      errors,
    });
    // v8 ignore stop
  }

  // ─── Update mode ─────────────────────────────────────────────────────────

  private async processUpdate(context: PipelineContext): Promise<void> {
    const { db, branch, walkerConfig } = context;
    const changedFiles = context.changedFiles ?? [];
    const pool = this.pool!;
    const enrichedFiles: Array<{ path: string; language: string }> = [];
    const layer = context.layer;
    const generation = context.generation;

    db.transaction(() => {
      // Collect all baseline file IDs to delete in one batch. Doing a single
      // DELETE FROM files WHERE id IN (...) is faster than N individual deletes,
      // and ON DELETE CASCADE / ON DELETE SET NULL propagate automatically with
      // foreign_keys = ON.
      const baselineFileIdsToDelete: number[] = [];

      for (const filePath of changedFiles) {
        // If the file no longer exists, remove it from the DB
        if (!fs.existsSync(filePath)) {
          if (layer === 'overlay') {
            // Only delete overlay rows; baseline stays for the rebuild
            const overlayRow = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?').get(filePath, branch, 'overlay') as
              | { id: number } | undefined;
            if (overlayRow) {
              const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(overlayRow.id) as Array<{ id: number }>;
              for (const s of symRows) context.staleSymbolIds.push(s.id);
              // Cascade via file_id FK handles all child rows; ON DELETE SET NULL
              // handles resolved_id, callee_id, type_id, and target_symbol_id.
              db.prepare('DELETE FROM files WHERE id = ?').run(overlayRow.id);
            }
            // Mark as dirty with a sentinel so effective_files excludes the baseline row
            db.prepare('INSERT OR REPLACE INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, unixepoch(), ?)').run(filePath, generation);
          } else {
            // Baseline mode: queue for batch delete
            const row = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
              | { id: number } | undefined;
            if (row) {
              const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(row.id) as Array<{ id: number }>;
              for (const s of symRows) context.staleSymbolIds.push(s.id);
              baselineFileIdsToDelete.push(row.id);
            }
          }
          continue;
        }

        const language = detectLanguageForPath(filePath, walkerConfig);
        if (language) {
          enrichedFiles.push({ path: filePath, language });
          context.changedSourcePaths.push(filePath);

          if (layer === 'overlay') {
            // Overlay: delete only prior overlay rows (processFile handles this)
            const overlayRow = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?').get(filePath, branch, 'overlay') as
              | { id: number } | undefined;
            if (overlayRow) {
              const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(overlayRow.id) as Array<{ id: number }>;
              for (const s of symRows) context.staleSymbolIds.push(s.id);
            }
          } else {
            // Baseline: queue the existing row for batch delete
            const existingRow = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
              | { id: number } | undefined;
            if (existingRow) {
              const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(existingRow.id) as Array<{ id: number }>;
              for (const s of symRows) context.staleSymbolIds.push(s.id);
              baselineFileIdsToDelete.push(existingRow.id);
            }
          }
        }
      }

      // Single batch DELETE for all baseline files. Cascade via file_id FK
      // deletes all child rows (symbols, file_imports, external_deps, annotations,
      // symbol_relationships, type_refs). Deleting symbols further cascades to
      // symbol_refs (caller_id), summaries, and metrics; ON DELETE SET NULL
      // automatically nullifies cross-file callee_id / type_id / resolved_id /
      // target_symbol_id references.
      if (baselineFileIdsToDelete.length > 0) {
        const placeholders = baselineFileIdsToDelete.map(() => '?').join(',');
        db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...baselineFileIdsToDelete);
      }

      // Re-process each changed file that still exists on disk
      for (const { path: filePath, language } of enrichedFiles) {
        processFile(db, pool, filePath, language, branch, context.sourceCache, layer, generation);
      }
    })();

    // In update mode, context.files = only the changed/enriched files
    context.files = enrichedFiles;
  }
}

// ─── File processing (extracted from IndexBuilder.processFile) ────────────────

/**
 * Parse one file, extract symbols/imports/callRefs/typeRefs/relationships/
 * routes/annotations, and insert into the DB.
 */
export function processFile(
  db: Database.Database,
  pool: ParserPool,
  filePath: string,
  language: string,
  branch: string,
  sourceCache?: Map<string, string>,
  layer: 'baseline' | 'overlay' = 'baseline',
  generation = 0,
): void {
  // P3: fast-path — check file size via stat before reading+hashing.
  // In overlay mode, look up existing baseline row for hash comparison;
  // overlay rows are always re-created.
  const existing = db.prepare('SELECT id, last_hash, size_bytes FROM files WHERE path = ? AND branch = ? AND layer = ?').get(
    filePath, branch, layer === 'overlay' ? 'overlay' : 'baseline',
  ) as FileRow | undefined;
  if (existing) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === existing.size_bytes && existing.last_hash !== null) {
        // Size matches — read and hash to confirm.
        let source: string;
        try {
          source = fs.readFileSync(filePath, 'utf8');
        } catch {
          return;
        }
        const hash = crypto.createHash('sha256').update(source).digest('hex');
        if (existing.last_hash === hash) return;
        processFileWithSource(db, pool, filePath, language, branch, source, hash, existing, sourceCache, layer, generation);
        return;
      }
    } catch {
      // stat failed (permissions, broken symlink, etc.) — fall through to
      // re-read the file instead of silently skipping it.
    }
  }

  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  if (existing?.last_hash === hash) return;
  processFileWithSource(db, pool, filePath, language, branch, source, hash, existing, sourceCache, layer, generation);
}

/** Core file processing after source has been read and hashed. */
function processFileWithSource(
  db: Database.Database,
  pool: ParserPool,
  filePath: string,
  language: string,
  branch: string,
  source: string,
  hash: string,
  existing: FileRow | undefined,
  sourceCache?: Map<string, string>,
  layer: 'baseline' | 'overlay' = 'baseline',
  generation = 0,
): void {
  // Populate the source cache for later stages (enrichment) to avoid re-reading.
  if (sourceCache) sourceCache.set(filePath, source);

  // Parse the source
  const tree = pool.parse(language, source);
  if (!tree) return;

  const extractor = EXTRACTORS[language];
  if (!extractor) return;

  const result: ExtractionResult = extractor.extract(tree, source, filePath);
  const sizeBytes = Buffer.byteLength(source, 'utf8');

  insertFileAndExtractions(db, filePath, language, branch, source, hash, sizeBytes, existing, result, tree.rootNode.endPosition.row, layer, generation);
}

/**
 * Upsert a file row and insert all extracted symbols, imports, refs,
 * relationships, type refs, and metrics into the database.
 *
 * Shared by both the serial path (`processFileWithSource`) and the
 * parallel worker path (`insertParsedFile`).
 */
function insertFileAndExtractions(
  db: Database.Database,
  filePath: string,
  language: string,
  branch: string,
  source: string,
  hash: string,
  sizeBytes: number,
  existing: FileRow | undefined,
  result: ExtractionResult,
  rootEndRow: number,
  layer: 'baseline' | 'overlay' = 'baseline',
  generation = 0,
): void {

  // Upsert the file row
  let fileId: number;
  if (existing && layer === 'baseline') {
    // Baseline mode: update existing baseline row in place
    db.prepare(
      `UPDATE files SET language = ?, size_bytes = ?, last_hash = ?, source = ?, indexed_at = unixepoch()
        WHERE id = ?`,
    ).run(language, sizeBytes, hash, source, existing.id);
    fileId = existing.id;
    // Remove stale symbols / imports / external deps for this baseline row.
    // symbol_relationships and type_refs with NULL source/symbol_id must be
    // deleted explicitly (cascade only fires for non-null FK rows).
    // Deleting symbols cascades to symbol_refs (caller_id), symbol_summaries,
    // symbol_metrics, and ON DELETE SET NULL nullifies cross-file callee_id /
    // type_id / target_symbol_id references automatically.
    db.prepare('DELETE FROM symbol_relationships WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM type_refs WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM external_deps WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM annotations WHERE file_id = ?').run(fileId);
  } else if (layer === 'overlay') {
    // Overlay mode: delete prior overlay rows for this file (not baseline).
    // Deleting the file row cascades (via file_id FK) to symbols, file_imports,
    // external_deps, annotations, symbol_relationships, and type_refs.
    // Deleting symbols further cascades to symbol_refs (caller_id), summaries,
    // and metrics; ON DELETE SET NULL nullifies cross-file callee_id / type_id /
    // target_symbol_id references automatically.
    const overlayRow = db.prepare(
      'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?',
    ).get(filePath, branch, 'overlay') as { id: number } | undefined;
    if (overlayRow) {
      db.prepare('DELETE FROM files WHERE id = ?').run(overlayRow.id);
    }
    // Insert a new overlay file row (baseline row is untouched)
    const info = db
      .prepare(
        `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(filePath, branch, language, sizeBytes, hash, source, layer, generation) as {
        lastInsertRowid: number | bigint;
      };
    fileId = Number(info.lastInsertRowid);
    // Mark file as dirty
    db.prepare(
      'INSERT OR REPLACE INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, unixepoch(), ?)',
    ).run(filePath, generation);
  } else {
    // Baseline mode, new file
    const info = db
      .prepare(
        `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(filePath, branch, language, sizeBytes, hash, source, layer, generation) as {
        lastInsertRowid: number | bigint;
      };
    fileId = Number(info.lastInsertRowid);
  }

  // Insert symbols (FTS5 index is rebuilt in bulk by ftsRefreshStage)
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment, is_exported, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const symbolIdMap = new Map<string, number>();
  const pendingParents: Array<{ symId: number; parentName: string }> = [];

  for (const sym of result.symbols) {
    // Guard: skip symbols with empty names (malformed AST nodes).
    if (!sym.name) continue;
    const info = insertSymbol.run(
      fileId,
      sym.name,
      sym.kind,
      sym.startLine,
      sym.endLine,
      sym.signature ?? null,
      sym.docComment ?? null,
      sym.isExported ? 1 : 0,
      layer, generation,
    ) as { lastInsertRowid: number | bigint };
    const symId = Number(info.lastInsertRowid);
    symbolIdMap.set(sym.name, symId);
    if (sym.parentName) {
      pendingParents.push({ symId, parentName: sym.parentName });
    }
  }

  // Resolve parent_symbol_id for nested symbols (inner functions, class methods, etc.)
  if (pendingParents.length > 0) {
    const updateParent = db.prepare('UPDATE symbols SET parent_symbol_id = ? WHERE id = ?');
    for (const { symId, parentName } of pendingParents) {
      const parentId = symbolIdMap.get(parentName);
      if (parentId !== undefined) {
        updateParent.run(parentId, symId);
      }
    }
  }

  // Insert symbol metrics (cyclomatic complexity, line count, etc.)
  const insertMetrics = db.prepare(
    `INSERT OR REPLACE INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const sym of result.symbols) {
    if (!sym.name) continue;
    const symId = symbolIdMap.get(sym.name);
    if (symId === undefined) continue;
    const metrics = computeSymbolMetrics(sym, language);
    insertMetrics.run(symId, metrics.line_count, metrics.param_count, metrics.cyclomatic, metrics.max_nesting, layer, generation);
  }

  // Insert raw imports
  const insertImport = db.prepare(
    'INSERT INTO file_imports (file_id, raw_import, layer, generation) VALUES (?, ?, ?, ?)',
  );
  for (const imp of result.imports) {
    insertImport.run(fileId, imp.source, layer, generation);
  }

  // Insert call refs — create a module-level symbol for top-level calls
  const hasTopLevelCalls = result.callRefs.some(ref => !ref.callerSymbol);
  if (hasTopLevelCalls && !symbolIdMap.has('')) {
    const moduleName = path.basename(filePath, path.extname(filePath));
    const info = insertSymbol.run(
      fileId, `<module:${moduleName}>`, 'module',
      0, rootEndRow,
      null, null, 0, layer, generation,
    ) as { lastInsertRowid: number | bigint };
    symbolIdMap.set('', Number(info.lastInsertRowid));
  }

  const insertCallRef = db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, call_character, call_kind, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ref of result.callRefs) {
    const callerId = symbolIdMap.get(ref.callerSymbol);
    if (callerId !== undefined) {
      insertCallRef.run(callerId, fileId, ref.calleeRaw, ref.line, ref.character ?? null, ref.callKind ?? 'direct', layer, generation);
    }
  }

  // Insert relationships
  const insertRelationship = db.prepare(
    `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, character, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const rel of result.relationships) {
    const sourceId = symbolIdMap.get(rel.fromSymbol) ?? null;
    insertRelationship.run(fileId, sourceId, rel.toSymbol, rel.kind, rel.line, rel.character ?? null, layer, generation);
  }

  // Insert type refs
  const insertTypeRef = db.prepare(
    `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ref of result.typeRefs) {
    const symId = symbolIdMap.get(ref.enclosingSymbol) ?? null;
    insertTypeRef.run(fileId, symId, ref.typeRaw, normalizeTypeName(ref.typeRaw), ref.refKind, ref.line, ref.character ?? null, layer, generation);
  }
}

// ─── Parallel worker orchestration ────────────────────────────────────────────

/**
 * Distribute parse tasks across N workers and collect all results.
 * Workers process batches of tasks and post results back as arrays.
 */
/* v8 ignore start — worker orchestration requires compiled JS, untestable in vitest */
async function runParseWorkers(
  workerScript: string,
  workerCount: number,
  taskChunks: ParseTask[][],
): Promise<ParseResult[]> {
  const allResults: ParseResult[] = [];
  let nextChunk = 0;

  const workers: Worker[] = [];
  const workerPromises: Promise<void>[] = [];
  let failed = false;

  function terminateAll(): void {
    for (const w of workers) w.terminate().catch(() => {});
  }

  for (let w = 0; w < workerCount; w++) {
    workerPromises.push(new Promise<void>((resolve, reject) => {
      const worker = new Worker(workerScript);
      workers.push(worker);

      function sendNext(): void {
        if (failed) return;
        if (nextChunk >= taskChunks.length) {
          worker.postMessage({ type: 'done' } satisfies WorkerMessage);
          return;
        }
        const chunk = taskChunks[nextChunk++]!;
        worker.postMessage({ type: 'batch', tasks: chunk } satisfies WorkerMessage);
      }

      worker.on('message', (results: ParseResult[]) => {
        allResults.push(...results);
        sendNext();
      });

      worker.on('error', (err) => {
        failed = true;
        terminateAll();
        reject(err);
      });
      worker.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else if (!failed) {
          failed = true;
          terminateAll();
          reject(new Error(`Parse worker exited with code ${code}`));
        }
      });

      // Send initial batch
      sendNext();
    }));
  }

  await Promise.all(workerPromises);
  return allResults;
}
/* v8 ignore stop */

/**
 * Insert a single parsed file result (from a worker) into the database.
 * Delegates to the shared `insertFileAndExtractions` used by the serial path.
 */
function insertParsedFile(
  db: Database.Database,
  r: ParseResultSuccess,
  branch: string,
  existing: FileRow | undefined,
  sourceCache?: Map<string, string>,
  layer: 'baseline' | 'overlay' = 'baseline',
  generation = 0,
): void {
  if (sourceCache) sourceCache.set(r.filePath, r.source);
  insertFileAndExtractions(db, r.filePath, r.language, branch, r.source, r.hash, r.sizeBytes, existing, r.result, r.rootEndRow, layer, generation);
}

// ─── Metrics-only pass for SCIP-sourced files ─────────────────────────────────

/**
 * Parse SCIP-sourced files with tree-sitter to compute symbol metrics
 * (cyclomatic complexity, nesting depth, etc.) and insert them into
 * the `symbol_metrics` table. SCIP provides accurate cross-references but
 * not complexity data, so tree-sitter fills the gap.
 */
function computeMetricsForScipFiles(
  db: Database.Database,
  pool: ParserPool,
  files: Array<{ path: string; language: string }>,
  branch: string,
  sourceCache?: Map<string, string>,
  layer: 'baseline' | 'overlay' = 'baseline',
  generation = 0,
): void {
  const insertMetrics = db.prepare(
    `INSERT OR REPLACE INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const file of files) {
      // Prefer sourceCache (populated by ScipIndexerStage) to avoid re-reading.
      let source = sourceCache?.get(file.path);
      if (source === undefined) {
        try {
          source = fs.readFileSync(file.path, 'utf8');
        } catch {
          continue;
        }
      }

      const tree = pool.parse(file.language, source);
      if (!tree) continue;

      const extractor = EXTRACTORS[file.language];
      if (!extractor) continue;

      const result = extractor.extract(tree, source, file.path);

      // Look up existing symbol IDs (inserted by ScipIndexerStage)
      const fileRow = db.prepare(
        'SELECT id FROM files WHERE path = ? AND branch = ?',
      ).get(file.path, branch) as { id: number } | undefined;
      if (!fileRow) continue;

      const existingSymbols = db.prepare(
        'SELECT id, name, start_line, end_line FROM symbols WHERE file_id = ?',
      ).all(fileRow.id) as Array<{ id: number; name: string; start_line: number; end_line: number }>;

      // Build a name+line → id map for matching tree-sitter symbols to SCIP symbols
      const symbolMap = new Map<string, { id: number; end_line: number }>();
      for (const sym of existingSymbols) {
        // Key by name; if duplicate names, prefer earlier id
        if (!symbolMap.has(sym.name)) {
          symbolMap.set(sym.name, { id: sym.id, end_line: sym.end_line });
        }
      }

      const patchEndLine = db.prepare(
        'UPDATE symbols SET end_line = ? WHERE id = ?',
      );

      for (const sym of result.symbols) {
        if (!sym.name) continue;
        // Try exact match first, then bare name (strip receiver prefix like "Server.HandleRequest" → "HandleRequest")
        let existing = symbolMap.get(sym.name);
        if (!existing) {
          const dotIdx = sym.name.lastIndexOf('.');
          if (dotIdx >= 0) existing = symbolMap.get(sym.name.slice(dotIdx + 1));
        }
        if (!existing) continue;

        // Patch symbol end_line if tree-sitter provides a wider range than SCIP
        if (sym.endLine > existing.end_line) {
          patchEndLine.run(sym.endLine, existing.id);
        }

        const metrics = computeSymbolMetrics(sym, file.language);
        insertMetrics.run(existing.id, metrics.line_count, metrics.param_count, metrics.cyclomatic, metrics.max_nesting, layer, generation);
      }
    }
  })();
}

// ─── Checkpoint helpers ───────────────────────────────────────────────────────

function loadBuildCheckpoint(
  db: Database.Database,
  branch: string,
  rootDir: string,
  totalFiles: number,
): number {
  const raw = getLoreMeta(db, LORE_META_INDEX_CHECKPOINT);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as Partial<BuildCheckpoint>;
    if (parsed.branch !== branch || parsed.rootDir !== rootDir) return 0;
    const nextFileIndex = parsed.nextFileIndex ?? 0;
    return Math.max(0, Math.min(totalFiles, nextFileIndex));
  } catch {
    return 0;
  }
}

function saveBuildCheckpoint(
  db: Database.Database,
  branch: string,
  rootDir: string,
  nextFileIndex: number,
  totalFiles: number,
): void {
  const checkpoint: BuildCheckpoint = {
    branch,
    rootDir,
    totalFiles,
    nextFileIndex,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, JSON.stringify(checkpoint));
}
