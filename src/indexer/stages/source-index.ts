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
import type { Database } from '../db.js';
import {
  setLoreMeta,
  getLoreMeta,
  LORE_META_INDEX_CHECKPOINT,
} from '../db.js';
import { walkFiles, detectLanguageForPath } from '../walker.js';
import { ParserPool } from '../parser.js';
import { buildStructuralEmbeddingText } from '../embedder.js';
import { normalizeTypeName } from '../call-graph.js';
import {
  type ExtractionResult,
  type RawSymbol,
  type SymbolExtractor,
} from '../extractors/types.js';
import { CExtractor } from '../extractors/c.js';
import { RustExtractor } from '../extractors/rust.js';
import { PythonExtractor } from '../extractors/python.js';
import { CppExtractor } from '../extractors/cpp.js';
import { TypeScriptExtractor } from '../extractors/typescript.js';
import { JavaScriptExtractor } from '../extractors/javascript.js';
import { GoExtractor } from '../extractors/go.js';
import { JavaExtractor } from '../extractors/java.js';
import { CSharpExtractor } from '../extractors/csharp.js';
import { RubyExtractor } from '../extractors/ruby.js';
import { PhpExtractor } from '../extractors/php.js';
import { SwiftExtractor } from '../extractors/swift.js';
import { KotlinExtractor } from '../extractors/kotlin.js';
import { ScalaExtractor } from '../extractors/scala.js';
import { LuaExtractor } from '../extractors/lua.js';
import { BashExtractor } from '../extractors/bash.js';
import { ElixirExtractor } from '../extractors/elixir.js';
import { ZigExtractor } from '../extractors/zig.js';
import { OcamlExtractor } from '../extractors/ocaml.js';
import { HaskellExtractor } from '../extractors/haskell.js';
import { JuliaExtractor } from '../extractors/julia.js';
import { ElmExtractor } from '../extractors/elm.js';
import { ObjcExtractor } from '../extractors/objc.js';

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

    // Save docs auto-notes setting.
    setLoreMeta(context.db, 'docs_auto_notes', context.docsAutoNotes ? '1' : '0');

    if (mode === 'build') {
      const files = await walkFiles(context.walkerConfig);
      context.files = files;
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
          processFile(db, pool, file.path, file.language, branch);
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
            db.prepare('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)').run(row.id);
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
            db.prepare('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
          }

          db.prepare('DELETE FROM files WHERE path = ? AND branch = ?').run(filePath, branch);
          processFile(db, pool, filePath, language, branch);
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
        processFileWithSource(db, pool, filePath, language, branch, source, hash, existing);
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
  processFileWithSource(db, pool, filePath, language, branch, source, hash, existing);
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
): void {
  const sizeBytes = Buffer.byteLength(source, 'utf8');

  // Upsert the file row
  let fileId: number;
  if (existing) {
    db.prepare(
      `UPDATE files SET language = ?, size_bytes = ?, last_hash = ?, source = ?, indexed_at = unixepoch()
        WHERE id = ?`,
    ).run(language, sizeBytes, hash, source, existing.id);
    fileId = existing.id;
    // Remove stale symbols / imports / external deps (also clean up FTS5 index)
    db.prepare(
      'DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)',
    ).run(fileId);
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

  // Insert symbols and keep FTS5 index in sync
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    'INSERT INTO symbols_fts(rowid, name, signature, kind) VALUES (?, ?, ?, ?)',
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
    insertFts.run(
      symId,
      sym.name,
      buildStructuralEmbeddingText({
        name: sym.name,
        signature: sym.signature ?? null,
      }),
      sym.kind,
    );
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
