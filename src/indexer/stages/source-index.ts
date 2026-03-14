/**
 * @module indexer/stages/source-index
 *
 * Pipeline stage: walk, parse, extract, and insert symbols/imports/callRefs/
 * typeRefs/relationships/routes/annotations for all source files.
 *
 * This is the first stage in the pipeline and populates `context.files`.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
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
 * typeRefs/relationships/routes/annotations, and persist to the database.
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
          computeMetricsForScipFiles(context.db, this.pool!, scipFiles, context.branch, context.sourceCache);
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
    const pool = this.pool!;

    const resumeAt = loadBuildCheckpoint(db, branch, context.walkerConfig.rootDir, files.length);
    if (resumeAt > 0) {
      context.log.indexing('resuming from checkpoint', { resumeAt, totalFiles: files.length });
    }

    // Process in batched transactions so that checkpoints survive crashes.
    const BATCH_SIZE = 200;
    for (let batchStart = resumeAt; batchStart < files.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length);
      db.transaction(() => {
        for (let i = batchStart; i < batchEnd; i++) {
          const file = files[i];
          if (!file) continue;
          processFile(db, pool, file.path, file.language, branch, context.sourceCache);
        }
      })();
      // Checkpoint between batches — committed outside the batch transaction
      // so it persists even if a later batch crashes.
      saveBuildCheckpoint(db, branch, context.walkerConfig.rootDir, batchEnd, files.length);
    }
  }

  // ─── Update mode ─────────────────────────────────────────────────────────

  private async processUpdate(context: PipelineContext): Promise<void> {
    const { db, branch, walkerConfig } = context;
    const changedFiles = context.changedFiles ?? [];
    const pool = this.pool!;
    const enrichedFiles: Array<{ path: string; language: string }> = [];

    db.transaction(() => {
      for (const filePath of changedFiles) {
        // If the file no longer exists, remove it from the DB
        if (!fs.existsSync(filePath)) {
          const row = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
            | { id: number }
            | undefined;
          if (row) {
            const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(row.id) as Array<{ id: number }>;
            for (const s of symRows) context.staleSymbolIds.push(s.id);
            db.prepare('UPDATE file_imports SET resolved_id = NULL WHERE resolved_id = ?').run(row.id);
            db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(row.id);
            db.prepare('UPDATE type_refs SET type_id = NULL WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(row.id);
            db.prepare('UPDATE symbol_relationships SET target_symbol_id = NULL WHERE target_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(row.id);
            db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
          }
          continue;
        }

        const language = detectLanguageForPath(filePath, walkerConfig);
        if (language) {
          enrichedFiles.push({ path: filePath, language });
          context.changedSourcePaths.push(filePath);
          const existingRow = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
            | { id: number }
            | undefined;
          if (existingRow) {
            const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(existingRow.id) as Array<{ id: number }>;
            for (const s of symRows) context.staleSymbolIds.push(s.id);
            db.prepare('UPDATE file_imports SET resolved_id = NULL WHERE resolved_id = ?').run(existingRow.id);
            db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
            db.prepare('UPDATE type_refs SET type_id = NULL WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
            db.prepare('UPDATE symbol_relationships SET target_symbol_id = NULL WHERE target_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
          }

          db.prepare('DELETE FROM files WHERE path = ? AND branch = ?').run(filePath, branch);
          processFile(db, pool, filePath, language, branch, context.sourceCache);
        }
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
): void {
  // P3: fast-path — check file size via stat before reading+hashing.
  const existing = db.prepare('SELECT id, last_hash, size_bytes FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
    | FileRow
    | undefined;
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
        processFileWithSource(db, pool, filePath, language, branch, source, hash, existing, sourceCache);
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
  processFileWithSource(db, pool, filePath, language, branch, source, hash, existing, sourceCache);
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
): void {
  // Populate the source cache for later stages (enrichment) to avoid re-reading.
  if (sourceCache) sourceCache.set(filePath, source);

  const sizeBytes = Buffer.byteLength(source, 'utf8');

  // Upsert the file row
  let fileId: number;
  if (existing) {
    db.prepare(
      `UPDATE files SET language = ?, size_bytes = ?, last_hash = ?, source = ?, indexed_at = unixepoch()
        WHERE id = ?`,
    ).run(language, sizeBytes, hash, source, existing.id);
    fileId = existing.id;
    // Remove stale symbols / imports / external deps
    db.prepare('DELETE FROM symbol_relationships WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM type_refs WHERE file_id = ?').run(fileId);
    // NULL out cross-file FK references that point to symbols in this file
    db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileId);
    db.prepare('UPDATE type_refs SET type_id = NULL WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileId);
    db.prepare('UPDATE symbol_relationships SET target_symbol_id = NULL WHERE target_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(fileId);
    db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM external_deps WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM api_routes WHERE file_id = ?').run(fileId);
    db.prepare('DELETE FROM annotations WHERE file_id = ?').run(fileId);
  } else {
    const info = db
      .prepare(
        `INSERT INTO files (path, branch, language, size_bytes, last_hash, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(filePath, branch, language, sizeBytes, hash, source) as {
        lastInsertRowid: number | bigint;
      };
    fileId = Number(info.lastInsertRowid);
  }

  // Parse the source
  const tree = pool.parse(language, source);
  if (!tree) return;

  const extractor = EXTRACTORS[language];
  if (!extractor) return;

  const result: ExtractionResult = extractor.extract(tree, source, filePath);

  // Insert symbols (FTS5 index is rebuilt in bulk by ftsRefreshStage)
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const symbolIdMap = new Map<string, number>();

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
    ) as { lastInsertRowid: number | bigint };
    const symId = Number(info.lastInsertRowid);
    symbolIdMap.set(sym.name, symId);
  }

  // Insert symbol metrics (cyclomatic complexity, line count, etc.)
  const insertMetrics = db.prepare(
    `INSERT OR REPLACE INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const sym of result.symbols) {
    if (!sym.name) continue;
    const symId = symbolIdMap.get(sym.name);
    if (symId === undefined) continue;
    const metrics = computeSymbolMetrics(sym, language);
    insertMetrics.run(symId, metrics.line_count, metrics.param_count, metrics.cyclomatic, metrics.max_nesting);
  }

  // Insert API routes
  const insertRoute = db.prepare(
    `INSERT INTO api_routes (file_id, method, path, handler_id, handler_name, framework, line, middleware)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const route of result.routes) {
    insertRoute.run(
      fileId,
      route.method,
      route.path,
      symbolIdMap.get(route.handler) ?? null,
      route.handler,
      route.framework,
      route.line,
      route.middleware ? JSON.stringify(route.middleware) : null,
    );
  }

  // Insert raw imports
  const insertImport = db.prepare(
    'INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)',
  );
  for (const imp of result.imports) {
    insertImport.run(fileId, imp.source);
  }

  // Insert call refs
  const insertCallRef = db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, call_character, call_kind)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const ref of result.callRefs) {
    const callerId = symbolIdMap.get(ref.callerSymbol);
    if (callerId !== undefined) {
      insertCallRef.run(callerId, fileId, ref.calleeRaw, ref.line, ref.character ?? null, ref.callKind ?? 'direct');
    }
  }

  // Insert relationships
  const insertRelationship = db.prepare(
    `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, character)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const rel of result.relationships) {
    const sourceId = symbolIdMap.get(rel.fromSymbol) ?? null;
    insertRelationship.run(fileId, sourceId, rel.toSymbol, rel.kind, rel.line, rel.character ?? null);
  }

  // Insert type refs
  const insertTypeRef = db.prepare(
    `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, ref_character)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ref of result.typeRefs) {
    const symId = symbolIdMap.get(ref.enclosingSymbol) ?? null;
    insertTypeRef.run(fileId, symId, ref.typeRaw, normalizeTypeName(ref.typeRaw), ref.refKind, ref.line, ref.character ?? null);
  }
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
): void {
  const insertMetrics = db.prepare(
    `INSERT OR REPLACE INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting)
     VALUES (?, ?, ?, ?, ?)`,
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
      const symbolMap = new Map<string, number>();
      for (const sym of existingSymbols) {
        // Key by name; if duplicate names, prefer earlier id
        if (!symbolMap.has(sym.name)) {
          symbolMap.set(sym.name, sym.id);
        }
      }

      for (const sym of result.symbols) {
        if (!sym.name) continue;
        const symId = symbolMap.get(sym.name);
        if (symId === undefined) continue;
        const metrics = computeSymbolMetrics(sym, file.language);
        insertMetrics.run(symId, metrics.line_count, metrics.param_count, metrics.cyclomatic, metrics.max_nesting);
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
