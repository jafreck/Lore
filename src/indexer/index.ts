/**
 * @module indexer/index
 *
 * The `IndexBuilder` class is a **façade** over the composable
 * `IndexPipeline` and its stage objects.
 *
 * For full builds, `build()` delegates entirely to the pipeline which
 * enforces the data-dependency chain:
 * ```
 * SourceIndexStage → DocsIndexStage → ImportResolutionStage
 *   → DependencyApiStage → LspEnrichmentStage → ResolutionStage
 *   → TestMapStage → HistoryStage → EmbeddingStage
 * ```
 *
 * For incremental updates, `update()` uses stage-extracted helpers
 * while managing the changed-file diff itself.
 *
 * The enrichment → resolution ordering is **load-bearing** and enforced
 * structurally by the pipeline rather than by call-site discipline.
 */

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  openDb,
  setLoreMeta,
  createVec0Tables,
  LORE_META_LAST_HEAD_SHA,
  LORE_META_COVERAGE_LAST_SOURCE_PATH,
  LORE_META_COVERAGE_LAST_SOURCE_MTIME,
} from './db.js';
import type { Database } from './db.js';
import { detectLanguageForPath, walkDocumentationFiles } from './walker.js';
import type { WalkerConfig } from './walker.js';
import { resolveSymbolEdges } from './call-graph.js';
import { enrichProjectRefs } from './stages/lsp-enrichment.js';
import { processFile } from './stages/source-index.js';
import { processDocumentationFile, upsertSeededDocumentationNote } from './stages/docs-index.js';
import type { EmbeddingProvider } from './embedder.js';
import { DEFAULT_EMBEDDING_MODEL, buildStructuralEmbeddingText } from './embedder.js';
import { ingestCoverageReport, type CoverageFormat } from './coverage.js';
import { refreshTestMappings } from './test-mapper.js';
import { ingestGitHistory } from './git-history.js';
import type { EffectiveLspSettings } from './lsp/config.js';
import { LspEnrichmentCoordinator } from './lsp/enrichment.js';
import { getLogger } from '../logger.js';
import { IndexPipeline } from './pipeline.js';
import type { PipelineContext } from './pipeline.js';
import { ParserPool } from './parser.js';
import { ImportResolver } from './resolver.js';
import {
  SourceIndexStage,
  DocsIndexStage,
  ImportResolutionStage,
  DependencyApiStage,
  LspEnrichmentStage,
  ResolutionStage,
  TestMapStage,
  HistoryStage,
  EmbeddingStage,
} from './stages/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IndexBuilderOptions {
  history?: boolean | { depth?: number; all?: boolean };
  embeddingModel?: string;
  docsAutoNotes?: boolean;
  indexDependencies?: boolean;
  lsp?: EffectiveLspSettings;
}

/** Number of symbols to embed per batch. */
const EMBED_BATCH_SIZE = 64;

// ─── IndexBuilder (façade) ────────────────────────────────────────────────────

/**
 * Façade over the composable `IndexPipeline`.
 *
 * Preserves backward-compatible public API while internally delegating to
 * pipeline stages for the actual work.
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
   * Performs a full build by running the composable pipeline.
   *
   * The pipeline enforces the enrichment → resolution data-dependency
   * chain structurally (by stage ordering), not by convention.
   */
  async build(): Promise<void> {
    const log = getLogger();
    const buildStart = performance.now();
    const db = openDb(this.dbPath);
    const branch = this.resolveBranch();

    log.indexing('build started', { dbPath: this.dbPath, branch, rootDir: this.walkerConfig.rootDir });

    // Build the pipeline with all stages in dependency order.
    const pipeline = new IndexPipeline([
      new SourceIndexStage(),
      new DocsIndexStage(),
      new ImportResolutionStage(),
      new DependencyApiStage(),
      new LspEnrichmentStage(),
      new ResolutionStage(),
      new TestMapStage(),
      new HistoryStage(),
      new EmbeddingStage(),
    ]);

    const context: PipelineContext = {
      db,
      dbPath: this.dbPath,
      walkerConfig: this.walkerConfig,
      branch,
      lsp: this.lspSettings,
      embedder: this.embedder,
      log,
      files: [],
      indexDependencies: this.indexDependencies,
      history: this.history,
      docsAutoNotes: this.docsAutoNotes,
    };

    try {
      await pipeline.run(context, 'build');
      this.saveLastKnownHead(db);

      // Gather final DB stats for the build summary
      const stats = this.gatherDbStats(db);
      const indexDurationMs = Math.round(performance.now() - buildStart);
      log.startup('indexing complete', {
        dbPath: this.dbPath,
        dbSizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : undefined,
        embeddingModel: this.embeddingModel,
        embeddingReady: !!this.embedder,
        totalFiles: context.files.length,
        ...stats,
        indexDurationMs,
      });
    } finally {
      db.close();
    }
  }

  /**
   * Incrementally re-processes only the listed files and updates the DB.
   * Symbols and imports for changed files are deleted then re-inserted.
   *
   * Uses stage-extracted helpers for file processing while managing the
   * changed-file diff logic here.
   *
   * @param changedFiles  Absolute paths of files that have changed.
   */
  async update(changedFiles: string[]): Promise<void> {
    const db = openDb(this.dbPath);
    const branch = this.resolveBranch();
    const lspCoordinator = this.createLspEnrichmentCoordinator();
    const enrichedFiles: Array<{ path: string; language: string }> = [];
    const staleSymbolIds: number[] = [];
    const changedSourcePaths: string[] = [];
    const changedDocPaths: string[] = [];

    try {
      setLoreMeta(db, 'docs_auto_notes', this.docsAutoNotes ? '1' : '0');
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
          if (!fs.existsSync(filePath)) {
            const row = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
              | { id: number }
              | undefined;
            if (row) {
              const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(row.id) as Array<{ id: number }>;
              for (const s of symRows) staleSymbolIds.push(s.id);
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
            changedSourcePaths.push(filePath);
            const existingRow = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
              | { id: number }
              | undefined;
            if (existingRow) {
              const symRows = db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(existingRow.id) as Array<{ id: number }>;
              for (const s of symRows) staleSymbolIds.push(s.id);
              db.prepare('UPDATE file_imports SET resolved_id = NULL WHERE resolved_id = ?').run(existingRow.id);
              db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
              db.prepare('UPDATE type_refs SET type_id = NULL WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
              db.prepare('UPDATE symbol_relationships SET target_symbol_id = NULL WHERE target_symbol_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
              db.prepare('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)').run(existingRow.id);
            }

            db.prepare('DELETE FROM files WHERE path = ? AND branch = ?').run(filePath, branch);
            processFile(db, this.pool, filePath, language, branch);
          }

          const changedDoc = docsByPath.get(filePath);
          if (changedDoc) {
            processDocumentationFile(db, changedDoc, branch);
            if (this.docsAutoNotes) upsertSeededDocumentationNote(db, changedDoc, branch);
            changedDocPaths.push(filePath);
          } else {
            this.deleteDocumentationByPath(db, filePath, branch);
          }
        }
      })();

      this.resolveImports(db, branch);

      if (lspCoordinator) {
        await enrichProjectRefs(db, branch, enrichedFiles, lspCoordinator);
      }

      refreshTestMappings(db, branch);

      if (this.history) {
        const historyOptions =
          typeof this.history === 'object' ? this.history : undefined;
        await ingestGitHistory(db, this.walkerConfig.rootDir, historyOptions);
      }

      if (this.embedder) {
        await this.embedder.init();
        this.deleteSymbolEmbeddings(db, staleSymbolIds);

        const changedFileIds: number[] = [];
        for (const p of changedSourcePaths) {
          const row = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(p, branch) as
            | { id: number }
            | undefined;
          if (row) changedFileIds.push(row.id);
        }

        const changedDocIds: number[] = [];
        for (const p of changedDocPaths) {
          const row = db.prepare('SELECT id FROM docs WHERE path = ? AND branch = ?').get(p, branch) as
            | { id: number }
            | undefined;
          if (row) changedDocIds.push(row.id);
        }

        await this.embedStructural(db, changedFileIds);
        await this.embedDocumentation(db, changedDocIds);
        if (this.history) {
          await this.embedCommitMessages(db);
        }
      }

      // Resolution runs AFTER enrichment — ordering enforced here.
      resolveSymbolEdges(db);
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

  // ─── Private helpers (minimal — most logic lives in stages) ─────────────

  private createLspEnrichmentCoordinator(): LspEnrichmentCoordinator | null {
    if (!this.lspSettings?.enabled) return null;
    return new LspEnrichmentCoordinator(this.lspSettings, this.walkerConfig.rootDir);
  }

  private resolveBranch(): string {
    if (this.walkerConfig.branch) return this.walkerConfig.branch;
    return this.readGitValue(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'HEAD';
  }

  private saveLastKnownHead(db: Database.Database): void {
    const headSha = this.readGitValue(['rev-parse', 'HEAD']);
    if (headSha) setLoreMeta(db, LORE_META_LAST_HEAD_SHA, headSha);
  }

  private readGitValue(args: string[]): string | undefined {
    try {
      return execFileSync(
        'git',
        ['-C', this.walkerConfig.rootDir, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private resolveImports(db: Database.Database, branch: string): void {
    const rootDir = this.walkerConfig.rootDir;
    const rows = db
      .prepare(
        `SELECT fi.id, fi.file_id, fi.raw_import, f.path, f.language
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_id IS NULL AND f.branch = ?`,
      )
      .all(branch) as Array<{ id: number; file_id: number; raw_import: string; path: string; language: string }>;

    const updateResolved = db.prepare('UPDATE file_imports SET resolved_id = ? WHERE id = ?');
    const insertExternalDep = db.prepare('INSERT OR IGNORE INTO external_deps (file_id, package) VALUES (?, ?)');

    for (const row of rows) {
      const resolved = this.resolver.resolve(
        { source: row.raw_import, importedNames: [] },
        row.path,
        rootDir,
        row.language,
      );
      if (resolved.resolvedPath) {
        const targetFile = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?')
          .get(resolved.resolvedPath, branch) as { id: number } | undefined;
        if (targetFile) updateResolved.run(targetFile.id, row.id);
      } else if (resolved.isExternal && resolved.externalName) {
        insertExternalDep.run(row.file_id, resolved.externalName);
      }
    }
  }

  private deleteDocumentationByPath(db: Database.Database, docPath: string, branch: string): void {
    const row = db.prepare('SELECT id FROM docs WHERE path = ? AND branch = ?')
      .get(docPath, branch) as { id: number } | undefined;
    if (!row) return;
    const sectionIds = db.prepare('SELECT id FROM doc_sections WHERE doc_id = ?')
      .all(row.id) as Array<{ id: number }>;
    this.deleteDocSectionEmbeddings(db, sectionIds.map(r => r.id));
    db.prepare('DELETE FROM docs WHERE id = ?').run(row.id);
  }

  private deleteDocSectionEmbeddings(db: Database.Database, sectionIds: number[]): void {
    if (sectionIds.length === 0) return;
    const hasTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'doc_section_embeddings'",
    ).get() as { present: number } | undefined;
    if (!hasTable) return;
    db.prepare(
      `DELETE FROM doc_section_embeddings WHERE rowid IN (${sectionIds.map(() => '?').join(', ')})`,
    ).run(...sectionIds);
  }

  private deleteSymbolEmbeddings(db: Database.Database, symbolIds: number[]): void {
    if (symbolIds.length === 0) return;
    const hasTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'symbol_embeddings'",
    ).get() as { present: number } | undefined;
    if (!hasTable) return;
    db.prepare(
      `DELETE FROM symbol_embeddings WHERE rowid IN (${symbolIds.map(() => '?').join(', ')})`,
    ).run(...symbolIds);
  }

  private async embedStructural(db: Database.Database, fileIds?: number[]): Promise<void> {
    const embedder = this.embedder!;
    setLoreMeta(db, 'embedding_model', embedder.modelName);
    setLoreMeta(db, 'embedding_dims', String(embedder.dims));
    createVec0Tables(db, embedder.dims);

    const baseQuery =
      `SELECT id, name, signature, resolved_type_signature, resolved_return_type
       FROM symbols
       WHERE (signature IS NOT NULL
          OR resolved_type_signature IS NOT NULL
          OR resolved_return_type IS NOT NULL)`;

    let symbols: Array<{
      id: number; name: string; signature: string | null;
      resolved_type_signature: string | null; resolved_return_type: string | null;
    }>;
    if (fileIds && fileIds.length > 0) {
      symbols = db.prepare(`${baseQuery} AND file_id IN (${fileIds.map(() => '?').join(', ')})`)
        .all(...fileIds) as typeof symbols;
    } else {
      symbols = db.prepare(baseQuery).all() as typeof symbols;
    }

    const insertEmbed = db.prepare(
      'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
    );
    for (let i = 0; i < symbols.length; i += EMBED_BATCH_SIZE) {
      const batch = symbols.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(s => buildStructuralEmbeddingText({
        name: s.name, signature: s.signature,
        resolvedTypeSignature: s.resolved_type_signature,
        resolvedReturnType: s.resolved_return_type,
      }));
      const embeddings = await embedder.embed(texts);
      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const sym = batch[j];
          if (sym) insertEmbed.run(sym.id, JSON.stringify(embeddings[j]));
        }
      })();
    }
  }

  private async embedDocumentation(db: Database.Database, docIds?: number[]): Promise<void> {
    const embedder = this.embedder!;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS doc_section_embeddings USING vec0(embedding FLOAT[${embedder.dims}]);`);

    let sections: Array<{ id: number; title: string; content: string }>;
    if (docIds && docIds.length > 0) {
      sections = db.prepare(
        `SELECT id, title, content FROM doc_sections WHERE doc_id IN (${docIds.map(() => '?').join(', ')}) ORDER BY id`,
      ).all(...docIds) as typeof sections;
    } else {
      sections = db.prepare('SELECT id, title, content FROM doc_sections ORDER BY id').all() as typeof sections;
    }
    if (sections.length === 0) return;

    const insertEmbed = db.prepare(
      'INSERT OR REPLACE INTO doc_section_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
    );
    for (let i = 0; i < sections.length; i += EMBED_BATCH_SIZE) {
      const batch = sections.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(s => s.content || s.title);
      const embeddings = await embedder.embed(texts);
      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const section = batch[j];
          if (section) insertEmbed.run(section.id, JSON.stringify(embeddings[j]));
        }
      })();
    }
  }

  private async embedCommitMessages(db: Database.Database): Promise<void> {
    const embedder = this.embedder!;
    const commits = db.prepare(
      `SELECT c.rowid, c.message FROM commits c
       LEFT JOIN commit_embeddings ce ON ce.rowid = c.rowid
       WHERE length(trim(c.message)) > 0 AND ce.rowid IS NULL ORDER BY c.rowid`,
    ).all() as Array<{ rowid: number; message: string }>;
    if (commits.length === 0) return;

    const insertEmbed = db.prepare(
      'INSERT OR REPLACE INTO commit_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
    );
    for (let i = 0; i < commits.length; i += EMBED_BATCH_SIZE) {
      const batch = commits.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await embedder.embed(batch.map(c => c.message));
      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const commit = batch[j];
          if (commit) insertEmbed.run(commit.rowid, JSON.stringify(embeddings[j]));
        }
      })();
    }
  }

  private gatherDbStats(db: Database.Database): Record<string, unknown> {
    let totalSymbols = 0;
    try { totalSymbols = (db.prepare('SELECT COUNT(*) AS cnt FROM symbols').get() as { cnt: number }).cnt; } catch { /* */ }
    let totalEdges = 0;
    try { totalEdges = (db.prepare('SELECT COUNT(*) AS cnt FROM symbol_refs').get() as { cnt: number }).cnt; } catch { /* */ }
    let totalDocs = 0;
    try { totalDocs = (db.prepare('SELECT COUNT(*) AS cnt FROM docs').get() as { cnt: number }).cnt; } catch { /* */ }
    let commitCount: number | undefined;
    try { commitCount = (db.prepare('SELECT COUNT(*) AS cnt FROM commits').get() as { cnt: number }).cnt; } catch { /* */ }
    return { totalSymbols, totalEdges, totalDocs, commitCount };
  }
}
