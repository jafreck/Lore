/**
 * @module indexer/index
 *
 * The `IndexBuilder` class orchestrates the full indexing pipeline:
 *   walk → parse → extract → resolve → persist
 *
 * It also supports incremental updates (`update()`) and a stub for
 * LLM-summary ingestion (`ingestSummary()`).
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  openDb,
  setLoreMeta,
  getLoreMeta,
  createVec0Tables,
  LORE_META_INDEX_CHECKPOINT,
  LORE_META_LAST_HEAD_SHA,
  LORE_META_COVERAGE_LAST_SOURCE_PATH,
  LORE_META_COVERAGE_LAST_SOURCE_MTIME,
} from './db.js';
import type { Database } from './db.js';
import { walkFiles } from './walker.js';
import { detectLanguageForPath } from './walker.js';
import { walkDocumentationFiles } from './walker.js';
import type { WalkerConfig } from './walker.js';
import type { DocumentationFile } from './docs.js';
import { inferSeededDocNoteKey, buildDocNoteScope } from './docs.js';
import { ingestGitHistory } from './git-history.js';
import { ParserPool } from './parser.js';
import { ImportResolver } from './resolver.js';
import { buildCallGraph } from './call-graph.js';
import {
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawSymbol,
  isPublicDeclarationSurfaceSymbol,
} from './extractors/types.js';
import { CExtractor } from './extractors/c.js';
import { RustExtractor } from './extractors/rust.js';
import { PythonExtractor } from './extractors/python.js';
import { CppExtractor } from './extractors/cpp.js';
import { TypeScriptExtractor } from './extractors/typescript.js';
import { JavaScriptExtractor } from './extractors/javascript.js';
import { GoExtractor } from './extractors/go.js';
import { JavaExtractor } from './extractors/java.js';
import { CSharpExtractor } from './extractors/csharp.js';
import { RubyExtractor } from './extractors/ruby.js';
import { PhpExtractor } from './extractors/php.js';
import { SwiftExtractor } from './extractors/swift.js';
import { KotlinExtractor } from './extractors/kotlin.js';
import { ScalaExtractor } from './extractors/scala.js';
import { LuaExtractor } from './extractors/lua.js';
import { BashExtractor } from './extractors/bash.js';
import { ElixirExtractor } from './extractors/elixir.js';
import { ZigExtractor } from './extractors/zig.js';
import { DartExtractor } from './extractors/dart.js';
import { OcamlExtractor } from './extractors/ocaml.js';
import { HaskellExtractor } from './extractors/haskell.js';
import { JuliaExtractor } from './extractors/julia.js';
import { ElmExtractor } from './extractors/elm.js';
import { ObjcExtractor } from './extractors/objc.js';
import type { SymbolExtractor } from './extractors/types.js';
import type { EmbeddingProvider } from './embedder.js';
import { DEFAULT_EMBEDDING_MODEL, buildStructuralEmbeddingText } from './embedder.js';
import { ingestCoverageReport, type CoverageFormat } from './coverage.js';
import { refreshTestMappings } from './test-mapper.js';
import type { EffectiveLspSettings } from './lsp/config.js';
import { LspEnrichmentCoordinator } from './lsp/enrichment.js';

// ─── Extractor registry ───────────────────────────────────────────────────────

const EXTRACTORS: Record<string, SymbolExtractor> = {
  c:          new CExtractor(),
  rust:       new RustExtractor(),
  python:     new PythonExtractor(),
  cpp:        new CppExtractor(),
  typescript: new TypeScriptExtractor(),
  javascript: new JavaScriptExtractor(),
  go:         new GoExtractor(),
  java:       new JavaExtractor(),
  csharp:     new CSharpExtractor(),
  ruby:       new RubyExtractor(),
  php:        new PhpExtractor(),
  swift:      new SwiftExtractor(),
  kotlin:     new KotlinExtractor(),
  scala:      new ScalaExtractor(),
  lua:        new LuaExtractor(),
  bash:       new BashExtractor(),
  elixir:     new ElixirExtractor(),
  zig:        new ZigExtractor(),
  dart:       new DartExtractor(),
  ocaml:      new OcamlExtractor(),
  haskell:    new HaskellExtractor(),
  julia:      new JuliaExtractor(),
  elm:        new ElmExtractor(),
  objc:       new ObjcExtractor(),
};

/** Number of symbols to embed per batch. */
const EMBED_BATCH_SIZE = 64;

// ─── Prepared statement types ─────────────────────────────────────────────────

interface FileRow {
  id: number;
  last_hash: string | null;
}

interface DocumentationRow {
  id: number;
  content_hash: string;
}

interface SeededNoteRow {
  content: string;
  source_hash: string | null;
}

interface BuildCheckpoint {
  branch: string;
  rootDir: string;
  totalFiles: number;
  nextFileIndex: number;
  updatedAt: number;
}

interface IndexBuilderOptions {
  history?: boolean | { depth?: number; all?: boolean };
  embeddingModel?: string;
  docsAutoNotes?: boolean;
  indexDependencies?: boolean;
  lsp?: EffectiveLspSettings;
}

// ─── IndexBuilder ─────────────────────────────────────────────────────────────

/**
 * Orchestrates the full M1 indexing pipeline.
 *
 * @example
 * ```ts
 * const builder = new IndexBuilder('/path/to/lore.db', { rootDir: '/path/to/src' });
 * await builder.build();
 * ```
 */
export class IndexBuilder {
  private readonly dbPath: string;
  private readonly walkerConfig: WalkerConfig;
  private readonly pool: ParserPool;
  private readonly resolver: ImportResolver;
  private readonly embedder: EmbeddingProvider | null;
  private readonly history: boolean | { depth?: number; all?: boolean };
  private readonly indexDependencies: boolean;
  private readonly embeddingModel: string;
  private readonly docsAutoNotes: boolean;
  private readonly lspSettings: EffectiveLspSettings | null;

  constructor(
    dbPath: string,
    walkerConfig: WalkerConfig,
    embedder?: EmbeddingProvider,
    embeddingModelOrOptions?: string | IndexBuilderOptions,
  ) {
    this.dbPath = dbPath;
    this.walkerConfig = walkerConfig;
    this.pool = new ParserPool();
    this.resolver = new ImportResolver();

    const opts =
      typeof embeddingModelOrOptions === 'string'
        ? { embeddingModel: embeddingModelOrOptions }
        : (embeddingModelOrOptions ?? {});

    if (embedder) {
      this.embedder = embedder;
      this.embeddingModel = embedder.modelName;
    } else {
      this.embeddingModel = opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
      this.embedder = null;
    }

    this.history = opts.history ?? false;
    this.docsAutoNotes = opts.docsAutoNotes ?? true;
    this.indexDependencies = opts.indexDependencies ?? false;
    this.lspSettings = opts.lsp ?? null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Performs a full build: walks all files, parses them, extracts
   * symbols/imports/callRefs, resolves imports, and persists everything to
   * the database.
   */
  async build(): Promise<void> {
    const db = openDb(this.dbPath);
    const branch = this.resolveBranch();
    const lspCoordinator = this.createLspEnrichmentCoordinator();
    try {
      this.saveDocsAutoNotesSetting(db);
      const files = await walkFiles(this.walkerConfig);
      const docs = await walkDocumentationFiles(this.walkerConfig);
      if (lspCoordinator) {
        const languages = new Set(files.map((file) => file.language));
        if (this.indexDependencies) languages.add('typescript');
        await lspCoordinator.start(languages);
      }
      const resumeAt = this.loadBuildCheckpoint(db, branch, files.length);
      db.transaction(() => {
        for (let i = resumeAt; i < files.length; i++) {
          const file = files[i];
          if (!file) continue;
          this.processFile(db, file.path, file.language, branch);
          this.saveBuildCheckpoint(db, branch, i + 1, files.length);
        }
        const seenDocPaths = new Set<string>();
        for (const doc of docs) {
          seenDocPaths.add(doc.path);
          this.processDocumentationFile(db, doc, branch);
          this.upsertSeededDocumentationNote(db, doc, branch);
        }
        this.removeStaleDocumentation(db, branch, seenDocPaths);
      })();
      this.saveBuildCheckpoint(db, branch, files.length, files.length);
      this.resolveImports(db, branch);
      await this.indexDependencyDeclarations(db, lspCoordinator);
      await this.enrichProjectSymbolsAndCallRefs(db, branch, files, lspCoordinator);
      refreshTestMappings(db, branch);
      buildCallGraph(db);
      this.saveLastKnownHead(db);
      if (this.embedder) {
        await this.embedder.init();
        await this.embedStructural(db);
        await this.embedDocumentation(db);
      }
      if (this.history) {
        const historyOptions =
          typeof this.history === 'object' ? this.history : undefined;
        await ingestGitHistory(db, this.walkerConfig.rootDir, historyOptions);
      }
    } finally {
      if (lspCoordinator) {
        await lspCoordinator.dispose();
      }
      db.close();
    }
  }

  /**
   * Incrementally re-processes only the listed files and updates the DB.
   * Symbols and imports for changed files are deleted then re-inserted.
   *
   * @param changedFiles  Absolute paths of files that have changed.
   */
  async update(changedFiles: string[]): Promise<void> {
    const db = openDb(this.dbPath);
    const branch = this.resolveBranch();
    const lspCoordinator = this.createLspEnrichmentCoordinator();
    const enrichedFiles: Array<{ path: string; language: string }> = [];
    try {
      this.saveDocsAutoNotesSetting(db);
      const docs = await walkDocumentationFiles(this.walkerConfig);
      const docsByPath = new Map(docs.map(doc => [doc.path, doc]));
      if (lspCoordinator) {
        const languages = new Set<string>();
        for (const filePath of changedFiles) {
          if (!fs.existsSync(filePath)) continue;
          const language = detectLanguageForPath(filePath, this.walkerConfig);
          if (language) languages.add(language);
        }
        if (this.indexDependencies) languages.add('typescript');
        await lspCoordinator.start(languages);
      }

      db.transaction(() => {
        for (const filePath of changedFiles) {
          // If the file no longer exists, remove it from the DB
          if (!fs.existsSync(filePath)) {
            const row = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
              | { id: number }
              | undefined;
            if (row) {
              // Null out any resolved_id references pointing to this file
              db.prepare('UPDATE file_imports SET resolved_id = NULL WHERE resolved_id = ?').run(row.id);
              db.prepare('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)').run(row.id);
              db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
            }
            this.deleteDocumentationByPath(db, filePath, branch);
            continue;
          }

          const language = detectLanguageForPath(filePath, this.walkerConfig);
          if (language) {
            enrichedFiles.push({ path: filePath, language });
            // Null out resolved_id references pointing to this file before deletion
            const existingRow = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
              | { id: number }
              | undefined;
            if (existingRow) {
              db.prepare('UPDATE file_imports SET resolved_id = NULL WHERE resolved_id = ?').run(existingRow.id);
              db.prepare('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
            }

            // Delete existing rows for this file (cascade handles symbols/imports)
            db.prepare('DELETE FROM files WHERE path = ? AND branch = ?').run(filePath, branch);

            this.processFile(db, filePath, language, branch);
          }

          const changedDoc = docsByPath.get(filePath);
          if (changedDoc) {
            this.processDocumentationFile(db, changedDoc, branch);
            this.upsertSeededDocumentationNote(db, changedDoc, branch);
          } else {
            this.deleteDocumentationByPath(db, filePath, branch);
          }
        }
      })();

      this.resolveImports(db, branch);
      await this.indexDependencyDeclarations(db, lspCoordinator);
      await this.enrichProjectSymbolsAndCallRefs(db, branch, enrichedFiles, lspCoordinator);
      refreshTestMappings(db, branch);
      if (this.history) {
        const historyOptions =
          typeof this.history === 'object' ? this.history : undefined;
        await ingestGitHistory(db, this.walkerConfig.rootDir, historyOptions);
      }
      if (this.embedder) {
        await this.embedder.init();
        await this.embedStructural(db);
        await this.embedDocumentation(db);
      }
      buildCallGraph(db);
      this.saveLastKnownHead(db);
    } finally {
      if (lspCoordinator) {
        await lspCoordinator.dispose();
      }
      db.close();
    }
  }

  /**
   * Writes an LLM-generated summary for a symbol to `symbol_summaries`.
   * If an `EmbeddingProvider` was configured, also embeds the summary text
   * and persists it to `symbol_semantic_embeddings`.
   *
   * @param symbolId  Row ID of the symbol in the `symbols` table.
   * @param summary   Natural-language summary text.
   * @param model     Name of the model that produced the summary.
   */
  async ingestSummary(symbolId: number, summary: string, model = 'unknown'): Promise<void> {
    const db = openDb(this.dbPath);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO symbol_summaries (symbol_id, summary, model)
         VALUES (?, ?, ?)`,
      ).run(symbolId, summary, model);

      if (this.embedder) {
        const [[embedding]] = await Promise.all([this.embedder.embed([summary])]);
        db.prepare(
          'INSERT OR REPLACE INTO symbol_semantic_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
        ).run(symbolId, JSON.stringify(embedding));
      }
    } finally {
      db.close();
    }
  }

  async ingestCoverage(reportPath: string, format: CoverageFormat, commitSha?: string): Promise<void> {
    const db = openDb(this.dbPath);
    try {
      const resolvedCommitSha = commitSha ?? this.readGitValue(['rev-parse', 'HEAD']) ?? 'HEAD';
      const sourceMtime = Math.floor(fs.statSync(reportPath).mtimeMs / 1000);
      ingestCoverageReport({
        db,
        rootDir: this.walkerConfig.rootDir,
        reportPath,
        format,
        commitSha: resolvedCommitSha,
        sourceMtime,
      });
      setLoreMeta(db, LORE_META_COVERAGE_LAST_SOURCE_PATH, reportPath);
      setLoreMeta(db, LORE_META_COVERAGE_LAST_SOURCE_MTIME, String(sourceMtime));
    } finally {
      db.close();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Parse one file, extract symbols/imports/callRefs, and insert into the DB. */
  private processFile(db: Database.Database, filePath: string, language: string, branch: string): void {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      return; // Skip unreadable files
    }

    const hash = crypto.createHash('sha256').update(source).digest('hex');

    // Check if the file is already up-to-date
    const existing = db.prepare('SELECT id, last_hash FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
      | FileRow
      | undefined;
    if (existing?.last_hash === hash) return;

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
        `DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)`,
      ).run(fileId);
      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
      db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(fileId);
      db.prepare('DELETE FROM external_deps WHERE file_id = ?').run(fileId);
      db.prepare('DELETE FROM api_routes WHERE file_id = ?').run(fileId);
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
    const tree = this.pool.parse(language, source);
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
      `INSERT INTO symbols_fts(rowid, name, signature, kind) VALUES (?, ?, ?, ?)`,
    );

    // Map from callerSymbol name → symbol row ID (for call refs)
    const symbolIdMap = new Map<string, number>();

    for (const sym of result.symbols) {
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

    // Insert raw imports (resolved_id will be filled in resolveImports())
    const insertImport = db.prepare(
      `INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)`,
    );
    for (const imp of result.imports) {
      insertImport.run(fileId, imp.source);
    }

    // Insert call refs (callee_id resolved in call-graph phase)
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line)
       VALUES (?, ?, ?)`,
    );
    for (const ref of result.callRefs) {
      const callerId = symbolIdMap.get(ref.callerSymbol);
      if (callerId !== undefined) {
        insertCallRef.run(callerId, ref.calleeRaw, ref.line);
      }
    }
  }

  private processDocumentationFile(
    db: Database.Database,
    doc: DocumentationFile,
    branch: string,
  ): void {
    const existing = db.prepare(
      'SELECT id, content_hash FROM docs WHERE path = ? AND branch = ?',
    ).get(doc.path, branch) as DocumentationRow | undefined;
    if (existing?.content_hash === doc.hash) {
      return;
    }

    let docId: number;
    if (existing) {
      db.prepare(
        `UPDATE docs
         SET kind = ?, title = ?, content = ?, content_hash = ?, indexed_at = unixepoch()
         WHERE id = ?`,
      ).run(doc.kind, doc.title, doc.content, doc.hash, existing.id);
      docId = existing.id;
    } else {
      const info = db.prepare(
        `INSERT INTO docs (path, branch, kind, title, content, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(doc.path, branch, doc.kind, doc.title, doc.content, doc.hash) as {
        lastInsertRowid: number | bigint;
      };
      docId = Number(info.lastInsertRowid);
    }

    const existingSections = db.prepare(
      'SELECT id, section_index FROM doc_sections WHERE doc_id = ?',
    ).all(docId) as Array<{ id: number; section_index: number }>;

    const insertSection = db.prepare(
      `INSERT INTO doc_sections (
         doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, section_index) DO UPDATE SET
         title = excluded.title,
         depth = excluded.depth,
         heading_path = excluded.heading_path,
         line_start = excluded.line_start,
         line_end = excluded.line_end,
         content = excluded.content,
         content_hash = excluded.content_hash`,
    );

    const activeSectionIndexes = new Set<number>();
    for (const chunk of doc.chunks) {
      activeSectionIndexes.add(chunk.sectionIndex);
      insertSection.run(
        docId,
        chunk.sectionIndex,
        chunk.title,
        chunk.depth,
        JSON.stringify(chunk.headingPath),
        chunk.lineStart,
        chunk.lineEnd,
        chunk.content,
        chunk.hash,
      );
    }

    const staleSectionIds = existingSections
      .filter(section => !activeSectionIndexes.has(section.section_index))
      .map(section => section.id);
    this.deleteDocSectionEmbeddings(db, staleSectionIds);
    if (staleSectionIds.length > 0) {
      db.prepare(
        `DELETE FROM doc_sections
         WHERE id IN (${staleSectionIds.map(() => '?').join(', ')})`,
      ).run(...staleSectionIds);
    }

  }

  private upsertSeededDocumentationNote(
    db: Database.Database,
    doc: DocumentationFile,
    branch: string,
  ): void {
    if (!this.docsAutoNotes) return;

    const key = inferSeededDocNoteKey(doc);
    if (!key) return;

    const scope = buildDocNoteScope(doc.path, branch);
    const existing = db.prepare(
      'SELECT content, source_hash FROM notes WHERE key = ? AND scope = ?',
    ).get(key, scope) as SeededNoteRow | undefined;

    if (existing?.content === doc.content && existing.source_hash === doc.hash) {
      return;
    }

    db.prepare(
      `INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(key, scope) DO UPDATE SET
         content = excluded.content,
         model = excluded.model,
         source_hash = excluded.source_hash,
         updated_at = unixepoch()`,
    ).run(key, scope, doc.content, 'system:auto-doc-seed', doc.hash);
  }

  private removeStaleDocumentation(db: Database.Database, branch: string, retainedPaths: Set<string>): void {
    const docs = db.prepare('SELECT id, path FROM docs WHERE branch = ?').all(branch) as Array<{ id: number; path: string }>;
    for (const doc of docs) {
      if (!retainedPaths.has(doc.path)) {
        this.deleteDocumentationById(db, doc.id);
      }
    }
  }

  private deleteDocumentationByPath(db: Database.Database, docPath: string, branch: string): void {
    const row = db.prepare(
      'SELECT id FROM docs WHERE path = ? AND branch = ?',
    ).get(docPath, branch) as { id: number } | undefined;
    if (!row) return;
    this.deleteDocumentationById(db, row.id);
  }

  private deleteDocumentationById(db: Database.Database, docId: number): void {
    const sectionIds = db.prepare('SELECT id FROM doc_sections WHERE doc_id = ?').all(docId) as Array<{ id: number }>;
    this.deleteDocSectionEmbeddings(db, sectionIds.map(row => row.id));
    db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
  }

  private deleteDocSectionEmbeddings(db: Database.Database, sectionIds: number[]): void {
    if (sectionIds.length === 0) return;
    const hasEmbeddingsTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'doc_section_embeddings'",
    ).get() as { present: number } | undefined;
    if (!hasEmbeddingsTable) return;
    db.prepare(
      `DELETE FROM doc_section_embeddings WHERE rowid IN (${sectionIds.map(() => '?').join(', ')})`,
    ).run(...sectionIds);
  }

  /**
   * Second pass: resolve raw_import strings to file IDs in the
   * `file_imports.resolved_id` column.  Also populates `external_deps` for
   * any import that resolves to an external package.
   */
  private resolveImports(db: Database.Database, branch: string): void {
    const rootDir = this.walkerConfig.rootDir;

    // Fetch all unresolved imports with their file's path, language, and file_id
    const rows = db
      .prepare(
        `SELECT fi.id, fi.file_id, fi.raw_import, f.path, f.language
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_id IS NULL AND f.branch = ?`,
      )
      .all(branch) as Array<{ id: number; file_id: number; raw_import: string; path: string; language: string }>;

    const updateResolved = db.prepare(
      'UPDATE file_imports SET resolved_id = ? WHERE id = ?',
    );
    const insertExternalDep = db.prepare(
      'INSERT OR IGNORE INTO external_deps (file_id, package) VALUES (?, ?)',
    );

    for (const row of rows) {
      const resolved = this.resolver.resolve(
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
  }

  private async indexDependencyDeclarations(
    db: Database.Database,
    lspCoordinator: LspEnrichmentCoordinator | null,
  ): Promise<void> {
    db.prepare('DELETE FROM external_symbols').run();
    if (!this.indexDependencies) return;

    const directDependencies = this.loadDirectDependencies();
    if (directDependencies.size === 0) return;
    const extractor = EXTRACTORS.typescript;
    if (!extractor) return;

    const insertExternalSymbol = db.prepare(
      `INSERT OR IGNORE INTO external_symbols
         (
           package_name,
           package_version,
           source_ref,
           symbol_name,
           symbol_kind,
           signature,
           doc_comment,
           resolved_type_signature,
           resolved_return_type,
           definition_uri,
           definition_path
         )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const [packageName, declaredVersion] of directDependencies) {
      const packageDir = path.join(this.walkerConfig.rootDir, 'node_modules', packageName);
      if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) continue;

      const packageVersion = this.readInstalledPackageVersion(packageDir) ?? declaredVersion ?? null;
      const declarationFiles = this.collectDeclarationFiles(packageDir);

      for (const declarationFile of declarationFiles) {
        const source = fs.readFileSync(declarationFile, 'utf8');
        const tree = this.pool.parse('typescript', source);
        if (!tree) continue;

        const result: ExtractionResult = extractor.extract(tree, source, declarationFile);
        const declarationSymbols = result.symbols.filter((symbol) => this.shouldIndexDependencySymbol(symbol));
        const enrichmentRows = lspCoordinator
          ? await lspCoordinator.enrich({
            filePath: declarationFile,
            language: 'typescript',
            source,
            targets: declarationSymbols.map((symbol) => ({
              line: symbol.startLine,
              character: symbol.startCharacter ?? 0,
            })),
          })
          : declarationSymbols.map(() => null);

        for (let i = 0; i < declarationSymbols.length; i++) {
          const symbol = declarationSymbols[i];
          if (!symbol) continue;
          const metadata = enrichmentRows[i];
          insertExternalSymbol.run(
            packageName,
            packageVersion,
            declarationFile,
            symbol.name,
            symbol.kind,
            symbol.signature,
            symbol.docComment ?? null,
            metadata?.resolvedTypeSignature ?? null,
            metadata?.resolvedReturnType ?? null,
            metadata?.definitionUri ?? null,
            metadata?.definitionPath ?? null,
          );
        }
      }
    }
  }

  private createLspEnrichmentCoordinator(): LspEnrichmentCoordinator | null {
    if (!this.lspSettings?.enabled) {
      return null;
    }
    return new LspEnrichmentCoordinator(this.lspSettings, this.walkerConfig.rootDir);
  }

  private async enrichProjectSymbolsAndCallRefs(
    db: Database.Database,
    branch: string,
    files: Array<{ path: string; language: string }>,
    lspCoordinator: LspEnrichmentCoordinator | null,
  ): Promise<void> {
    if (!lspCoordinator || files.length === 0) return;

    const selectSymbols = db.prepare(
      `SELECT s.id, s.name, s.signature, s.start_line
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path = ? AND f.branch = ?
       ORDER BY s.id`,
    );
    const selectCallRefs = db.prepare(
      `SELECT sr.id, sr.call_line
       FROM symbol_refs sr
       JOIN symbols s ON s.id = sr.caller_id
       JOIN files f ON f.id = s.file_id
       WHERE f.path = ? AND f.branch = ?
       ORDER BY sr.id`,
    );
    const updateSymbol = db.prepare(
      `UPDATE symbols
       SET resolved_type_signature = ?, resolved_return_type = ?, definition_uri = ?, definition_path = ?
       WHERE id = ?`,
    );
    const updateSymbolFts = db.prepare(
      'UPDATE symbols_fts SET signature = ? WHERE rowid = ?',
    );
    const updateCallRef = db.prepare(
      `UPDATE symbol_refs
       SET resolved_type_signature = ?, resolved_return_type = ?, definition_uri = ?, definition_path = ?
       WHERE id = ?`,
    );

    for (const file of files) {
      if (!file || !fs.existsSync(file.path)) continue;
      let source: string;
      try {
        source = fs.readFileSync(file.path, 'utf8');
      } catch {
        continue;
      }

      const symbols = selectSymbols.all(file.path, branch) as Array<{
        id: number;
        name: string;
        signature: string | null;
        start_line: number;
      }>;
      if (symbols.length > 0) {
        const symbolMetadata = await lspCoordinator.enrich({
          filePath: file.path,
          language: file.language,
          source,
          targets: symbols.map((symbol) => ({ line: symbol.start_line, character: 0 })),
        });
        for (let i = 0; i < symbols.length; i++) {
          const symbol = symbols[i];
          if (!symbol) continue;
          const metadata = symbolMetadata[i];
          if (!metadata) continue;
          updateSymbol.run(
            metadata.resolvedTypeSignature,
            metadata.resolvedReturnType,
            metadata.definitionUri,
            metadata.definitionPath,
            symbol.id,
          );
          updateSymbolFts.run(
            buildStructuralEmbeddingText({
              name: symbol.name,
              signature: symbol.signature,
              resolvedTypeSignature: metadata.resolvedTypeSignature,
              resolvedReturnType: metadata.resolvedReturnType,
            }),
            symbol.id,
          );
        }
      }

      const callRefs = selectCallRefs.all(file.path, branch) as Array<{
        id: number;
        call_line: number;
      }>;
      if (callRefs.length > 0) {
        const callRefMetadata = await lspCoordinator.enrich({
          filePath: file.path,
          language: file.language,
          source,
          targets: callRefs.map((callRef) => ({ line: callRef.call_line, character: 0 })),
        });
        for (let i = 0; i < callRefs.length; i++) {
          const callRef = callRefs[i];
          if (!callRef) continue;
          const metadata = callRefMetadata[i];
          if (!metadata) continue;
          updateCallRef.run(
            metadata.resolvedTypeSignature,
            metadata.resolvedReturnType,
            metadata.definitionUri,
            metadata.definitionPath,
            callRef.id,
          );
        }
      }
    }
  }

  private resolveBranch(): string {
    if (this.walkerConfig.branch) return this.walkerConfig.branch;
    return this.readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
  }

  private saveLastKnownHead(db: Database.Database): void {
    const headSha = this.readGitValue(['rev-parse', 'HEAD']);
    if (headSha) {
      setLoreMeta(db, LORE_META_LAST_HEAD_SHA, headSha);
    }
  }

  private saveDocsAutoNotesSetting(db: Database.Database): void {
    setLoreMeta(db, 'docs_auto_notes', this.docsAutoNotes ? '1' : '0');
  }

  private readGitValue(args: string[]): string | undefined {
    try {
      const value = execFileSync(
        'git',
        ['-C', this.walkerConfig.rootDir, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private loadDirectDependencies(): Map<string, string | undefined> {
    const packageJsonPath = path.join(this.walkerConfig.rootDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return new Map();

    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const deps = new Map<string, string | undefined>();
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (!section) continue;
      for (const [name, version] of Object.entries(section)) {
        if (!deps.has(name)) deps.set(name, version);
      }
    }
    return deps;
  }

  private readInstalledPackageVersion(packageDir: string): string | undefined {
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return undefined;

    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version;
  }

  private collectDeclarationFiles(packageDir: string): string[] {
    const declarations: string[] = [];
    const stack: string[] = [packageDir];

    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) continue;

      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (entry.isFile() && fullPath.endsWith('.d.ts')) {
          declarations.push(fullPath);
        }
      }
    }

    return declarations;
  }

  private shouldIndexDependencySymbol(symbol: RawSymbol): boolean {
    if (!isPublicDeclarationSurfaceSymbol(symbol)) return false;
    if (symbol.declarationSurface) return true;
    return !this.hasImplementationBody(symbol);
  }

  private hasImplementationBody(symbol: RawSymbol): boolean {
    const node = symbol.astNode;
    if (!node) return false;

    if (
      node.type === 'arrow_function' ||
      node.type === 'function_expression' ||
      node.type === 'generator_function'
    ) {
      return true;
    }

    if (
      node.type === 'class_declaration' ||
      node.type === 'interface_declaration' ||
      node.type === 'type_alias_declaration'
    ) {
      return false;
    }

    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) return false;
    return bodyNode.namedChildCount > 0 || bodyNode.text.trim() !== '';
  }

  private loadBuildCheckpoint(db: Database.Database, branch: string, totalFiles: number): number {
    const raw = getLoreMeta(db, LORE_META_INDEX_CHECKPOINT);
    if (!raw) return 0;
    try {
      const parsed = JSON.parse(raw) as Partial<BuildCheckpoint>;
      if (parsed.branch !== branch || parsed.rootDir !== this.walkerConfig.rootDir) return 0;
      const nextFileIndex = parsed.nextFileIndex ?? 0;
      return Math.max(0, Math.min(totalFiles, nextFileIndex));
    } catch {
      return 0;
    }
  }

  private saveBuildCheckpoint(db: Database.Database, branch: string, nextFileIndex: number, totalFiles: number): void {
    const checkpoint: BuildCheckpoint = {
      branch,
      rootDir: this.walkerConfig.rootDir,
      totalFiles,
      nextFileIndex,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, JSON.stringify(checkpoint));
  }

  /**
   * Embed structural symbol signatures in batches and persist results to
   * the `symbol_embeddings` vec0 virtual table.
   *
   * Also stores the embedding model name and dims in `lore_meta` and
   * creates the vec0 tables if they don't exist yet.
   */
  private async embedStructural(db: Database.Database): Promise<void> {
    const embedder = this.embedder!;

    setLoreMeta(db, 'embedding_model', embedder.modelName);
    setLoreMeta(db, 'embedding_dims', String(embedder.dims));
    createVec0Tables(db, embedder.dims);

    // Fetch all symbols that have structural text to embed.
    const symbols = db
      .prepare(
        `SELECT id, name, signature, resolved_type_signature, resolved_return_type
         FROM symbols
         WHERE signature IS NOT NULL
            OR resolved_type_signature IS NOT NULL
            OR resolved_return_type IS NOT NULL`,
      )
      .all() as Array<{
        id: number;
        name: string;
        signature: string | null;
        resolved_type_signature: string | null;
        resolved_return_type: string | null;
      }>;

    const insertEmbed = db.prepare(
      'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
    );

    for (let i = 0; i < symbols.length; i += EMBED_BATCH_SIZE) {
      const batch = symbols.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((symbol) =>
        buildStructuralEmbeddingText({
          name: symbol.name,
          signature: symbol.signature,
          resolvedTypeSignature: symbol.resolved_type_signature,
          resolvedReturnType: symbol.resolved_return_type,
        }),
      );
      const embeddings = await embedder.embed(texts);

      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const sym = batch[j];
          if (sym) insertEmbed.run(sym.id, JSON.stringify(embeddings[j]));
        }
      })();
    }
  }

  private async embedDocumentation(db: Database.Database): Promise<void> {
    const embedder = this.embedder!;

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_section_embeddings USING vec0(
        embedding FLOAT[${embedder.dims}]
      );
    `);

    const sections = db.prepare(
      `SELECT id, title, content
       FROM doc_sections
       ORDER BY id`,
    ).all() as Array<{ id: number; title: string; content: string }>;
    if (sections.length === 0) return;

    const insertEmbed = db.prepare(
      'INSERT OR REPLACE INTO doc_section_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
    );

    for (let i = 0; i < sections.length; i += EMBED_BATCH_SIZE) {
      const batch = sections.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(section => section.content || section.title);
      const embeddings = await embedder.embed(texts);

      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const section = batch[j];
          if (section) {
            insertEmbed.run(section.id, JSON.stringify(embeddings[j]));
          }
        }
      })();
    }
  }
}
