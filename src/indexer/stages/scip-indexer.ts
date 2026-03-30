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
 * SCIP refs are inserted **pre-resolved** with `resolution_method =
 * 'scip_definition'`.  The downstream resolution stage only processes
 * refs from non-SCIP languages.
 *
 * ## Data written
 *
 * `files`, `symbols`, `symbols_fts`, `symbol_refs`, `type_refs`,
 * `symbol_relationships`, `file_imports`.  Enrichment columns (type
 * signatures, definition locations) are populated inline.
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
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  SymbolRole,
  type Document as ScipDocument,
  type SymbolInformation as ScipSymbolInformation,
} from '../../scip/scip_pb.js';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { normalizeTypeName } from '../../resolution/call-graph.js';
import { SCIP_SUPPORTED_LANGUAGES } from '../../scip/registry.js';
import { extractReturnType } from '../../scip/index-reader.js';
import { EXT_TO_LANG } from '../../discovery/walker.js';

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
} from './scip-helpers/process.js';

import {
  inferLoreLanguage,
  materializeVirtualDispatch,
} from './scip-helpers/ingest.js';

// Re-export createLoreScipTsconfig for tests
export { createLoreScipTsconfig };

// ─── Stage implementation ────────────────────────────────────────────────────

export class ScipIndexerStage implements PipelineStage {
  readonly name = 'scip-indexer';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    if (!context.scip?.enabled) return;
    // SCIP only runs during baseline builds — never during overlay updates.
    if (context.layer === 'overlay') return;

    const log = context.log;
    const rootDir = context.walkerConfig.rootDir;

    // In update mode, determine which SCIP-supported languages have changed
    // files so we only re-run the indexers that are actually stale.
    let staleLanguages: Set<string> | null = null;
    if (mode === 'update' && context.changedFiles && context.changedFiles.length > 0) {
      staleLanguages = new Set<string>();
      for (const filePath of context.changedFiles) {
        const dotIdx = filePath.lastIndexOf('.');
        if (dotIdx >= 0) {
          const ext = filePath.slice(dotIdx).toLowerCase();
          const lang = EXT_TO_LANG[ext];
          if (lang && SCIP_SUPPORTED_LANGUAGES.has(lang)) {
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
    const indexBuffers = await loadScipIndexes(context.scip, rootDir, staleLanguages);
    if (indexBuffers.length === 0) {
      log.indexing('scip-indexer: no SCIP index available');
      return;
    }

    // Decode all SCIP index buffers once and keep the decoded objects alive.
    const parsedIndexes = indexBuffers.map(buf => fromBinary(IndexSchema, buf));

    const totalDocuments = parsedIndexes.reduce((n, idx) => n + idx.documents.length, 0);
    const totalExternalSymbols = parsedIndexes.reduce((n, idx) => n + idx.externalSymbols.length, 0);
    log.indexing('scip-indexer: loaded index', {
      documents: totalDocuments,
      externalSymbols: totalExternalSymbols,
    });

    if (totalDocuments === 0) return;

    // Determine which languages are covered
    const coveredLanguages = new Set<string>();
    const coveredFiles = new Set<string>();
    for (const idx of parsedIndexes) {
      for (const doc of idx.documents) {
        // scip-typescript (and some other indexers) leave language blank;
        // fall back to file-extension inference.
        const loreLang = inferLoreLanguage(doc.language, doc.relativePath);
        if (loreLang) coveredLanguages.add(loreLang);
      }
    }

    log.indexing('scip-indexer: languages covered', { languages: [...coveredLanguages] });

    // Determine the project's SCIP symbol prefix so we can distinguish
    // internal symbols from external ones (stdlib, node_modules, etc.).
    const internalPrefixes = buildInternalPrefixes(parsedIndexes);

    /** Is this symbol from an external package (node_modules, stdlib, etc.)? */
    const isExternalSymbolFn = (scipSymbol: string): boolean => isExternalSymbol(scipSymbol, internalPrefixes);

    // Build a global SCIP symbol → definition location map
    const symbolDefinitions = buildSymbolDefinitionMap(parsedIndexes, rootDir);

    // Build a SymbolInformation map for signatures/docs
    const symbolInfoMap = new Map<string, ScipSymbolInformation>();
    for (const idx of parsedIndexes) {
      for (const doc of idx.documents) {
        for (const sym of doc.symbols) {
          if (sym.symbol) symbolInfoMap.set(sym.symbol, sym);
        }
      }
    }

    // Process each document
    const db = context.db;
    const branch = context.branch;

    // Prepared statements
    const insertFile = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment, resolved_type_signature, resolved_return_type, definition_uri, definition_path, parent_symbol_id, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertImport = db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    );
    const insertRelationship = db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const layer = context.layer;
    const generation = context.generation;

    // Global map: SCIP symbol string → Lore numeric symbol ID (across all files)
    const scipToLoreId = new Map<string, number>();

    // Pass 1: Create files and symbols
    const fileIdMap = new Map<string, number>(); // absPath → file_id

    const SCIP_BATCH_SIZE = 200;
    const processDocumentBatch = db.transaction((batch: ScipDocument[]) => {
      for (const doc of batch) {
        const absPath = resolve(rootDir, doc.relativePath);
        const loreLang = inferLoreLanguage(doc.language, doc.relativePath);
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
            continue;
          }
          context.sourceCache?.set(absPath, source);
        }

        const sizeBytes = Buffer.byteLength(source, 'utf8');
        const hash = crypto.createHash('sha256').update(source).digest('hex');

        // Delete existing data for this file (like FileDiscoveryStage does)
        const existing = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?').get(absPath, branch, layer) as
          | { id: number } | undefined;
        if (existing) {
          db.prepare('DELETE FROM symbol_relationships WHERE file_id = ?').run(existing.id);
          db.prepare('DELETE FROM type_refs WHERE file_id = ?').run(existing.id);
          db.prepare('UPDATE symbol_refs SET callee_id = NULL WHERE callee_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existing.id);
          db.prepare('UPDATE type_refs SET type_id = NULL WHERE type_id IN (SELECT id FROM symbols WHERE file_id = ?)').run(existing.id);
          db.prepare('DELETE FROM symbols WHERE file_id = ?').run(existing.id);
          db.prepare('DELETE FROM file_imports WHERE file_id = ?').run(existing.id);
          db.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
        }

        // Insert file
        const fileInfo = insertFile.run(absPath, branch, loreLang, sizeBytes, hash, source, layer, generation) as { lastInsertRowid: number | bigint };
        const fileId = Number(fileInfo.lastInsertRowid);
        fileIdMap.set(absPath, fileId);
        coveredFiles.add(absPath);

        // Collect definition occurrences for this document
        // Build symbol spans: SCIP symbol → { startLine, endLine }
        const docDefs = new Map<string, { line: number; character: number; startLine: number; endLine: number; symbolRoles: number }>();

        // First collect all definition lines so we can order them for fallback
        const defOccs: Array<{ symbol: string; line: number; character: number; enclosingRange: number[]; symbolRoles: number }> = [];
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Definition) === 0) continue;
          if (!occ.symbol || occ.symbol.startsWith('local ')) continue;
          defOccs.push({ symbol: occ.symbol, line: occ.range[0] ?? 0, character: occ.range[1] ?? 0, enclosingRange: [...occ.enclosingRange], symbolRoles: occ.symbolRoles });
        }
        // Sort by line so we know the "next definition" for span estimation
        defOccs.sort((a, b) => a.line - b.line);

        for (let di = 0; di < defOccs.length; di++) {
          const occ = defOccs[di]!;
          const { symbol, line, character, enclosingRange, symbolRoles: occRoles } = occ;

          // Use enclosing_range for span; fall back to definition line.
          let startLine = line;
          let endLine = line;
          if (enclosingRange.length >= 4) {
            // Full multi-line enclosing range: [startLine, startChar, endLine, endChar]
            startLine = enclosingRange[0] ?? line;
            endLine = enclosingRange[2] ?? line;
          } else if (enclosingRange.length === 3) {
            startLine = enclosingRange[0] ?? line;
            endLine = startLine;
          } else {
            endLine = line;
          }

          // Keep the first definition per symbol in this file
          if (!docDefs.has(symbol)) {
            docDefs.set(symbol, { line, character, startLine, endLine, symbolRoles: occRoles });
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

          const name = symInfo.displayName || extractNameFromScipSymbol(symInfo.symbol);
          const firstDoc = symInfo.documentation[0] ?? '';
          const docHint = firstDoc.toLowerCase();
          const kind = inferKindFromScipSymbol(symInfo.symbol, docHint, symInfo.kind);

          // Skip parameters, type parameters, and module-level namespace symbols
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
            const enclosingId = scipToLoreId.get(symInfo.enclosingSymbol);
            if (enclosingId !== undefined) {
              parentLoreId = enclosingId;
            }
          }
          if (parentLoreId === null) {
            let candidateScip = extractParentScipSymbol(symInfo.symbol);
            while (candidateScip) {
              const id = scipToLoreId.get(candidateScip);
              if (id !== undefined) {
                parentLoreId = id;
                break;
              }
              candidateScip = extractParentScipSymbol(candidateScip);
            }
          }

          const info = insertSymbol.run(
            fileId, name, kind,
            defLoc.startLine, defLoc.endLine,
            signature || null, docComment,
            resolvedTypeSig, resolvedReturnType, definitionUri, defPath,
            parentLoreId,
            layer, generation,
          ) as { lastInsertRowid: number | bigint };
          const loreId = Number(info.lastInsertRowid);
          scipToLoreId.set(symInfo.symbol, loreId);
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
                db.prepare('UPDATE file_imports SET resolved_id = ? WHERE file_id = ? AND raw_import = ?')
                  .run(resolvedFileId, fileId, rawImport);
              }
            } else {
              seenImports.set(rawImport, resolvedFileId);
              insertImport.run(fileId, rawImport, resolvedFileId, layer, generation);
            }
          }
        }

        // Insert relationships (extends/implements) from SCIP SymbolInformation
        for (const symInfo of doc.symbols) {
          if (!symInfo.symbol || symInfo.relationships.length === 0) continue;
          const sourceId = scipToLoreId.get(symInfo.symbol) ?? null;

          for (const rel of symInfo.relationships) {
            if (!rel.symbol) continue;

            // Map SCIP relationship flags to Lore relationship types
            // Disambiguate extends vs implements: if the target is a class/struct
            // the source extends it; if the target is an interface/trait the
            // source implements it.
            let relType: string | null = null;
            if (rel.isImplementation) {
              const targetInfo = symbolInfoMap.get(rel.symbol);
              const targetKind = targetInfo
                ? inferKindFromScipSymbol(rel.symbol, (targetInfo.documentation[0] ?? '').toLowerCase(), targetInfo.kind)
                : null;
              relType = (targetKind === 'class') ? 'extends' : 'implements';
            } else if (rel.isTypeDefinition) {
              relType = 'type_definition';
            } else if (rel.isDefinition) {
              relType = 'defines';
            }
            if (!relType) continue;

            const targetName = extractNameFromScipSymbol(rel.symbol);
            const targetId = scipToLoreId.get(rel.symbol) ?? null;
            // Find a definition location for the line/character.
            // Some SCIP indexers (e.g. scip-go) emit SymbolInformation with
            // relationships for symbols whose definition is in another file or
            // external package, so defLoc may be undefined.
            const defLoc = symbolDefinitions.get(symInfo.symbol);

            // Resolve the target's definition location for enrichment
            const targetDef = symbolDefinitions.get(rel.symbol);
            const relDefUri = targetDef ? pathToFileURL(targetDef.filePath).toString() : null;

            insertRelationship.run(
              fileId,
              sourceId,
              targetName,
              relType,
              defLoc?.line ?? null,
              defLoc?.character ?? null,
              targetId ? 'scip_definition' : 'unresolved',
              relDefUri,
              targetDef?.filePath ?? null,
              targetDef?.line ?? null,
              targetDef?.character ?? null,
              layer, generation,
            );

            // If we have both source and target IDs, update the resolved target
            if (targetId) {
              db.prepare(
                'UPDATE symbol_relationships SET target_symbol_id = ? WHERE file_id = ? AND source_symbol_id = ? AND target_symbol_name = ? AND relationship_type = ?',
              ).run(targetId, fileId, sourceId, targetName, relType);
            }
          }
        }
      }
    });

    // Collect all documents across parsed indexes for batched processing
    const allDocsForBatching: ScipDocument[] = [];
    for (const idx of parsedIndexes) {
      allDocsForBatching.push(...idx.documents);
    }
    for (let batchStart = 0; batchStart < allDocsForBatching.length; batchStart += SCIP_BATCH_SIZE) {
      processDocumentBatch(allDocsForBatching.slice(batchStart, batchStart + SCIP_BATCH_SIZE));
    }

    log.indexing('scip-indexer: symbols inserted', {
      files: fileIdMap.size,
      symbols: scipToLoreId.size,
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
           AND s.kind IN ('function', 'method', 'class', 'constructor', 'variable')
         ORDER BY s.file_id, (s.end_line - s.start_line) ASC`,
      ).all(branch, layer, generation) as Array<{ id: number; file_id: number; start_line: number; end_line: number }>,
    );

    // Insert call refs and type refs from SCIP reference occurrences
    let refsInserted = 0;
    let refsExternal = 0;
    let refsNoCaller = 0;
    let refsLocal = 0;
    let refsSkippedNonCall = 0;
    let typeRefsInserted = 0;

    const SCIP_REF_BATCH_SIZE = 200;
    const processRefBatch = db.transaction((batch: ScipDocument[]) => {
      for (const doc of batch) {
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
          const calleeName = extractNameFromScipSymbol(occ.symbol);
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
          const isExternal = !calleeId && isExternalSymbolFn(occ.symbol);
          const method = calleeId ? 'scip_definition' : (isExternal ? 'external_definition' : 'unresolved');

          if (refKind === 'type') {
            const typeRefKind = 'other';
            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = symbolInfoMap.get(occ.symbol);
            const refSig = refInfo ? extractSignatureFromDoc(refInfo.documentation[0] ?? '') || null : null;
            const refDefUri = refDef ? pathToFileURL(refDef.filePath).toString() : null;

            try {
              insertTypeRef.run(
                fileId, callerId, calleeId ?? null,
                calleeName, normalizeTypeName(calleeName), typeRefKind,
                line, character, method, refSig,
                refDefUri, refDef?.filePath ?? null, refDef?.line ?? null, refDef?.character ?? null,
                layer, generation,
              );
              typeRefsInserted++;
            } catch {
              refsNoCaller++;
            }
          } else {
            const resolvedCalleeName = calleeName;

            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = symbolInfoMap.get(occ.symbol);
            const refSig = refInfo ? extractSignatureFromDoc(refInfo.documentation[0] ?? '') || null : null;
            const refReturnType = extractReturnType(refSig);
            const refDefUri = refDef ? pathToFileURL(refDef.filePath).toString() : null;

            try {
              insertCallRef.run(
                callerId, fileId, calleeId ?? null, resolvedCalleeName,
                line, character, 'direct', method, refSig, refReturnType,
                refDefUri, refDef?.filePath ?? null, refDef?.line ?? null, refDef?.character ?? null,
                layer, generation,
              );
              refsInserted++;
              if (isExternal) refsExternal++;
            } catch {
              refsNoCaller++;
            }
          }
        }
      }
    });
    for (let batchStart = 0; batchStart < allDocsForBatching.length; batchStart += SCIP_REF_BATCH_SIZE) {
      processRefBatch(allDocsForBatching.slice(batchStart, batchStart + SCIP_REF_BATCH_SIZE));
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
    for (const idx of parsedIndexes) {
      for (const doc of idx.documents) {
        const absPath = resolve(rootDir, doc.relativePath);
        const loreLang = inferLoreLanguage(doc.language, doc.relativePath);
        if (loreLang && fileIdMap.has(absPath)) {
          context.files.push({ path: absPath, language: loreLang });
        }
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
 * Among definitions of the same kind, the first one encountered wins.
 */
export function buildSymbolDefinitionMap(
  parsedIndexes: ReadonlyArray<{ documents: ReadonlyArray<{ relativePath: string; occurrences: ReadonlyArray<{ symbolRoles: number; symbol: string; range: number[] }> }> }>,
  rootDir: string,
): Map<string, { filePath: string; line: number; character: number }> {
  const symbolDefinitions = new Map<string, { filePath: string; line: number; character: number }>();
  // Track which entries came from forward declarations so real definitions can override them.
  const forwardDefs = new Set<string>();
  for (const idx of parsedIndexes) {
    for (const doc of idx.documents) {
      const absPath = resolve(rootDir, doc.relativePath);
      for (const occ of doc.occurrences) {
        if ((occ.symbolRoles & SymbolRole.Definition) !== 0 && occ.symbol && !occ.symbol.startsWith('local ')) {
          const isForward = (occ.symbolRoles & SymbolRole.ForwardDefinition) !== 0;
          const existing = symbolDefinitions.has(occ.symbol);

          if (!existing) {
            symbolDefinitions.set(occ.symbol, {
              filePath: absPath,
              line: occ.range[0] ?? 0,
              character: occ.range[1] ?? 0,
            });
            if (isForward) forwardDefs.add(occ.symbol);
          } else if (!isForward && forwardDefs.has(occ.symbol)) {
            // Real definition overrides a previous forward declaration
            symbolDefinitions.set(occ.symbol, {
              filePath: absPath,
              line: occ.range[0] ?? 0,
              character: occ.range[1] ?? 0,
            });
            forwardDefs.delete(occ.symbol);
          }
        }
      }
    }
  }
  return symbolDefinitions;
}

/**
 * Build a containment index: file_id → sorted array of symbol spans.
 * Used for finding which symbol lexically contains a given source line.
 */
export function buildContainmentIndex(
  rows: Array<{ id: number; file_id: number; start_line: number; end_line: number }>,
): Map<number, SymbolSpan[]> {
  const fileSymbolSpans = new Map<number, SymbolSpan[]>();
  for (const row of rows) {
    let spans = fileSymbolSpans.get(row.file_id);
    if (!spans) {
      spans = [];
      fileSymbolSpans.set(row.file_id, spans);
    }
    spans.push({ id: row.id, startLine: row.start_line, endLine: row.end_line });
  }
  return fileSymbolSpans;
}

/**
 * Find the first symbol span in the containment index that contains the given line.
 * Returns the symbol ID or null if no span contains the line.
 */
export function findContainingSymbol(
  fileSymbolSpans: Map<number, SymbolSpan[]>,
  fileId: number,
  line: number,
): number | null {
  const spans = fileSymbolSpans.get(fileId);
  if (!spans) return null;
  for (const span of spans) {
    if (line >= span.startLine && line <= span.endLine) {
      return span.id;
    }
  }
  return null;
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
