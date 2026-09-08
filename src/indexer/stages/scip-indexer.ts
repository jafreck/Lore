/**
 * @module indexer/stages/scip-indexer
 *
 * Pipeline stage: for SCIP-covered languages, populate `files`, `symbols`,
 * `symbol_refs`, `type_refs`, `symbol_relationships`, and `file_imports`
 * **directly from the SCIP index** in a single pass.
 *
 * This is the single-pass SCIP architecture.  SCIP is the source of truth
 * for the symbol table, the call graph, **and** enrichment metadata (type
 * signatures, definition locations).  All data is written in one pass.
 *
 * For each SCIP document:
 *
 * 1. **Symbols**: Definition occurrences → `symbols` rows; kinds inferred
 *    from SCIP descriptor suffixes; spans from `enclosing_range`.
 *    Enrichment columns (`resolved_type_signature`, `resolved_return_type`,
 *    `definition_uri`, `definition_path`) are populated inline.
 * 2. **Refs**: Non-definition, non-local reference occurrences →
 *    `symbol_refs` rows with both `caller_id` and `callee_id` resolved
 *    using containment (which symbol's span encloses this ref?) and
 *    definition lookup (where is the referenced SCIP symbol defined?).
 *    Enrichment columns are populated inline from the same SCIP data.
 *
 * 3. **Virtual dispatch**: Override edges materialised from SCIP
 *    `isImplementation` relationships.
 *
 * Resolved SCIP refs are inserted with `resolution_method =
 * 'scip_definition'`. The downstream enrichment/resolution stages can still
 * process references that SCIP ingestion leaves unresolved.
 *
 * ## Data written
 *
 * `files`, `symbols`, `symbol_refs`, `type_refs`,
 * `symbol_relationships`, `file_imports`.  Enrichment columns (type
 * signatures, definition locations) are populated inline. FTS is synchronized
 * by the later `FtsRefreshStage`.
 *
 * ## Pipeline ordering
 *
 * This stage runs **before** `FileDiscoveryStage`.  It stores which
 * languages and files it handled in `context.scipSourcedLanguages`,
 * `context.scipSourcedFiles`, and `context.scipCoveredLanguages` so
 * `FileDiscoveryStage` can skip those files and `LspEnrichmentStage`
 * knows not to re-enrich these languages.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  PositionEncoding,
  SymbolRole,
  type Index as ScipIndex,
  type Document as ScipDocument,
  type SymbolInformation as ScipSymbolInformation,
} from '../../scip/scip_pb.js';
import {
  deletePipelineLoreMeta,
  setPipelineLoreMeta,
  throwIfPipelineCancelled,
  type PipelineContext,
  type PipelineStage,
} from '../pipeline.js';
import { normalizeTypeName } from '../../resolution/call-graph.js';
import { SCIP_SUPPORTED_LANGUAGES } from '../../scip/registry.js';
import { extractReturnType } from '../../scip/index-reader.js';
import {
  buildCFamilyLanguageEvidence,
  detectLanguageForPath,
  type CFamilyLanguageEvidence,
  walkFiles,
} from '../../discovery/walker.js';

// ─── Re-exports from helper modules ──────────────────────────────────────────

import {
  inferKindFromScipSymbol,
  extractParentScipSymbol,
  descriptorDepth,
  extractNameFromScipSymbol,
  extractSignatureFromDoc,
  classifyScipReference,
  extractParentTypeSymbol,
  extractMethodDescriptor,
} from './scip-helpers/symbol-kinds.js';

import {
  createLoreScipTsconfig,
  loadScipIndexes,
  type ScipIndexLoadDiagnostics,
} from './scip-helpers/process.js';

import {
  inferLoreLanguage,
  materializeVirtualDispatch,
} from './scip-helpers/ingest.js';
import { CSourceSpanResolver } from './scip-helpers/source-spans.js';
import { normalizeScipDocumentPositions } from '../../scip/source-position.js';
import {
  mergeScipDocuments,
  mergeScipDocumentsDetailed,
  type ScipDocumentMergeStats,
} from './scip-helpers/documents.js';
import {
  LORE_META_SCIP_C_CPP_REPRODUCIBILITY,
  recordIndexerRun,
} from '../../db/schema.js';

interface PositionConversionDiagnostics {
  documents: number;
  assumedUtf8ForUnspecifiedCFamily: number;
  conversionRequired: number;
  converted: number;
  skippedMissingSource: number;
  sourceEncodings: Record<string, number>;
}

function emptyPositionConversionDiagnostics(): PositionConversionDiagnostics {
  return {
    documents: 0,
    assumedUtf8ForUnspecifiedCFamily: 0,
    conversionRequired: 0,
    converted: 0,
    skippedMissingSource: 0,
    sourceEncodings: {},
  };
}

function positionEncodingName(encoding: PositionEncoding): string {
  switch (encoding) {
    case PositionEncoding.UTF8CodeUnitOffsetFromLineStart: return 'utf8';
    case PositionEncoding.UTF16CodeUnitOffsetFromLineStart: return 'utf16';
    case PositionEncoding.UTF32CodeUnitOffsetFromLineStart: return 'utf32';
    default: return 'unspecified';
  }
}

// Re-export createLoreScipTsconfig for tests
export { createLoreScipTsconfig };
export { mergeScipDocuments, mergeScipDocumentsDetailed };

function recordCppReproducibilityMetadata(
  context: PipelineContext,
  diagnostics: ScipIndexLoadDiagnostics,
  parsedIndexes: readonly ScipIndex[],
  mergedDocuments: readonly ScipDocument[] = [],
  mergeStats?: ScipDocumentMergeStats,
  cFamilyEvidence?: CFamilyLanguageEvidence,
  positionConversion?: PositionConversionDiagnostics,
): void {
  const cCpp = diagnostics.cCpp;
  if (!cCpp) return;
  const database = cCpp.compilationDatabase.database;
  if (!database) {
    deletePipelineLoreMeta(context, LORE_META_SCIP_C_CPP_REPRODUCIBILITY);
    return;
  }

  const rootDir = resolve(context.walkerConfig.rootDir);
  const relativePath = relative(rootDir, database.path);
  const portableCompdbPath = relativePath && !isAbsolute(relativePath)
    && relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
    ? relativePath.split(sep).join('/')
    : basename(database.path);

  const cCppIndexes = parsedIndexes.filter(index => index.documents.some(document => {
    const language = inferLoreLanguage(document.language, document.relativePath, cFamilyEvidence);
    return language === 'c' || language === 'cpp';
  }));
  const cCppDocuments = mergedDocuments.filter(document => {
    const language = inferLoreLanguage(document.language, document.relativePath, cFamilyEvidence);
    return language === 'c' || language === 'cpp';
  });
  const toolInfo = cCppIndexes
    .map(index => index.metadata?.toolInfo)
    .find(info => info && (info.name.length > 0 || info.version.length > 0));
  const portableCommand = cCpp.indexerCommand.split(/[\\/]/u).pop() || cCpp.indexerCommand;
  const portableToolName = (toolInfo?.name || portableCommand).split(/[\\/]/u).pop()
    || portableCommand;
  const validation = database.validation;

  const metadata = {
    schemaVersion: 1,
    compilationDatabase: {
      path: portableCompdbPath,
      sha256: database.sha256,
      buildSystem: cCpp.compilationDatabase.buildSystem ?? 'unknown',
      preExisting: cCpp.compilationDatabase.preExisting ?? null,
      status: validation.status,
      warningCount: validation.warnings.length,
    },
    indexer: {
      name: portableToolName,
      ...(toolInfo?.version ? { version: toolInfo.version } : {}),
      command: portableCommand,
    },
    coverage: {
      compilationEntries: validation.totalEntries,
      usableCompilationEntries: validation.wellFormedEntries,
      viableCompilationEntries: validation.viableEntries,
      malformedCompilationEntries: validation.malformedEntries,
      sourceFilesPresent: validation.existingFiles,
      sourceFilesMissing: validation.missingFiles,
      workingDirectoriesPresent: validation.existingDirectories,
      workingDirectoriesMissing: validation.missingDirectories,
      indexedDocuments: cCppDocuments.length,
      indexedFiles: new Set(cCppDocuments.map(document => document.relativePath)).size,
    },
    documentMerge: {
      semantics: mergeStats?.semantics ?? 'none',
      duplicateDocuments: mergeStats?.duplicateDocuments ?? 0,
      mergedFiles: mergeStats?.mergedFiles ?? 0,
      provenance: mergeStats?.mergedFiles ? 'index-metadata-and-document-order' : 'not-applicable',
    },
    positionConversion: positionConversion ?? emptyPositionConversionDiagnostics(),
  };

  setPipelineLoreMeta(context, LORE_META_SCIP_C_CPP_REPRODUCIBILITY, JSON.stringify(metadata));
}

function recordScipRunProvenance(
  context: PipelineContext,
  diagnostics: ScipIndexLoadDiagnostics,
  parsedIndexes: readonly ScipIndex[],
  positionConversion: PositionConversionDiagnostics = emptyPositionConversionDiagnostics(),
): void {
  if (!context.runId) return;

  for (const diagnostic of diagnostics.indexers ?? []) {
    const index = diagnostic.bufferIndex === undefined
      ? undefined
      : parsedIndexes[diagnostic.bufferIndex];
    const inferredLanguages = index
      ? [...new Set(index.documents.map((document) =>
          inferLoreLanguage(document.language, document.relativePath)).filter((language): language is string => Boolean(language)))]
      : [];
    const toolInfo = index?.metadata?.toolInfo;
    recordIndexerRun(context.db, {
      runId: context.runId,
      provider: 'scip',
      indexer: toolInfo?.name || diagnostic.indexer,
      languages: inferredLanguages.length > 0 ? inferredLanguages : diagnostic.languages,
      status: diagnostic.status === 'succeeded'
        && (index?.documents.length === 0 || positionConversion.skippedMissingSource > 0)
        ? 'degraded'
        : diagnostic.status,
      attempted: diagnostic.attempted,
      files: index?.documents.length,
      symbols: index?.documents.reduce((total, document) => total + document.symbols.length, 0),
      startedAt: diagnostic.startedAt,
      completedAt: diagnostic.completedAt,
      message: diagnostic.message,
      details: {
        source: diagnostic.source,
        outputPath: diagnostic.outputPath,
        outputBytes: diagnostic.outputBytes,
        outputSha256: diagnostic.outputSha256,
        commandArguments: diagnostic.arguments ?? [],
        toolVersion: toolInfo?.version || null,
        toolArguments: toolInfo?.arguments ?? [],
        positionConversion,
      },
    });
  }

  const cCpp = diagnostics.cCpp;
  if (cCpp) {
    const result = cCpp.compilationDatabase;
    const validation = result.database?.validation;
    recordIndexerRun(context.db, {
      runId: context.runId,
      provider: 'compdb',
      indexer: result.buildSystem ?? 'compile_commands',
      languages: ['c', 'cpp'],
      status: !result.path
        ? 'failed'
        : validation?.status === 'valid' ? 'succeeded' : 'degraded',
      attempted: result.generationAttempted === true || (result.candidateDiagnostics?.length ?? 0) > 0,
      message: result.path
        ? undefined
        : result.failure ?? validation?.reason ?? 'no usable compilation database was available',
      details: {
        path: result.path,
        preExisting: result.preExisting ?? null,
        generationAttempted: result.generationAttempted ?? false,
        failure: result.failure ?? null,
        sha256: result.database?.sha256 ?? null,
        validation: validation ?? null,
        candidates: result.candidateDiagnostics?.map((candidate) => ({
          path: candidate.path,
          validation: candidate.validation,
        })) ?? [],
      },
    });
  }
}

// ─── Stage implementation ────────────────────────────────────────────────────

export class ScipIndexerStage implements PipelineStage {
  readonly name = 'scip-indexer';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    if (!context.scip?.enabled) {
      if (context.runId) {
        recordIndexerRun(context.db, {
          runId: context.runId,
          provider: 'scip',
          indexer: 'scip',
          status: 'disabled',
          attempted: false,
        });
      }
      return;
    }
    // SCIP only runs during baseline builds — never during overlay updates.
    if (context.layer === 'overlay') {
      if (context.runId) {
        recordIndexerRun(context.db, {
          runId: context.runId,
          provider: 'scip',
          indexer: 'scip',
          status: 'skipped',
          attempted: false,
          message: 'SCIP runs only for baseline indexing',
        });
      }
      return;
    }

    const log = context.log;
    const rootDir = context.walkerConfig.rootDir;

    // In update mode, determine which SCIP-supported languages have changed
    // files so we only re-run the indexers that are actually stale.
    let staleLanguages: Set<string> | null = null;
    if (mode === 'update' && context.changedFiles && context.changedFiles.length > 0) {
      staleLanguages = new Set<string>();
      const configuredLanguages = context.scip.indexers
        ? new Set(Object.keys(context.scip.indexers))
        : SCIP_SUPPORTED_LANGUAGES;
      for (const filePath of context.changedFiles) {
        const dotIdx = filePath.lastIndexOf('.');
        if (dotIdx >= 0) {
          const lang = detectLanguageForPath(filePath);
          if (lang && configuredLanguages.has(lang)) {
            staleLanguages.add(lang);
          }
        }
      }
      if (staleLanguages.size === 0) {
        log.indexing('scip-indexer: no SCIP-supported languages in changed files, skipping');
        return;
      }
      log.indexing('scip-indexer: stale languages', { languages: [...staleLanguages] });
    }

    // Load SCIP indexes (one per indexer that succeeds)
    const loadDiagnostics: ScipIndexLoadDiagnostics = {};
    const indexBuffers = await loadScipIndexes(
      context.scip,
      rootDir,
      staleLanguages,
      undefined,
      loadDiagnostics,
      context.signal,
      context.responseFileLimits,
    );
    const compilationDatabase = loadDiagnostics.cCpp?.compilationDatabase;
    if (compilationDatabase?.database !== undefined) {
      context.compilationDatabase = {
        database: compilationDatabase.database ?? null,
        candidates: compilationDatabase.candidateDiagnostics ?? [],
      };
    }
    if (indexBuffers.length === 0) {
      recordScipRunProvenance(context, loadDiagnostics, []);
      recordCppReproducibilityMetadata(context, loadDiagnostics, []);
      log.indexing('scip-indexer: no SCIP index available');
      return;
    }

    // Decode all SCIP index buffers once and keep the decoded objects alive.
    const parsedIndexes = indexBuffers.map(buf => fromBinary(IndexSchema, buf));

    const totalDocuments = parsedIndexes.reduce((n, idx) => n + idx.documents.length, 0);
    const totalExternalSymbols = parsedIndexes.reduce((n, idx) => n + idx.externalSymbols.length, 0);
    const mergeResult = mergeScipDocumentsDetailed(parsedIndexes, rootDir);
    const cFamilyOptions = {
      rootDir,
      compilationDatabase: context.compilationDatabase?.database,
      sourceCache: context.sourceCache,
    };
    const scopedPaths = new Set(
      (await walkFiles(context.walkerConfig, cFamilyOptions)).map((file) => file.path),
    );
    const scopedDocuments = mergeResult.documents.filter((document) => {
      const absolutePath = resolve(rootDir, document.relativePath);
      try {
        return scopedPaths.has(fs.realpathSync(absolutePath));
      } catch {
        return false;
      }
    });
    const cFamilyEvidence = buildCFamilyLanguageEvidence(
      scopedDocuments.map(document => document.relativePath),
      cFamilyOptions,
    );
    const positionConversion = emptyPositionConversionDiagnostics();
    const allDocuments = scopedDocuments.map((document) => {
      positionConversion.documents++;
      const loreLanguage = inferLoreLanguage(
        document.language,
        document.relativePath,
        cFamilyEvidence,
      );
      const sourceEncoding = document.positionEncoding === PositionEncoding.UnspecifiedPositionEncoding
        && (loreLanguage === 'c' || loreLanguage === 'cpp')
        ? PositionEncoding.UTF8CodeUnitOffsetFromLineStart
        : document.positionEncoding;
      if (document.positionEncoding === PositionEncoding.UnspecifiedPositionEncoding
        && sourceEncoding === PositionEncoding.UTF8CodeUnitOffsetFromLineStart) {
        positionConversion.assumedUtf8ForUnspecifiedCFamily++;
      }
      const encodingName = positionEncodingName(sourceEncoding);
      positionConversion.sourceEncodings[encodingName] =
        (positionConversion.sourceEncodings[encodingName] ?? 0) + 1;
      if (
        sourceEncoding === PositionEncoding.UnspecifiedPositionEncoding
        || sourceEncoding === PositionEncoding.UTF16CodeUnitOffsetFromLineStart
      ) {
        return document;
      }
      positionConversion.conversionRequired++;

      const absolutePath = resolve(rootDir, document.relativePath);
      let source = context.sourceCache?.get(absolutePath);
      if (source === undefined) {
        try {
          source = fs.readFileSync(absolutePath, 'utf8');
        } catch {
          source = document.text || undefined;
        }
        if (source !== undefined) context.sourceCache?.set(absolutePath, source);
      }
      if (source === undefined) {
        positionConversion.skippedMissingSource++;
        return document;
      }
      positionConversion.converted++;
      return normalizeScipDocumentPositions(document, source, sourceEncoding);
    });
    recordScipRunProvenance(context, loadDiagnostics, parsedIndexes, positionConversion);
    recordCppReproducibilityMetadata(
      context,
      loadDiagnostics,
      parsedIndexes,
      allDocuments,
      mergeResult.stats,
      cFamilyEvidence,
      positionConversion,
    );
    log.indexing('scip-indexer: loaded index', {
      documents: totalDocuments,
      uniqueDocuments: allDocuments.length,
      externalSymbols: totalExternalSymbols,
      documentMerge: mergeResult.stats.semantics,
      duplicateDocuments: mergeResult.stats.duplicateDocuments,
      mergedFiles: mergeResult.stats.mergedFiles,
      mergeFastPath: mergeResult.stats.fastPath,
      skippedDocuments: mergeResult.stats.skippedDocuments
        + (mergeResult.documents.length - scopedDocuments.length),
    });

    if (allDocuments.length === 0) return;

    // Determine which languages are covered
    const coveredLanguages = new Set<string>();
    const coveredFiles = new Set<string>();
    for (const doc of allDocuments) {
      // scip-typescript (and some other indexers) leave language blank;
      // fall back to file-extension inference.
      const loreLang = inferLoreLanguage(doc.language, doc.relativePath, cFamilyEvidence);
      if (loreLang) coveredLanguages.add(loreLang);
    }

    log.indexing('scip-indexer: languages covered', { languages: [...coveredLanguages] });

    // Determine the project's SCIP symbol prefix so we can distinguish
    // internal symbols from external ones (stdlib, node_modules, etc.).
    const internalPrefixes = buildInternalPrefixes(parsedIndexes);

    /** Is this symbol from an external package (node_modules, stdlib, etc.)? */
    const isExternalSymbolFn = (scipSymbol: string): boolean => isExternalSymbol(scipSymbol, internalPrefixes);

    // Build a global SCIP symbol → definition location map
    const symbolDefinitions = buildSymbolDefinitionMap([{ documents: allDocuments }], rootDir);

    // Build a SymbolInformation map for signatures/docs
    const symbolInfoMap = new Map<string, ScipSymbolInformation>();
    for (const doc of allDocuments) {
      for (const sym of doc.symbols) {
        if (sym.symbol) symbolInfoMap.set(sym.symbol, sym);
      }
    }

    // The merged documents, definition map, and symbol-information map now
    // contain everything needed by ingestion. Drop binary/decoded index roots
    // so duplicate embedded source texts can be reclaimed during large runs.
    indexBuffers.length = 0;
    parsedIndexes.length = 0;

    // Process each document
    const db = context.db;
    const branch = context.branch;

    // Prepared statements
    const insertFile = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, start_character, end_line, end_character, selection_line, selection_character, signature, doc_comment, resolved_type_signature, resolved_return_type, definition_uri, definition_path, parent_symbol_id, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertImport = db.prepare(
      `INSERT INTO file_imports
         (file_id, raw_import, resolved_id, resolution_method, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertRelationship = db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectExistingFile = db.prepare(
      'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ? AND generation = ?',
    );
    const deleteRelationshipsForFile = db.prepare(
      'DELETE FROM symbol_relationships WHERE file_id = ?',
    );
    const deleteTypeRefsForFile = db.prepare('DELETE FROM type_refs WHERE file_id = ?');
    const clearCalleeIdsForFile = db.prepare(
      'UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)',
    );
    const clearTypeIdsForFile = db.prepare(
      'UPDATE type_refs SET type_id = NULL WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)',
    );
    const deleteSymbolsForFile = db.prepare('DELETE FROM symbols WHERE file_id = ?');
    const deleteImportsForFile = db.prepare('DELETE FROM file_imports WHERE file_id = ?');
    const deleteFile = db.prepare('DELETE FROM files WHERE id = ?');
    const updateDuplicateImport = db.prepare(
      `UPDATE file_imports
       SET resolved_id = ?, resolution_method = 'scip_definition'
       WHERE file_id = ? AND raw_import = ?`,
    );
    const updateRelationshipTarget = db.prepare(
      `UPDATE symbol_relationships SET target_symbol_id = ?
       WHERE file_id = ? AND source_symbol_id = ?
         AND target_symbol_name = ? AND relationship_type = ?`,
    );

    const layer = context.layer;
    const generation = context.generation;

    // Global map: SCIP symbol string → canonical Lore numeric symbol ID.
    // Declaration rows remain in `symbols`, but references must point to the
    // real definition selected by `buildSymbolDefinitionMap`.
    const scipToLoreId = new Map<string, number>();
    const scipToLoreName = new Map<string, string>();
    const documentSymbolIds = new Map<string, number>();
    const symbolRows = new Map<string, Array<{
      id: number;
      filePath: string;
      line: number;
      character: number;
      name: string;
    }>>();
    const documentSymbolKey = (filePath: string, scipSymbol: string): string =>
      `${filePath}\0${scipSymbol}`;
    let recoveredSpans = 0;

    // Pass 1: Create files and symbols
    const fileIdMap = new Map<string, number>(); // absPath → file_id

    const SCIP_BATCH_SIZE = 200;
    const processDocumentBatch = db.transaction((documents: readonly ScipDocument[], start: number, end: number) => {
      for (let documentIndex = start; documentIndex < end; documentIndex++) {
        const doc = documents[documentIndex]!;
        const absPath = resolve(rootDir, doc.relativePath);
        const loreLang = inferLoreLanguage(doc.language, doc.relativePath, cFamilyEvidence);
        if (!loreLang) continue;

        // Read source file (prefer cache from prior pipeline stages)
        let source: string;
        const cached = context.sourceCache?.get(absPath);
        if (cached !== undefined) {
          source = cached;
        } else {
          try {
            source = fs.readFileSync(absPath, 'utf8');
          } catch {
            if (!doc.text) continue;
            source = doc.text;
          }
          context.sourceCache?.set(absPath, source);
        }

        const sizeBytes = Buffer.byteLength(source, 'utf8');
        const hash = crypto.createHash('sha256').update(source).digest('hex');
        let sourceSpanResolver: CSourceSpanResolver | null = null;
        const getSourceSpanResolver = (): CSourceSpanResolver | null => {
          if (loreLang !== 'c' && loreLang !== 'cpp') return null;
          sourceSpanResolver ??= new CSourceSpanResolver(source, doc.positionEncoding);
          return sourceSpanResolver;
        };

        // Delete existing data for this file (like FileDiscoveryStage does)
        const existing = selectExistingFile.get(absPath, branch, layer, generation) as
          | { id: number } | undefined;
        if (existing) {
          deleteRelationshipsForFile.run(existing.id);
          deleteTypeRefsForFile.run(existing.id);
          clearCalleeIdsForFile.run(existing.id);
          clearTypeIdsForFile.run(existing.id);
          deleteSymbolsForFile.run(existing.id);
          deleteImportsForFile.run(existing.id);
          deleteFile.run(existing.id);
        }

        // Insert file
        const fileInfo = insertFile.run(absPath, branch, loreLang, sizeBytes, hash, source, layer, generation) as { lastInsertRowid: number | bigint };
        const fileId = Number(fileInfo.lastInsertRowid);
        fileIdMap.set(absPath, fileId);
        coveredFiles.add(absPath);
        const localSymbolIds = new Map<string, number>();

        // Collect definition occurrences for this document
        // Build symbol spans: SCIP symbol → { startLine, endLine }
        const docDefs = new Map<string, {
          line: number;
          character: number;
          endCharacter: number;
          startLine: number;
          startCharacter: number;
          endLine: number;
          spanEndCharacter: number;
          symbolRoles: number;
        }>();

        // First collect all definition lines so we can order them for fallback
        const defOccs: Array<{ symbol: string; line: number; character: number; endCharacter: number; enclosingRange: number[]; symbolRoles: number }> = [];
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Definition) === 0) continue;
          if (!occ.symbol || occ.symbol.startsWith('local ')) continue;
          // SCIP range: [line, startCol, endCol] (3) or [startLine, startCol, endLine, endCol] (4)
          const endChar = occ.range.length === 4 ? (occ.range[3] ?? 0) : (occ.range[2] ?? 0);
          defOccs.push({ symbol: occ.symbol, line: occ.range[0] ?? 0, character: occ.range[1] ?? 0, endCharacter: endChar, enclosingRange: [...occ.enclosingRange], symbolRoles: occ.symbolRoles });
        }
        // Sort by line so we know the "next definition" for span estimation
        defOccs.sort((a, b) => a.line - b.line);

        for (let di = 0; di < defOccs.length; di++) {
          const occ = defOccs[di]!;
          const { symbol, line, character, endCharacter, enclosingRange, symbolRoles: occRoles } = occ;

          // Use enclosing_range for span; fall back to definition line.
          let startLine = line;
          let startCharacter = character;
          let endLine = line;
          let spanEndCharacter = endCharacter;
          if (enclosingRange.length >= 4) {
            // Full multi-line enclosing range: [startLine, startChar, endLine, endChar]
            startLine = enclosingRange[0] ?? line;
            startCharacter = enclosingRange[1] ?? character;
            endLine = enclosingRange[2] ?? line;
            spanEndCharacter = enclosingRange[3] ?? endCharacter;
          } else if (enclosingRange.length === 3) {
            startLine = enclosingRange[0] ?? line;
            startCharacter = enclosingRange[1] ?? character;
            endLine = startLine;
            spanEndCharacter = enclosingRange[2] ?? endCharacter;
          } else {
            endLine = line;
          }

          // Prefer a real definition over an earlier same-file prototype.
          const existingDef = docDefs.get(symbol);
          const isForwardDefinition = (occRoles & SymbolRole.ForwardDefinition) !== 0;
          const existingIsForward = existingDef
            ? (existingDef.symbolRoles & SymbolRole.ForwardDefinition) !== 0
            : false;
          const canonical = symbolDefinitions.get(symbol);
          const isCanonical = canonical?.filePath === absPath
            && canonical.line === line
            && canonical.character === character;
          const existingIsCanonical = existingDef !== undefined
            && canonical?.filePath === absPath
            && canonical.line === existingDef.line
            && canonical.character === existingDef.character;
          const sameDefinitionClass = existingDef !== undefined
            && existingIsForward === isForwardDefinition;
          const isEarlierStablePosition = existingDef !== undefined
            && (line < existingDef.line
              || (line === existingDef.line && character < existingDef.character));
          if (
            !existingDef
            || (isCanonical && !existingIsCanonical)
            || (!existingIsCanonical && existingIsForward && !isForwardDefinition)
            || (!existingIsCanonical && sameDefinitionClass && isEarlierStablePosition)
          ) {
            docDefs.set(symbol, {
              line,
              character,
              endCharacter,
              startLine,
              startCharacter,
              endLine,
              spanEndCharacter,
              symbolRoles: occRoles,
            });
          }
        }

        // Insert symbols from SymbolInformation + definition occurrences.
        // Sort by descriptor depth (shallowest first) so that parent symbols
        // are inserted before their children, allowing us to resolve
        // parent_symbol_id inline during INSERT rather than in a separate
        // UPDATE pass.
        const insertableSymbols = doc.symbols
          .filter(si => si.symbol && !si.symbol.startsWith('local ') && docDefs.has(si.symbol))
          .sort((a, b) => descriptorDepth(a.symbol) - descriptorDepth(b.symbol));

        for (const symInfo of insertableSymbols) {
          const defLoc = docDefs.get(symInfo.symbol)!;

          let name = symInfo.displayName || extractNameFromScipSymbol(symInfo.symbol);
          const firstDoc = symInfo.documentation[0] ?? '';
          const docHint = firstDoc.toLowerCase();
          const kind = inferKindFromScipSymbol(symInfo.symbol, docHint, symInfo.kind);

          let symbolStartLine = defLoc.startLine;
          let symbolEndLine = defLoc.endLine;
          if ((loreLang === 'c' || loreLang === 'cpp') && symbolEndLine <= symbolStartLine) {
            const resolver = getSourceSpanResolver();
            const inferredSpan = kind === 'macro'
              ? resolver?.findMacroSpan(defLoc.line) ?? null
              : (kind === 'function' || kind === 'method' || kind === 'constructor'
                  || kind === 'class' || kind === 'interface' || kind === 'enum')
                ? resolver?.findBraceDelimitedSpan(defLoc.line, defLoc.character, kind) ?? null
                : null;
            if (inferredSpan && inferredSpan.endLine > symbolEndLine) {
              symbolStartLine = inferredSpan.startLine;
              symbolEndLine = inferredSpan.endLine;
              defLoc.spanEndCharacter = inferredSpan.endCharacter;
              recoveredSpans++;
            }
          }

          // For macro/constant symbols with location-based names, extract the
          // real identifier from source using the SCIP occurrence range, which
          // points directly at the macro name token.
          if ((kind === 'constant' || kind === 'macro') && /:\d+$/.test(name)) {
            const token = getSourceSpanResolver()?.sliceRange([
              defLoc.line,
              defLoc.character,
              defLoc.endCharacter,
            ]);
            if (token) name = token;
          }

          // Skip parameters, type parameters, and module-level namespace symbols.
          if (kind === 'parameter' || kind === 'module') continue;

          const signature = extractSignatureFromDoc(firstDoc);
          const docComment = symInfo.documentation.slice(1).join('\n').trim() || null;

          // Compute enrichment data inline (definition + type signature)
          const resolvedTypeSig = signature || null;
          const resolvedReturnType = extractReturnType(resolvedTypeSig);

          // For forward declarations (e.g. C header prototypes), point
          // definition_path/definition_uri to the real implementation when
          // one exists, so downstream consumers get authoritative
          // declaration-to-definition directionality.
          const isForwardDef = (defLoc.symbolRoles & SymbolRole.ForwardDefinition) !== 0;
          let defPath = absPath;
          if (isForwardDef) {
            const canonicalDef = symbolDefinitions.get(symInfo.symbol);
            if (canonicalDef && canonicalDef.filePath !== absPath) {
              defPath = canonicalDef.filePath;
            }
          }
          const definitionUri = pathToFileURL(defPath).toString();

          // Resolve parent_symbol_id.
          // Prefer SCIP's `enclosingSymbol` (authoritative) when populated;
          // fall back to walking the descriptor chain with extractParentScipSymbol.
          let parentLoreId: number | null = null;
          if (symInfo.enclosingSymbol) {
            const enclosingId = localSymbolIds.get(symInfo.enclosingSymbol)
              ?? scipToLoreId.get(symInfo.enclosingSymbol);
            if (enclosingId !== undefined) {
              parentLoreId = enclosingId;
            }
          }
          if (parentLoreId === null) {
            let candidateScip = extractParentScipSymbol(symInfo.symbol);
            while (candidateScip) {
              const id = localSymbolIds.get(candidateScip) ?? scipToLoreId.get(candidateScip);
              if (id !== undefined) {
                parentLoreId = id;
                break;
              }
              candidateScip = extractParentScipSymbol(candidateScip);
            }
          }

          const info = insertSymbol.run(
            fileId, name, kind,
            symbolStartLine, defLoc.startCharacter,
            symbolEndLine, defLoc.spanEndCharacter,
            defLoc.line, defLoc.character,
            signature || null, docComment,
            resolvedTypeSig, resolvedReturnType, definitionUri, defPath,
            parentLoreId,
            layer, generation,
          ) as { lastInsertRowid: number | bigint };
          const loreId = Number(info.lastInsertRowid);
          localSymbolIds.set(symInfo.symbol, loreId);
          documentSymbolIds.set(documentSymbolKey(absPath, symInfo.symbol), loreId);
          let rows = symbolRows.get(symInfo.symbol);
          if (!rows) {
            rows = [];
            symbolRows.set(symInfo.symbol, rows);
          }
          rows.push({
            id: loreId,
            filePath: absPath,
            line: defLoc.line,
            character: defLoc.character,
            name,
          });

          const canonical = symbolDefinitions.get(symInfo.symbol);
          const isCanonical = canonical?.filePath === absPath
            && canonical.line === defLoc.line
            && canonical.character === defLoc.character;
          if (isCanonical || !scipToLoreId.has(symInfo.symbol)) {
            scipToLoreId.set(symInfo.symbol, loreId);
            scipToLoreName.set(symInfo.symbol, name);
          }
        }

        // Insert imports (from Import-role occurrences)
        // Use SCIP symbol string to derive import path.
        // Use symbolDefinitions to pre-resolve imports to target file IDs.
        const seenImports = new Map<string, number | null>(); // rawImport → resolved file ID
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Import) !== 0 && occ.symbol) {
            // Derive import path from SCIP symbol string.
            // SCIP symbols are: <scheme> <manager> <package> <version> <descriptors>
            // The package part (parts[3]) gives the module identity.
            const parts = occ.symbol.split(' ');
            const rawImport = parts.length >= 4 ? parts[3]! : occ.symbol;
            if (!rawImport) continue;

            // Resolve the import's target file via SCIP symbol → definition location
            const defLoc = symbolDefinitions.get(occ.symbol);
            const resolvedFileId = defLoc ? (fileIdMap.get(defLoc.filePath) ?? null) : null;

            if (seenImports.has(rawImport)) {
              // If we already inserted this import without a resolved_id,
              // upgrade it now that we have one.
              if (resolvedFileId && !seenImports.get(rawImport)) {
                seenImports.set(rawImport, resolvedFileId);
                updateDuplicateImport.run(resolvedFileId, fileId, rawImport);
              }
            } else {
              seenImports.set(rawImport, resolvedFileId);
              insertImport.run(
                fileId,
                rawImport,
                resolvedFileId,
                resolvedFileId ? 'scip_definition' : 'unresolved',
                layer,
                generation,
              );
            }
          }
        }

        // References only need occurrences/symbol metadata in the next pass.
        // Source remains persisted and in the byte-budgeted cache; do not keep
        // a second unbounded copy attached to each decoded SCIP document.
        doc.text = '';
      }
    });

    // Duplicate documents are common in scip-clang output when one source file
    // is compiled into multiple targets. Process their merged union once.
    const allDocsForBatching = allDocuments;
    for (let batchStart = 0; batchStart < allDocsForBatching.length; batchStart += SCIP_BATCH_SIZE) {
      throwIfPipelineCancelled(context);
      processDocumentBatch(
        allDocsForBatching,
        batchStart,
        Math.min(batchStart + SCIP_BATCH_SIZE, allDocsForBatching.length),
      );
    }

    // Rebuild the global map from all inserted declaration rows. This makes
    // the numeric callee identity follow the same canonical path/position as
    // `symbolDefinitions`, independent of document order. A deterministic row
    // fallback covers malformed indexes whose canonical occurrence has no
    // matching SymbolInformation record.
    for (const [scipSymbol, rows] of symbolRows) {
      const canonical = symbolDefinitions.get(scipSymbol);
      const matchingCanonical = canonical
        ? rows.filter((row) => row.filePath === canonical.filePath
            && row.line === canonical.line
            && row.character === canonical.character)
        : [];
      const candidates = matchingCanonical.length > 0 ? matchingCanonical : rows;
      const selected = [...candidates].sort((left, right) =>
        compareStableText(left.filePath, right.filePath)
          || left.line - right.line
          || left.character - right.character
          || left.id - right.id,
      )[0];
      if (!selected) continue;
      scipToLoreId.set(scipSymbol, selected.id);
      scipToLoreName.set(scipSymbol, selected.name);
    }

    // Relationships are emitted only after canonical target IDs exist. Their
    // source remains the declaration row belonging to this SCIP document, so
    // retaining a header declaration does not silently move its relationships
    // onto an implementation row.
    const insertRelationships = db.transaction((documents: readonly ScipDocument[]) => {
      for (const doc of documents) {
        const absPath = resolve(rootDir, doc.relativePath);
        const fileId = fileIdMap.get(absPath);
        if (!fileId) continue;
        for (const symInfo of doc.symbols) {
          if (!symInfo.symbol || symInfo.relationships.length === 0) continue;
          const localSourceId = documentSymbolIds.get(documentSymbolKey(absPath, symInfo.symbol));
          const sourceId = localSourceId ?? scipToLoreId.get(symInfo.symbol) ?? null;
          const sourceRow = localSourceId === undefined
            ? undefined
            : symbolRows.get(symInfo.symbol)?.find((row) => row.id === localSourceId);

          for (const rel of symInfo.relationships) {
            if (!rel.symbol) continue;
            let relType: string | null = null;
            if (rel.isImplementation) {
              const targetInfo = symbolInfoMap.get(rel.symbol);
              const targetKind = targetInfo
                ? inferKindFromScipSymbol(
                    rel.symbol,
                    (targetInfo.documentation[0] ?? '').toLowerCase(),
                    targetInfo.kind,
                  )
                : null;
              relType = targetKind === 'class' ? 'extends' : 'implements';
            } else if (rel.isTypeDefinition) {
              relType = 'type_definition';
            } else if (rel.isDefinition) {
              relType = 'defines';
            }
            if (!relType) continue;

            const targetId = scipToLoreId.get(rel.symbol) ?? null;
            const targetName = scipToLoreName.get(rel.symbol)
              ?? extractNameFromScipSymbol(rel.symbol);
            const sourceDef = symbolDefinitions.get(symInfo.symbol);
            const targetDef = symbolDefinitions.get(rel.symbol);
            const relDefUri = targetDef ? pathToFileURL(targetDef.filePath).toString() : null;

            insertRelationship.run(
              fileId,
              sourceId,
              targetName,
              relType,
              sourceRow?.line ?? sourceDef?.line ?? null,
              sourceRow?.character ?? sourceDef?.character ?? null,
              targetId ? 'scip_definition' : 'unresolved',
              relDefUri,
              targetDef?.filePath ?? null,
              targetDef?.line ?? null,
              targetDef?.character ?? null,
              layer,
              generation,
            );
            if (targetId) {
              updateRelationshipTarget.run(targetId, fileId, sourceId, targetName, relType);
            }
          }
        }
      }
    });
    insertRelationships(allDocsForBatching);

    log.indexing('scip-indexer: symbols inserted', {
      files: fileIdMap.size,
      symbols: scipToLoreId.size,
      recoveredSpans,
    });

    // ── Pass 2+3: Containment index + ref insertion ─────────────────────
    // Build containment index and insert refs inline (no deferred stage).
    // Symbol end_line values come from SCIP enclosingRange, which is
    // already populated above.

    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, resolved_type_signature, resolved_return_type, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTypeRef = db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method, resolved_type_signature, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Build containment index from the symbols we just inserted.
    const fileSymbolSpans = buildContainmentIndex(
      db.prepare(
        `SELECT s.id, s.file_id, s.start_line, s.end_line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.branch = ?
           AND s.layer = ?
           AND s.generation = ?
         ORDER BY s.file_id, (s.end_line - s.start_line) ASC`,
      ).iterate(branch, layer, generation) as IterableIterator<{
        id: number;
        file_id: number;
        start_line: number;
        end_line: number;
      }>,
    );

    // Insert call refs and type refs from SCIP reference occurrences
    let refsInserted = 0;
    let refsExternal = 0;
    let refsNoCaller = 0;
    let refsLocal = 0;
    let refsSkippedNonCall = 0;
    let typeRefsInserted = 0;

    const SCIP_REF_BATCH_SIZE = 200;
    const processRefBatch = db.transaction((documents: readonly ScipDocument[], start: number, end: number) => {
      for (let documentIndex = start; documentIndex < end; documentIndex++) {
        const doc = documents[documentIndex]!;
        const absPath = resolve(rootDir, doc.relativePath);
        const fileId = fileIdMap.get(absPath);
        if (!fileId) continue;

        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Definition) !== 0) continue;
          if (!occ.symbol) continue;

          if (occ.symbol.startsWith('local ')) {
            refsLocal++;
            continue;
          }

          const refKind = classifyScipReference(occ.symbol, occ.syntaxKind);
          const line = occ.range[0] ?? 0;
          const character = occ.range[1] ?? 0;
          if (refKind === 'skip') {
            refsSkippedNonCall++;
            continue;
          }

          const callerId = findContainingSymbol(fileSymbolSpans, fileId, line);
          if (!callerId) {
            refsNoCaller++;
            continue;
          }

          const calleeId = scipToLoreId.get(occ.symbol) ?? null;
          const calleeName = scipToLoreName.get(occ.symbol) ?? extractNameFromScipSymbol(occ.symbol);
          const isExternal = !calleeId && isExternalSymbolFn(occ.symbol);
          const method = calleeId ? 'scip_definition' : (isExternal ? 'external_definition' : 'unresolved');

          if (refKind === 'type') {
            const typeRefKind = 'other';
            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = symbolInfoMap.get(occ.symbol);
            const refSig = refInfo ? extractSignatureFromDoc(refInfo.documentation[0] ?? '') || null : null;
            const refDefUri = refDef ? pathToFileURL(refDef.filePath).toString() : null;

            insertTypeRef.run(
              fileId, callerId, calleeId ?? null,
              calleeName, normalizeTypeName(calleeName), typeRefKind,
              line, character, method, refSig,
              refDefUri, refDef?.filePath ?? null, refDef?.line ?? null, refDef?.character ?? null,
              layer, generation,
            );
            typeRefsInserted++;
          } else {
            const resolvedCalleeName = calleeName;

            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = symbolInfoMap.get(occ.symbol);
            const refSig = refInfo ? extractSignatureFromDoc(refInfo.documentation[0] ?? '') || null : null;
            const refReturnType = extractReturnType(refSig);
            const refDefUri = refDef ? pathToFileURL(refDef.filePath).toString() : null;

            insertCallRef.run(
              callerId, fileId, calleeId ?? null, resolvedCalleeName,
              line, character, 'direct', method, refSig, refReturnType,
              refDefUri, refDef?.filePath ?? null, refDef?.line ?? null, refDef?.character ?? null,
              layer, generation,
            );
            refsInserted++;
            if (isExternal) refsExternal++;
          }
        }
      }
    });
    for (let batchStart = 0; batchStart < allDocsForBatching.length; batchStart += SCIP_REF_BATCH_SIZE) {
      throwIfPipelineCancelled(context);
      processRefBatch(
        allDocsForBatching,
        batchStart,
        Math.min(batchStart + SCIP_REF_BATCH_SIZE, allDocsForBatching.length),
      );
    }

    log.indexing('scip-indexer: refs inserted', {
      callRefs: refsInserted,
      typeRefs: typeRefsInserted,
      external: refsExternal,
      noCaller: refsNoCaller,
      skippedLocal: refsLocal,
      skippedNonCall: refsSkippedNonCall,
    });

    // ── Pass 4: Virtual dispatch ──────────────────────────────────────────
    materializeVirtualDispatch(
      db, scipToLoreId, symbolInfoMap, symbolDefinitions, layer, generation, log,
    );

    // Communicate coverage to downstream stages
    context.scipSourcedLanguages = coveredLanguages;
    context.scipSourcedFiles = coveredFiles;
    context.scipCoveredLanguages = coveredLanguages;

    // Add SCIP-sourced files to context.files so later stages process them
    for (const doc of allDocuments) {
      const absPath = resolve(rootDir, doc.relativePath);
      const loreLang = inferLoreLanguage(doc.language, doc.relativePath, cFamilyEvidence);
      if (loreLang && fileIdMap.has(absPath)) {
        context.files.push({ path: absPath, language: loreLang });
      }
    }
  }

  async dispose(): Promise<void> {
    // No persistent resources to clean up
  }
}

// ─── Extracted pure data-processing functions ────────────────────────────────

export interface SymbolSpan {
  id: number;
  startLine: number;
  endLine: number;
}

interface SpanBoundary {
  line: number;
  operation: 'add' | 'remove';
  span: SymbolSpan;
}

/**
 * Piecewise-constant narrowest-containing-symbol index for one file.
 * Construction uses a sweep line and priority heap; lookup is a binary search
 * over at most two boundaries per input span.
 */
export class SymbolSpanIndex {
  private readonly segmentStarts: number[] = [];
  private readonly segmentSymbolIds: Array<number | null> = [];
  readonly length: number;

  constructor(spans: readonly SymbolSpan[]) {
    const validSpans = spans.filter(span =>
      Number.isFinite(span.startLine)
      && Number.isFinite(span.endLine)
      && span.endLine >= span.startLine,
    );
    this.length = validSpans.length;
    if (validSpans.length === 0) return;

    const boundaries: SpanBoundary[] = [];
    for (const span of validSpans) {
      boundaries.push({ line: span.startLine, operation: 'add', span });
      if (span.endLine < Number.MAX_SAFE_INTEGER) {
        boundaries.push({ line: span.endLine + 1, operation: 'remove', span });
      }
    }
    boundaries.sort((left, right) => left.line - right.line);

    const active = new Set<number>();
    const heap: SymbolSpan[] = [];
    for (let index = 0; index < boundaries.length;) {
      const line = boundaries[index]!.line;
      let end = index + 1;
      while (end < boundaries.length && boundaries[end]!.line === line) end++;

      // Removals and additions at the same boundary are applied together so
      // inclusive end lines and same-line spans retain their exact semantics.
      for (let cursor = index; cursor < end; cursor++) {
        const boundary = boundaries[cursor]!;
        if (boundary.operation === 'remove') active.delete(boundary.span.id);
      }
      for (let cursor = index; cursor < end; cursor++) {
        const boundary = boundaries[cursor]!;
        if (boundary.operation === 'add') {
          active.add(boundary.span.id);
          heapPush(heap, boundary.span);
        }
      }
      while (heap[0] && !active.has(heap[0].id)) heapPop(heap);

      const winner = heap[0]?.id ?? null;
      if (this.segmentSymbolIds.at(-1) !== winner) {
        this.segmentStarts.push(line);
        this.segmentSymbolIds.push(winner);
      }
      index = end;
    }
  }

  find(line: number): number | null {
    let low = 0;
    let high = this.segmentStarts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.segmentStarts[middle]! <= line) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? null : (this.segmentSymbolIds[low - 1] ?? null);
  }

  /** Exposed for structural scale tests; lookups remain logarithmic in this count. */
  get segmentCount(): number {
    return this.segmentStarts.length;
  }
}

function spanIsNarrower(left: SymbolSpan, right: SymbolSpan): boolean {
  const leftWidth = left.endLine - left.startLine;
  const rightWidth = right.endLine - right.startLine;
  return leftWidth < rightWidth
    || (leftWidth === rightWidth && left.startLine > right.startLine)
    || (leftWidth === rightWidth && left.startLine === right.startLine && left.id < right.id);
}

function heapPush(heap: SymbolSpan[], span: SymbolSpan): void {
  let index = heap.push(span) - 1;
  while (index > 0) {
    const parent = (index - 1) >>> 1;
    if (!spanIsNarrower(heap[index]!, heap[parent]!)) break;
    [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
    index = parent;
  }
}

function heapPop(heap: SymbolSpan[]): void {
  const replacement = heap.pop();
  if (!replacement || heap.length === 0) return;
  heap[0] = replacement;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    const child = right < heap.length && spanIsNarrower(heap[right]!, heap[left]!)
      ? right
      : left;
    if (!spanIsNarrower(heap[child]!, heap[index]!)) return;
    [heap[index], heap[child]] = [heap[child]!, heap[index]!];
    index = child;
  }
}

/**
 * Extract SCIP symbol prefixes (scheme + package manager + package + version)
 * that identify symbols belonging to the indexed project. Used to distinguish
 * internal symbols from external ones (stdlib, node_modules, etc.).
 */
export function buildInternalPrefixes(
  parsedIndexes: ReadonlyArray<{ documents: ReadonlyArray<{ symbols: ReadonlyArray<{ symbol: string }> }> }>,
): Set<string> {
  const prefixes = new Set<string>();
  for (const idx of parsedIndexes) {
    for (const doc of idx.documents) {
      for (const sym of doc.symbols) {
        if (sym.symbol && !sym.symbol.startsWith('local ')) {
          const parts = sym.symbol.split(' ');
          if (parts.length >= 4) {
            prefixes.add(parts.slice(0, 4).join(' '));
          }
          break; // One per document is enough
        }
      }
    }
  }
  return prefixes;
}

/** Is this symbol from an external package (node_modules, stdlib, etc.)? */
export function isExternalSymbol(scipSymbol: string, internalPrefixes: Set<string>): boolean {
  if (internalPrefixes.size === 0) return false;
  for (const prefix of internalPrefixes) {
    if (scipSymbol.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Build a global SCIP symbol → definition location map from parsed indexes.
 *
 * When a symbol has both a forward declaration (`ForwardDefinition` role,
 * e.g. a C header prototype) and a real definition (implementation in a
 * `.c` file), the real definition wins regardless of document order.
 * Definitions of the same kind are ordered by canonical path and position,
 * making the selected location independent of index/document order.
 */
export function buildSymbolDefinitionMap(
  parsedIndexes: ReadonlyArray<{ documents: ReadonlyArray<{ relativePath: string; occurrences: ReadonlyArray<{ symbolRoles: number; symbol: string; range: number[] }> }> }>,
  rootDir: string,
): Map<string, { filePath: string; line: number; character: number }> {
  interface DefinitionCandidate {
    filePath: string;
    line: number;
    character: number;
    forward: boolean;
  }
  const candidates = new Map<string, DefinitionCandidate[]>();
  for (const idx of parsedIndexes) {
    for (const doc of idx.documents) {
      const absPath = resolve(rootDir, doc.relativePath);
      for (const occ of doc.occurrences) {
        if ((occ.symbolRoles & SymbolRole.Definition) !== 0 && occ.symbol && !occ.symbol.startsWith('local ')) {
          let symbolCandidates = candidates.get(occ.symbol);
          if (!symbolCandidates) {
            symbolCandidates = [];
            candidates.set(occ.symbol, symbolCandidates);
          }
          symbolCandidates.push({
            filePath: absPath,
            line: occ.range[0] ?? 0,
            character: occ.range[1] ?? 0,
            forward: (occ.symbolRoles & SymbolRole.ForwardDefinition) !== 0,
          });
        }
      }
    }
  }

  const symbolDefinitions = new Map<string, { filePath: string; line: number; character: number }>();
  for (const [symbol, symbolCandidates] of candidates) {
    const selected = [...symbolCandidates].sort((left, right) =>
      Number(left.forward) - Number(right.forward)
        || compareStableText(left.filePath, right.filePath)
        || left.line - right.line
        || left.character - right.character,
    )[0];
    if (selected) {
      symbolDefinitions.set(symbol, {
        filePath: selected.filePath,
        line: selected.line,
        character: selected.character,
      });
    }
  }
  return symbolDefinitions;
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Build a containment index: file_id → sorted array of symbol spans.
 * Used for finding which symbol lexically contains a given source line.
 */
export function buildContainmentIndex(
  rows: Iterable<{ id: number; file_id: number; start_line: number; end_line: number }>,
): Map<number, SymbolSpanIndex> {
  const grouped = new Map<number, SymbolSpan[]>();
  for (const row of rows) {
    let spans = grouped.get(row.file_id);
    if (!spans) {
      spans = [];
      grouped.set(row.file_id, spans);
    }
    spans.push({ id: row.id, startLine: row.start_line, endLine: row.end_line });
  }
  return new Map([...grouped].map(([fileId, spans]) => [fileId, new SymbolSpanIndex(spans)]));
}

/**
 * Find the innermost symbol span in the containment index containing a line.
 * Returns the symbol ID or null if no span contains the line.
 */
export function findContainingSymbol(
  fileSymbolSpans: ReadonlyMap<number, SymbolSpanIndex | readonly SymbolSpan[]>,
  fileId: number,
  line: number,
): number | null {
  const spans = fileSymbolSpans.get(fileId);
  if (!spans) return null;
  if (spans instanceof SymbolSpanIndex) return spans.find(line);

  // Compatibility path for callers/tests that construct an index manually.
  let best: SymbolSpan | null = null;
  for (const span of spans) {
    if (line < span.startLine || line > span.endLine) continue;
    if (!best) {
      best = span;
      continue;
    }
    const width = span.endLine - span.startLine;
    const bestWidth = best.endLine - best.startLine;
    if (
      width < bestWidth
      || (width === bestWidth && span.startLine > best.startLine)
      || (width === bestWidth && span.startLine === best.startLine && span.id < best.id)
    ) {
      best = span;
    }
  }
  return best?.id ?? null;
}

// ─── Test-visible helpers ───────────────────────────────────────────────────
// Re-exported from helper modules for unit testing.  Not part of the public API.

export {
  inferKindFromScipSymbol as _inferKindFromScipSymbol,
  inferLoreLanguage as _inferLoreLanguage,
  classifyScipReference as _classifyScipReference,
  extractNameFromScipSymbol as _extractNameFromScipSymbol,
  extractParentTypeSymbol as _extractParentTypeSymbol,
  extractMethodDescriptor as _extractMethodDescriptor,
  extractParentScipSymbol as _extractParentScipSymbol,
};
