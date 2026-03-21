/**
 * @module indexer/stages/scip-indexer
 *
 * Pipeline stage: for SCIP-covered languages, populate `files`, `symbols`,
 * `symbol_refs`, `type_refs`, `symbol_relationships`, and `file_imports`
 * **directly from the SCIP index** — bypassing tree-sitter entirely.
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
 * SCIP refs are inserted **pre-resolved** with `resolution_method =
 * 'scip_definition'`.  The downstream resolution stage only processes
 * refs from non-SCIP languages.
 *
 * ## Data written
 *
 * Same tables as `SourceIndexStage`: `files`, `symbols`, `symbols_fts`,
 * `symbol_refs`, `type_refs`, `symbol_relationships`, `file_imports`.
 * Additionally populates enrichment columns (type signatures, definition
 * locations) inline during the same pass.
 *
 * ## Pipeline ordering
 *
 * This stage runs **before** `SourceIndexStage`.  It stores which
 * languages and files it handled in `context.scipSourcedLanguages`,
 * `context.scipSourcedFiles`, and `context.scipCoveredLanguages` so
 * `SourceIndexStage` can skip full extraction (but still compute
 * tree-sitter metrics) and `LspEnrichmentStage` knows not to re-enrich
 * these languages.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  SymbolRole,
  type Document as ScipDocument,
  type Occurrence as ScipOccurrence,
  type SymbolInformation as ScipSymbolInformation,
} from '../../scip/scip_pb.js';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../../db/schema.js';
import { normalizeTypeName } from '../../resolution/call-graph.js';
import { SCIP_SUPPORTED_LANGUAGES, resolveScipIndexerRegistry } from '../../scip/registry.js';
import type { EffectiveScipSettings } from '../../scip/config.js';
import { getLogger } from '../../logger.js';
import { extractReturnType } from '../../scip/index-reader.js';
import { getSpecsForLanguage, installScipIndexer } from '../../scip/installer.js';
import { ensureCompilationDatabase } from '../../scip/compdb.js';
import { EXT_TO_LANG } from '../../discovery/walker.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ─── SCIP symbol string → Lore kind mapping ──────────────────────────────────

/**
 * Infer a Lore symbol `kind` from a SCIP symbol string.
 *
 * SCIP symbol syntax:  `<scheme> <package> (<descriptor>)+`
 * Descriptor suffixes:
 *   - `/`  → Namespace (module/package)
 *   - `#`  → Type (class, interface, enum)
 *   - `.`  → Term (variable, constant, property, enum member)
 *   - `().` → Method/Function
 *   - `(name)` → Parameter
 *   - `[name]` → Type parameter
 *   - `name:` → Meta (object property)
 */
function inferKindFromScipSymbol(scipSymbol: string, docHint: string): string {
  // Method/function: ends with ().<any> or just ().
  if (/\(\+?\d*\)\.$/.test(scipSymbol)) {
    // Use doc hint to distinguish constructor
    if (docHint.includes('constructor')) return 'constructor';
    // Check if inside a type — method vs function
    const parts = scipSymbol.split(/(?<=[#/.])/);
    const hasType = parts.some(p => p.endsWith('#'));
    return hasType ? 'method' : 'function';
  }

  // Type: ends with #
  if (scipSymbol.endsWith('#')) {
    if (docHint.includes('interface ')) return 'interface';
    if (docHint.includes('trait ')) return 'interface';
    if (docHint.includes('enum ')) return 'enum';
    if (docHint.includes('type ')) return 'type_alias';
    return 'class';
  }

  // Namespace: ends with /
  if (scipSymbol.endsWith('/')) return 'module';

  // Term: ends with .
  if (scipSymbol.endsWith('.')) {
    if (docHint.includes('(enum member)')) return 'enum_member';
    if (docHint.includes('const ')) return 'constant';
    if (docHint.includes('(property)')) return 'property';
    // scip-clang uses term descriptors for C/C++ functions:
    //   ` $ funcName(hexhash).` — the (hash) indicates a function, not a variable.
    if (/\([0-9a-f]{8,}\)\.$/.test(scipSymbol)) return 'function';
    return 'variable';
  }

  // Meta: ends with :
  if (scipSymbol.endsWith(':')) return 'property';

  // Parameter
  if (scipSymbol.endsWith(')') && !scipSymbol.endsWith(').')) return 'parameter';

  return 'variable';
}

/**
 * Extract a human-readable name from a SCIP symbol string.
 *
 * E.g. `scip-typescript npm pkg 1.0 src/\`file.ts\`/MyClass#myMethod().`
 * → `myMethod`
 */
function extractNameFromScipSymbol(scipSymbol: string): string {
  // Strip trailing descriptor suffix (., #, /, :, etc.)
  let cleaned = scipSymbol.replace(/[.#/:]$/, '');

  // For methods, strip the disambiguator: `name(+1).` → `name`
  cleaned = cleaned.replace(/\(\+?\d*\)$/, '');

  // scip-clang uses ` $ name(hash)` for C/C++ symbols — strip the hash.
  // E.g., ` $ parse_analyze_fixedparams(39d222e79bbfb7c0)` → `parse_analyze_fixedparams`
  cleaned = cleaned.replace(/\([0-9a-f]{8,}\)$/, '');

  // Get the last descriptor's name
  // Descriptors are separated by ., #, /, :, or ()
  const parts = cleaned.split(/[.#/:]/);
  let name = parts[parts.length - 1] || '';

  // Remove backtick escaping
  name = name.replace(/`/g, '');

  // Strip leading ` $ ` prefix used by scip-clang
  name = name.replace(/^\s*\$\s*/, '');

  // Handle parameter descriptors like `(paramName)`
  if (name.startsWith('(') && name.endsWith(')')) {
    name = name.slice(1, -1);
  }

  return name || scipSymbol;
}

/**
 * Extract a signature from SCIP SymbolInformation documentation.
 *
 * scip-typescript puts the TypeScript type signature in the first
 * documentation entry wrapped in a markdown code fence.
 */
function extractSignatureFromDoc(doc: string): string {
  const cleaned = doc
    .replace(/```[a-z0-9_+-]*\n/gi, '')
    .replace(/```/g, '')
    .trim();
  return cleaned || '';
}

// ─── Symbol-span fallback ─────────────────────────────────────────────────────

/**
 * Estimate the end line of a symbol whose `enclosing_range` was absent.
 *
 * Strategy: from the definition line, scan forward for curly-brace blocks
 * (classes, functions, structs in C-family / Rust / Go / Java / etc.) or
 * indentation-based blocks (Python).  If nothing works, scan to the next
 * definition or EOF.
 */
function estimateSymbolEndLine(
  sourceLines: string[],
  defLine: number,
  nextDefLine: number | null,
): number {
  if (defLine >= sourceLines.length) return defLine;

  const src = sourceLines[defLine]!;

  // Python-style: indentation-based scope.
  // Detect lines ending with ":" (def, class, if, etc.).
  if (/:\s*(#.*)?$/.test(src)) {
    // Measure the indentation of the definition line itself.
    const baseIndent = src.match(/^(\s*)/)![1]!.length;
    let last = defLine;
    for (let i = defLine + 1; i < sourceLines.length; i++) {
      const line = sourceLines[i]!;
      // Skip blank / comment-only lines
      if (/^\s*$/.test(line) || /^\s*#/.test(line)) { last = i; continue; }
      const indent = line.match(/^(\s*)/)![1]!.length;
      if (indent <= baseIndent) break;
      last = i;
    }
    if (last > defLine) return last;
  }

  // Brace-counting: scan forward from the first '{' on or after defLine.
  let braceStart = -1;
  for (let i = defLine; i < Math.min(defLine + 5, sourceLines.length); i++) {
    if (sourceLines[i]!.includes('{')) { braceStart = i; break; }
  }
  if (braceStart >= 0) {
    let depth = 0;
    for (let i = braceStart; i < sourceLines.length; i++) {
      const line = sourceLines[i]!;
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return i; }
      }
    }
  }

  // Fallback: extend to just before the next definition, or EOF.
  if (nextDefLine !== null && nextDefLine > defLine) {
    return nextDefLine - 1;
  }
  return Math.min(defLine + 20, sourceLines.length - 1);
}

// ─── Type-ref kind inference ──────────────────────────────────────────────────

/**
 * Infer a `ref_kind` for a type reference from its surrounding source context.
 *
 * Reads the source line at `refLine` and applies simple pattern matching to
 * distinguish parameter, return, field, variable, generic_arg and bound usages.
 * Falls back to `'other'` when the context is ambiguous.
 */
function inferTypeRefKind(sourceLines: string[], refLine: number, refChar: number): string {
  if (refLine >= sourceLines.length) return 'other';
  const line = sourceLines[refLine]!;
  const before = line.slice(0, refChar);

  // Return type: preceded by "->" or "=>" or "): "
  if (/(->|=>)\s*$/.test(before)) return 'return';
  if (/\)\s*:\s*$/.test(before)) return 'return';

  // Type bound: "where T:" or "<T extends" patterns
  if (/\bwhere\s+\w+\s*:\s*$/.test(before)) return 'bound';
  if (/<[^>]*\b(extends|:)\s*$/.test(before)) return 'bound';

  // Generic argument: preceded by '<' or ',' inside angle brackets
  if (/<[^>]*$/.test(before) || /^[^<]*>/.test(line.slice(refChar))) {
    return 'generic_arg';
  }

  // Parameter: inside a parenthesized parameter list with annotation
  if (/[(,]\s*\w+\s*:\s*$/.test(before)) return 'parameter';
  // Go-style: "func f(x Foo" — identifier then space then type, inside parens
  if (/[(,]\s*\w+\s+$/.test(before) && /^[^)]*\)/.test(line.slice(refChar))) return 'parameter';

  // Variable: "let x: T", "const x: T", "var x: T" at statement level
  if (/^\s*(let|const|var|val)\s+\w+\s*:\s*$/.test(before)) return 'variable';

  // Field / property: line starts with an access modifier or class-body keyword
  const trimmed = line.trimStart();
  if (/^(public|private|protected|readonly|static|final)\s/.test(trimmed)) {
    if (!before.includes('(')) return 'field';
  }

  return 'other';
}

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
    const indexBuffers = await this.loadScipIndexes(context.scip, rootDir, staleLanguages);
    if (indexBuffers.length === 0) {
      log.indexing('scip-indexer: no SCIP index available');
      return;
    }

    // Parse all SCIP index buffers and combine their documents
    const allDocuments: import('../../scip/scip_pb.js').Document[] = [];
    const allExternalSymbols: import('../../scip/scip_pb.js').SymbolInformation[] = [];
    for (const buf of indexBuffers) {
      const parsed = fromBinary(IndexSchema, buf);
      allDocuments.push(...parsed.documents);
      allExternalSymbols.push(...parsed.externalSymbols);
    }

    const scipIndex = { documents: allDocuments, externalSymbols: allExternalSymbols };
    log.indexing('scip-indexer: loaded index', {
      documents: scipIndex.documents.length,
      externalSymbols: scipIndex.externalSymbols.length,
    });

    if (scipIndex.documents.length === 0) return;

    // Determine which languages are covered
    const coveredLanguages = new Set<string>();
    const coveredFiles = new Set<string>();
    for (const doc of scipIndex.documents) {
      // scip-typescript (and some other indexers) leave language blank;
      // fall back to file-extension inference.
      const loreLang = inferLoreLanguage(doc.language, doc.relativePath);
      if (loreLang) coveredLanguages.add(loreLang);
    }

    log.indexing('scip-indexer: languages covered', { languages: [...coveredLanguages] });

    // Determine the project's SCIP symbol prefix so we can distinguish
    // internal symbols from external ones (stdlib, node_modules, etc.).
    // Internal symbols are those whose SCIP string starts with the same
    // scheme + package as symbols defined in the index's own documents.
    const internalPrefixes = new Set<string>();
    for (const doc of scipIndex.documents) {
      for (const sym of doc.symbols) {
        if (sym.symbol && !sym.symbol.startsWith('local ')) {
          // Extract "scheme package" prefix (first 4 space-separated tokens)
          const parts = sym.symbol.split(' ');
          if (parts.length >= 4) {
            internalPrefixes.add(parts.slice(0, 4).join(' '));
          }
          break; // One per document is enough
        }
      }
    }

    /** Is this symbol from an external package (node_modules, stdlib, etc.)? */
    function isExternalSymbol(scipSymbol: string): boolean {
      if (internalPrefixes.size === 0) return false;
      for (const prefix of internalPrefixes) {
        if (scipSymbol.startsWith(prefix)) return false;
      }
      return true;
    }

    // Build a global SCIP symbol → definition location map
    const symbolDefinitions = new Map<string, { filePath: string; line: number; character: number }>();
    for (const doc of scipIndex.documents) {
      const absPath = resolve(rootDir, doc.relativePath);
      for (const occ of doc.occurrences) {
        if ((occ.symbolRoles & SymbolRole.Definition) !== 0 && occ.symbol && !occ.symbol.startsWith('local ')) {
          if (!symbolDefinitions.has(occ.symbol)) {
            symbolDefinitions.set(occ.symbol, {
              filePath: absPath,
              line: occ.range[0] ?? 0,
              character: occ.range[1] ?? 0,
            });
          }
        }
      }
    }

    // Build a SymbolInformation map for signatures/docs
    const symbolInfoMap = new Map<string, ScipSymbolInformation>();
    for (const doc of scipIndex.documents) {
      for (const sym of doc.symbols) {
        if (sym.symbol) symbolInfoMap.set(sym.symbol, sym);
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
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment, resolved_type_signature, resolved_return_type, definition_uri, definition_path, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, resolved_type_signature, resolved_return_type, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTypeRef = db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method, resolved_type_signature, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    const processDocuments = db.transaction(() => {
      for (const doc of scipIndex.documents) {
        const absPath = resolve(rootDir, doc.relativePath);
        const loreLang = inferLoreLanguage(doc.language, doc.relativePath);
        if (!loreLang) continue;

        // Read source file
        let source: string;
        try {
          source = fs.readFileSync(absPath, 'utf8');
        } catch {
          continue;
        }
        // Cache for downstream stages (metrics computation, enrichment).
        context.sourceCache.set(absPath, source);

        const sizeBytes = Buffer.byteLength(source, 'utf8');
        const hash = crypto.createHash('sha256').update(source).digest('hex');

        // Delete existing data for this file (like SourceIndexStage does)
        const existing = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(absPath, branch) as
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
        const sourceLines = source.split('\n');
        const docDefs = new Map<string, { line: number; character: number; startLine: number; endLine: number }>();

        // First collect all definition lines so we can order them for fallback
        const defOccs: Array<{ symbol: string; line: number; character: number; enclosingRange: number[] }> = [];
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Definition) === 0) continue;
          if (!occ.symbol || occ.symbol.startsWith('local ')) continue;
          defOccs.push({ symbol: occ.symbol, line: occ.range[0] ?? 0, character: occ.range[1] ?? 0, enclosingRange: [...occ.enclosingRange] });
        }
        // Sort by line so we know the "next definition" for span estimation
        defOccs.sort((a, b) => a.line - b.line);

        for (let di = 0; di < defOccs.length; di++) {
          const occ = defOccs[di]!;
          const { symbol, line, character, enclosingRange } = occ;

          // Use enclosing_range for span; fall back to definition line.
          // Tree-sitter will patch end_line in the SourceIndexStage metrics pass.
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
            // No enclosing_range — estimate from source.
            // Tree-sitter will refine this in the SourceIndexStage metrics pass.
            const nextDefLine = di + 1 < defOccs.length ? defOccs[di + 1]!.line : null;
            endLine = estimateSymbolEndLine(sourceLines, line, nextDefLine);
          }

          // Keep the first definition per symbol in this file
          if (!docDefs.has(symbol)) {
            docDefs.set(symbol, { line, character, startLine, endLine });
          }
        }

        // Insert symbols from SymbolInformation + definition occurrences
        for (const symInfo of doc.symbols) {
          if (!symInfo.symbol || symInfo.symbol.startsWith('local ')) continue;

          const defLoc = docDefs.get(symInfo.symbol);
          if (!defLoc) continue; // No definition occurrence for this symbol info

          const name = symInfo.displayName || extractNameFromScipSymbol(symInfo.symbol);
          const firstDoc = symInfo.documentation[0] ?? '';
          const docHint = firstDoc.toLowerCase();
          const kind = inferKindFromScipSymbol(symInfo.symbol, docHint);

          // Skip parameters, type parameters, and module-level namespace symbols
          if (kind === 'parameter' || kind === 'module') continue;

          const signature = extractSignatureFromDoc(firstDoc);
          const docComment = symInfo.documentation.slice(1).join('\n').trim() || null;

          // Compute enrichment data inline (definition + type signature)
          const resolvedTypeSig = signature || null;
          const resolvedReturnType = extractReturnType(resolvedTypeSig);
          const definitionUri = pathToFileURL(absPath).toString();

          const info = insertSymbol.run(
            fileId, name, kind,
            defLoc.startLine, defLoc.endLine,
            signature || null, docComment,
            resolvedTypeSig, resolvedReturnType, definitionUri, absPath,
            layer, generation,
          ) as { lastInsertRowid: number | bigint };
          const loreId = Number(info.lastInsertRowid);
          scipToLoreId.set(symInfo.symbol, loreId);
        }

        // Insert imports (from Import-role occurrences)
        // Prefer the actual import path from source; fall back to SCIP package.
        // Use symbolDefinitions to pre-resolve imports to target file IDs.
        const seenImports = new Map<string, number | null>(); // rawImport → resolved file ID
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Import) !== 0 && occ.symbol) {
            const importLine = occ.range[0] ?? 0;
            const srcImport = importLine < sourceLines.length
              ? extractImportPathFromSource(sourceLines[importLine]!)
              : null;
            let rawImport: string;
            if (srcImport) {
              rawImport = srcImport;
            } else {
              // Fall back to SCIP package descriptor
              const parts = occ.symbol.split(' ');
              rawImport = parts.length >= 4 ? parts[3]! : occ.symbol;
            }
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
          const sourceName = symInfo.displayName || extractNameFromScipSymbol(symInfo.symbol);

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
                ? inferKindFromScipSymbol(rel.symbol, (targetInfo.documentation[0] ?? '').toLowerCase())
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
    processDocuments();

    log.indexing('scip-indexer: symbols inserted', {
      files: fileIdMap.size,
      symbols: scipToLoreId.size,
    });

    // Pass 2: Build a containment index for caller resolution
    // For each file, sort symbols by span so we can find the narrowest
    // enclosing symbol for any position.
    const fileSymbolSpans = new Map<number, Array<{ id: number; startLine: number; endLine: number }>>();
    {
      const rows = db.prepare(
        `SELECT s.id, s.file_id, s.start_line, s.end_line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.branch = ?
         ORDER BY s.file_id, (s.end_line - s.start_line) ASC`,
      ).all(branch) as Array<{ id: number; file_id: number; start_line: number; end_line: number }>;

      for (const row of rows) {
        let spans = fileSymbolSpans.get(row.file_id);
        if (!spans) {
          spans = [];
          fileSymbolSpans.set(row.file_id, spans);
        }
        spans.push({ id: row.id, startLine: row.start_line, endLine: row.end_line });
      }
    }

    /** Find the narrowest enclosing symbol for a given line in a file. */
    function findContainingSymbol(fileId: number, line: number): number | null {
      const spans = fileSymbolSpans.get(fileId);
      if (!spans) return null;
      // Spans are sorted narrowest-first, so first match is best
      for (const span of spans) {
        if (line >= span.startLine && line <= span.endLine) {
          return span.id;
        }
      }
      return null;
    }

    // Pass 3: Insert call refs and type refs from reference occurrences
    //
    // SCIP tracks every identifier occurrence (calls, reads, type annotations,
    // namespace imports, etc.).  Only a subset belongs in Lore's graph:
    //   - Method/function refs  → symbol_refs  (call edges)
    //   - Type refs             → type_refs    (type usage edges)
    //   - Everything else       → skipped      (reads, imports, namespaces)
    let refsInserted = 0;
    let refsExternal = 0;
    let refsNoCaller = 0;
    let refsLocal = 0;
    let refsSkippedNonCall = 0;
    let typeRefsInserted = 0;

    const processRefs = db.transaction(() => {
      for (const doc of scipIndex.documents) {
        const absPath = resolve(rootDir, doc.relativePath);
        const fileId = fileIdMap.get(absPath);
        if (!fileId) continue;

        // Read source for receiver-chain reconstruction.
        let source: string | null = null;
        try { source = fs.readFileSync(absPath, 'utf8'); } catch { /* skip */ }
        const sourceLines = source?.split('\n') ?? [];

        // Build a per-line index of all occurrences for receiver lookup.
        const occsByLine = new Map<number, Array<{ startChar: number; endChar: number; symbol: string }>>();
        for (const o of doc.occurrences) {
          const ln = o.range[0] ?? 0;
          const sc = o.range[1] ?? 0;
          const ec = o.range.length >= 4 ? (o.range[3] ?? 0) : (o.range[2] ?? 0);
          let list = occsByLine.get(ln);
          if (!list) { list = []; occsByLine.set(ln, list); }
          list.push({ startChar: sc, endChar: ec, symbol: o.symbol });
        }

        for (const occ of doc.occurrences) {
          // Skip definitions — we only want references
          if ((occ.symbolRoles & SymbolRole.Definition) !== 0) continue;
          if (!occ.symbol) continue;

          // Skip locals
          if (occ.symbol.startsWith('local ')) {
            refsLocal++;
            continue;
          }

          // Classify the reference by the SCIP descriptor suffix
          const refKind = classifyScipReference(occ.symbol);
          if (refKind === 'skip') {
            refsSkippedNonCall++;
            continue;
          }

          const line = occ.range[0] ?? 0;
          const character = occ.range[1] ?? 0;

          // Find the caller (containing symbol)
          const callerId = findContainingSymbol(fileId, line);
          if (!callerId) {
            refsNoCaller++;
            continue;
          }

          // Find the callee (definition of the referenced symbol)
          const calleeId = scipToLoreId.get(occ.symbol) ?? null;
          let calleeName = extractNameFromScipSymbol(occ.symbol);
          const isExternal = !calleeId && isExternalSymbol(occ.symbol);
          const method = calleeId ? 'scip_definition' : (isExternal ? 'external_definition' : 'unresolved');

          // Reconstruct member-access callee_name (e.g. "db.prepare")
          // by checking if there's a receiver occurrence immediately before
          // the method on the same line (receiver ends at or near char-1).
          if (refKind === 'call' && sourceLines.length > line) {
            const srcLine = sourceLines[line]!;
            // The dot is at character-1 (e.g., `db.prepare` → dot at char 2, method at char 3)
            if (character > 0 && srcLine[character - 1] === '.') {
              const lineOccs = occsByLine.get(line);
              if (lineOccs) {
                // Find the occurrence ending right before the dot
                const receiver = lineOccs.find(o =>
                  o.endChar >= character - 2 && o.endChar <= character
                  && o.startChar < character
                );
                if (receiver) {
                  // Extract the receiver text from source
                  const receiverText = srcLine.slice(receiver.startChar, receiver.endChar);
                  if (receiverText) {
                    calleeName = receiverText + '.' + calleeName;
                  }
                }
              }
            }
          }

          if (refKind === 'type') {
            const typeRefKind = inferTypeRefKind(sourceLines, line, character);

            // Resolve enrichment metadata for the referenced type
            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = symbolInfoMap.get(occ.symbol);
            const refSig = refInfo ? extractSignatureFromDoc(refInfo.documentation[0] ?? '') || null : null;
            const refDefUri = refDef ? pathToFileURL(refDef.filePath).toString() : null;

            try {
              insertTypeRef.run(
                fileId,
                callerId,
                calleeId ?? null,
                calleeName,
                normalizeTypeName(calleeName),
                typeRefKind,
                line,
                character,
                method,
                refSig,
                refDefUri,
                refDef?.filePath ?? null,
                refDef?.line ?? null,
                refDef?.character ?? null,
                layer, generation,
              );
              typeRefsInserted++;
            } catch {
              // FK constraint failure — skip this ref
              refsNoCaller++;
            }
          } else {
            // refKind === 'call'

            // Skip if callee can't be resolved — FK constraint requires valid callee_id
            if (!calleeId) {
              refsNoCaller++;
              continue;
            }

            // Resolve enrichment metadata for the callee
            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = symbolInfoMap.get(occ.symbol);
            const refSig = refInfo ? extractSignatureFromDoc(refInfo.documentation[0] ?? '') || null : null;
            const refReturnType = extractReturnType(refSig);
            const refDefUri = refDef ? pathToFileURL(refDef.filePath).toString() : null;

            try {
              insertCallRef.run(
                callerId,
                fileId,
                calleeId,
                calleeName,
                line,
                character,
                'direct',
                method,
                refSig,
                refReturnType,
                refDefUri,
                refDef?.filePath ?? null,
                refDef?.line ?? null,
                refDef?.character ?? null,
                layer, generation,
              );
              refsInserted++;
              if (isExternal) refsExternal++;
            } catch {
              // FK constraint failure — skip this ref
              refsNoCaller++;
            }
          }
        }
      }
    });
    processRefs();

    log.indexing('scip-indexer: refs inserted', {
      callRefs: refsInserted,
      typeRefs: typeRefsInserted,
      external: refsExternal,
      noCaller: refsNoCaller,
      skippedLocal: refsLocal,
      skippedNonCall: refsSkippedNonCall,
    });

    // Pass 4: Materialize virtual dispatch edges
    //
    // When a caller invokes an interface method (e.g., `builder.Build()`),
    // SCIP records a call edge to the *interface* method symbol. Concrete
    // implementations (e.g., `contextImpl.Build()`) are linked via
    // `implements` relationships at the type level but have no direct
    // call edges from callers that go through the interface.
    //
    // This pass bridges that gap: for each `implements` relationship
    // between types, it matches methods by name and inserts additional
    // `symbol_refs` rows with `call_kind = 'virtual_dispatch'` so that
    // both `lore_graph` and `lore_dependents` surface these edges.
    const virtualDispatchEdges = materializeVirtualDispatch(
      db, scipToLoreId, symbolInfoMap, symbolDefinitions, layer, generation, log,
    );

    // Communicate coverage to downstream stages
    context.scipSourcedLanguages = coveredLanguages;
    context.scipSourcedFiles = coveredFiles;
    // Also set scipCoveredLanguages so that LspEnrichmentStage skips
    // languages already fully enriched by this single SCIP pass.
    context.scipCoveredLanguages = coveredLanguages;

    // Add SCIP-sourced files to context.files so later stages process them
    for (const doc of scipIndex.documents) {
      const absPath = resolve(rootDir, doc.relativePath);
      const loreLang = inferLoreLanguage(doc.language, doc.relativePath);
      if (loreLang && fileIdMap.has(absPath)) {
        context.files.push({ path: absPath, language: loreLang });
      }
    }
  }

  async dispose(): Promise<void> {
    // No persistent resources to clean up
  }

  // ─── SCIP index loading ──────────────────────────────────────────────────

  private async loadScipIndexes(
    settings: EffectiveScipSettings,
    rootDir: string,
    staleLanguages: Set<string> | null = null,
  ): Promise<Uint8Array[]> {
    // Try pre-computed index directory first
    if (settings.indexDir) {
      const precomputed: Uint8Array[] = [];
      // When staleLanguages is set, prefer per-language index files so
      // we only load the languages that actually need re-processing.
      if (staleLanguages) {
        for (const lang of staleLanguages) {
          const candidate = join(rootDir, settings.indexDir, `${lang}.scip`);
          if (existsSync(candidate)) {
            precomputed.push(readFileSync(candidate));
          }
        }
      }
      if (precomputed.length === 0) {
        const candidates = [
          join(rootDir, settings.indexDir, 'index.scip'),
          ...['typescript', 'javascript', 'python', 'java', 'rust', 'c', 'cpp', 'csharp', 'ruby', 'php', 'go', 'dart'].map(
            lang => join(rootDir, settings.indexDir!, `${lang}.scip`),
          ),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            precomputed.push(readFileSync(candidate));
          }
        }
      }
      if (precomputed.length > 0) return precomputed;
    }

    // Try running an indexer
    let resolvedIndexers = resolveScipIndexerRegistry(settings.indexers);
    const log = getLogger();

    // Check if any indexers are available; if not, try auto-installing
    const requestedLanguages = staleLanguages ?? new Set(Object.keys(resolvedIndexers));
    const hasAvailable = [...requestedLanguages].some(
      (lang) => resolvedIndexers[lang]?.available,
    );
    if (!hasAvailable) {
      const attempted = new Set<string>();
      for (const lang of requestedLanguages) {
        for (const spec of getSpecsForLanguage(lang)) {
          if (attempted.has(spec.command)) continue;
          attempted.add(spec.command);
          log.indexing(`scip-indexer: auto-installing ${spec.command} for ${lang}...`);
          const result = await installScipIndexer(spec);
          if (result.installed) {
            log.indexing(`scip-indexer: installed ${spec.command} at ${result.path}`);
          } else {
            log.indexing(`scip-indexer: could not install ${spec.command}: ${result.error ?? 'unknown'}`);
          }
        }
      }
      // Re-resolve after installation
      resolvedIndexers = resolveScipIndexerRegistry(settings.indexers);
    }

    // Determine which SCIP-supported languages actually exist in the project
    // so we don't waste time running irrelevant indexers (e.g., scip-go on a C project).
    const projectLanguages = staleLanguages ?? detectProjectLanguages(resolve(rootDir));

    // Run all available indexers and merge results — don't stop at the first success.
    // Group by shared command to avoid running the same indexer twice (e.g., scip-java for java/scala/kotlin).
    const commandsRun = new Set<string>();
    const indexBuffers: Uint8Array[] = [];

    for (const [lang, indexer] of Object.entries(resolvedIndexers)) {
      if (!indexer.available) continue;
      // Skip languages not present in the project
      if (!projectLanguages.has(lang)) continue;
      // Don't run the same command twice (e.g., scip-clang for both c and cpp)
      if (commandsRun.has(indexer.command)) continue;
      commandsRun.add(indexer.command);
      try {
        const outputPath = resolve(rootDir, `.lore-scip-${lang}.scip`);
        let args = indexer.args.map(a => a.replace(/\{output\}/g, outputPath));
        const cwd = resolve(rootDir);

        // For C/C++: ensure a compile_commands.json exists and pass it to scip-clang
        if ((lang === 'c' || lang === 'cpp') && args.some(a => a.includes('{compdb}'))) {
          const compdb = await ensureCompilationDatabase(rootDir, settings.timeoutMs);
          if (!compdb.path) {
            log.indexing(`scip-indexer: no compile_commands.json for ${lang}, skipping`);
            continue;
          }
          args = args.map(a => a.replace(/\{compdb\}/g, compdb.path!));
        }

        // For TypeScript: generate a broad tsconfig so scip-typescript
        // indexes ALL .ts files (including tests), not just those in the
        // project's tsconfig "include" (which typically excludes tests).
        let tempTsconfigPath: string | null = null;
        if (lang === 'typescript') {
          tempTsconfigPath = createLoreScipTsconfig(rootDir);
          if (tempTsconfigPath) {
            args.push(tempTsconfigPath);
          }
        }

        // scip-clang needs a longer timeout for large C projects
        const indexerTimeout = (lang === 'c' || lang === 'cpp')
          ? Math.max(settings.timeoutMs, 600_000)
          : settings.timeoutMs;

        const execFileAsync = promisify(execFile);
        const executablePath = indexer.resolvedPath ?? indexer.command;
        try {
          await execFileAsync(executablePath, args, {
            cwd,
            timeout: indexerTimeout,
          });
        } finally {
          if (tempTsconfigPath) {
            try { fs.unlinkSync(tempTsconfigPath); } catch { /* best effort */ }
          }
        }

        // Check for output
        for (const candidate of [outputPath, resolve(rootDir, 'index.scip')]) {
          if (existsSync(candidate)) {
            const data = readFileSync(candidate);
            try { fs.unlinkSync(candidate); } catch { /* best effort */ }
            indexBuffers.push(data);
            break;
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.indexing(`scip-indexer: indexer failed for ${lang}: ${msg}`);
        continue;
      }
    }

    return indexBuffers;
  }
}

// ─── Temporary tsconfig for broad SCIP indexing ─────────────────────────────

/** Fields that only affect build output, not type-checking or SCIP indexing. */
const TSCONFIG_BUILD_ONLY_FIELDS = [
  'outDir', 'rootDir', 'declaration', 'declarationMap', 'declarationDir',
  'sourceMap', 'inlineSourceMap', 'inlineSources', 'composite',
  'tsBuildInfoFile', 'emitDeclarationOnly',
] as const;

/**
 * Generate a temporary tsconfig that includes **all** `.ts`/`.tsx` files
 * in the project, so `scip-typescript` indexes tests and other files
 * excluded by the project's production tsconfig.
 *
 * The file is written to `os.tmpdir()` so the indexed repo is never mutated.
 * Include/exclude globs use absolute paths rooted at `rootDir` so
 * `scip-typescript` resolves source files correctly even though the
 * tsconfig lives elsewhere.
 *
 * Strips build-only compiler options (`outDir`, `rootDir`, `declaration`,
 * etc.) that would conflict with the broad `include` and are irrelevant
 * for SCIP analysis.  Preserves all type-checking options (`strict`,
 * `paths`, `baseUrl`, etc.) so SCIP still resolves types correctly.
 *
 * Returns the path to the temp file, or `null` if no tsconfig exists.
 */
export function createLoreScipTsconfig(rootDir: string): string | null {
  const log = getLogger();
  const tsconfigPath = join(rootDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    const compilerOptions = { ...(raw.compilerOptions ?? {}) };

    // Strip build-only fields
    for (const field of TSCONFIG_BUILD_ONLY_FIELDS) {
      delete compilerOptions[field];
    }

    // Use absolute paths so the tsconfig works from tmpdir
    const absRoot = resolve(rootDir);
    const loreTsconfig = {
      compilerOptions,
      include: [join(absRoot, '**/*.ts'), join(absRoot, '**/*.tsx')],
      exclude: (raw.exclude ?? ['node_modules']).map((e: string) => join(absRoot, e)),
    };

    const outPath = join(tmpdir(), `lore-scip-${crypto.randomUUID()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(loreTsconfig, null, 2));
    log.debug('scip', `generated broad tsconfig for SCIP: ${outPath}`);
    return outPath;
  } catch {
    return null;
  }
}

// ─── SCIP reference classification ──────────────────────────────────────────

/**
 * Classify a SCIP symbol reference into the graph edge type it represents.
 *
 * SCIP descriptor suffixes:
 *   `().`  → Method/Function → call edge (symbol_refs)
 *   `#`    → Type            → type edge (type_refs)
 *   `.`    → Term (variable, property, constant, enum member) → skip
 *   `/`    → Namespace (module) → skip
 *   `:`    → Meta (object property) → skip
 *   `)`    → Parameter → skip
 *   `]`    → Type parameter → type edge (type_refs)
 */
function classifyScipReference(scipSymbol: string): 'call' | 'type' | 'skip' {
  // Method/function: ends with ().  or (+N).  (with disambiguator)
  if (/\(\+?\d*\)\.$/.test(scipSymbol)) return 'call';

  // scip-clang C/C++ functions: term descriptors ending with `(hexhash).`
  // E.g., `$ parse_analyze_fixedparams(39d222e79bbfb7c0).`
  if (/\([0-9a-f]{8,}\)\.$/.test(scipSymbol)) return 'call';

  // Type: ends with #
  if (scipSymbol.endsWith('#')) return 'type';

  // Type parameter: ends with ]
  if (scipSymbol.endsWith(']')) return 'type';

  // Term (variable, property, constant, enum member): ends with .
  // Namespace: ends with /
  // Meta (object property): ends with :
  // Parameter: ends with )
  // All of these are reads/imports/structural — not call or type edges.
  return 'skip';
}

// ─── Import path extraction ─────────────────────────────────────────────────

/**
 * Extract the actual import/require path from a source line.
 *
 * Handles common patterns across languages:
 * - JS/TS: `import ... from 'path'`, `require('path')`
 * - Python: `import path`, `from path import ...`
 * - Go: `"path"`  (inside import block)
 * - Java/Kotlin/Scala: `import path.to.Class`
 * - Rust: `use path::to::item`
 * - C/C++: `#include "path"` or `#include <path>`
 * - Ruby: `require 'path'`, `require_relative 'path'`
 * - PHP: `use Path\\To\\Class`
 * - C#: `using Namespace.Name`
 * - Dart: `import 'path'`
 *
 * Returns `null` when no recognizable import pattern is found.
 */
function extractImportPathFromSource(line: string): string | null {
  const trimmed = line.trim();

  // JS/TS: import ... from 'path' | import 'path' | require('path') | import('path')
  let m = trimmed.match(/\bfrom\s+['"]([^'"]+)['"]/);
  if (m) return m[1]!;
  m = trimmed.match(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (m) return m[1]!;
  m = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
  if (m) return m[1]!;
  m = trimmed.match(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (m) return m[1]!;

  // C/C++: #include "path" | #include <path>
  m = trimmed.match(/^#\s*include\s*[<"]([^>"]+)[>"]/);
  if (m) return m[1]!;

  // Python: from X import ... | import X
  m = trimmed.match(/^from\s+([\w.]+)\s+import\b/);
  if (m) return m[1]!;

  // C#: using Namespace.Name;
  m = trimmed.match(/^using\s+(?:static\s+)?([\w.]+)\s*;/);
  if (m) return m[1]!;

  // Ruby: require 'path' | require_relative 'path'
  m = trimmed.match(/^require(?:_relative)?\s+['"]([^'"]+)['"]/);
  if (m) return m[1]!;

  // Java/Kotlin/Scala: import [static] path.to.Class (dotted path, no quotes)
  m = trimmed.match(/^import\s+(?:static\s+)?([\w.*]+)/);
  if (m) return m[1]!;

  // Rust: use path::to::item (contains ::)
  m = trimmed.match(/^use\s+([\w:]+::[\w:]+)/);
  if (m) return m[1]!.replace(/::/g, '/');

  // PHP: use Path\To\Class (contains backslash)
  m = trimmed.match(/^use\s+([\w\\]+\\[\w\\]+)/);
  if (m) return m[1]!;

  // Go: "path/to/pkg" inside import block (bare quoted string)
  m = trimmed.match(/^\s*(?:\w+\s+)?["']([^"']+)["']/);
  if (m && !trimmed.startsWith('import') && !trimmed.startsWith('from')) return m[1]!;

  return null;
}

// ─── SCIP language detection ────────────────────────────────────────────────

const SCIP_LANG_MAP: Record<string, string> = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  python: 'python',
  java: 'java',
  scala: 'scala',
  kotlin: 'kotlin',
  rust: 'rust',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
  'c#': 'csharp',
  csharp: 'csharp',
  visualbasic: 'csharp',
  ruby: 'ruby',
  php: 'php',
  go: 'go',
  dart: 'dart',
};

/**
 * Quick scan of the project root to detect which SCIP-supported languages
 * are present.  Checks for telltale file extensions and build files.
 * Only scans top-level + one directory deep to stay fast.
 */
function detectProjectLanguages(rootDir: string): Set<string> {
  const found = new Set<string>();
  const langIndicators: Record<string, string[]> = {
    typescript: ['tsconfig.json', 'package.json'],
    python: ['setup.py', 'pyproject.toml', 'requirements.txt'],
    java:   ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    rust:   ['Cargo.toml'],
    c:      ['Makefile', 'CMakeLists.txt', 'meson.build', 'configure', 'configure.ac'],
    cpp:    ['CMakeLists.txt', 'meson.build'],
    csharp: ['.csproj', '.sln'],
    ruby:   ['Gemfile'],
    go:     ['go.mod'],
    php:    ['composer.json'],
    dart:   ['pubspec.yaml'],
  };

  // Check for language indicator files at the root
  for (const [lang, indicators] of Object.entries(langIndicators)) {
    for (const indicator of indicators) {
      if (existsSync(join(rootDir, indicator))) {
        found.add(lang);
        break;
      }
    }
  }

  // Quick extension scan: read first-level directory entries
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        const lang = EXT_TO_LANG[ext];
        if (lang && SCIP_SUPPORTED_LANGUAGES.has(lang)) found.add(lang);
      } else if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        // One level deep
        try {
          const subEntries = fs.readdirSync(join(rootDir, entry.name), { withFileTypes: true });
          for (const sub of subEntries.slice(0, 50)) { // Limit to avoid scanning huge dirs
            if (sub.isFile()) {
              const ext = sub.name.slice(sub.name.lastIndexOf('.')).toLowerCase();
              const lang = EXT_TO_LANG[ext];
              if (lang && SCIP_SUPPORTED_LANGUAGES.has(lang)) found.add(lang);
            }
          }
        } catch { /* ignore permission errors */ }
      }
    }
  } catch { /* ignore */ }

  return found;
}

// ─── Virtual dispatch materialization ─────────────────────────────────────────

/**
 * Extract the parent type's SCIP symbol from a method's SCIP symbol.
 *
 * SCIP method symbols look like: `<scheme> <package> <...>TypeName#MethodName().`
 * The parent type symbol is the prefix up to and including the `#`.
 *
 * Returns `null` if the symbol doesn't appear to be a method inside a type.
 */
function extractParentTypeSymbol(scipSymbol: string): string | null {
  // Match everything up to the last `#` followed by a method descriptor
  const hashIdx = scipSymbol.lastIndexOf('#');
  if (hashIdx < 0) return null;
  // Verify what follows the # looks like a method: `MethodName().`
  const afterHash = scipSymbol.slice(hashIdx + 1);
  if (!/\w/.test(afterHash)) return null;
  return scipSymbol.slice(0, hashIdx + 1);
}

/**
 * Extract the method descriptor portion after the type's `#`.
 *
 * E.g., `...contextImpl#Build().` → `Build().`
 */
function extractMethodDescriptor(scipSymbol: string): string | null {
  const hashIdx = scipSymbol.lastIndexOf('#');
  if (hashIdx < 0) return null;
  return scipSymbol.slice(hashIdx + 1);
}

/**
 * Materialize virtual dispatch edges in `symbol_refs`.
 *
 * For each `implements` relationship between types (concrete → interface),
 * matches methods by name and inserts `virtual_dispatch` call edges so
 * that callers of interface methods are also recorded as callers of the
 * corresponding concrete implementations.
 *
 * Returns the number of edges inserted.
 */
function materializeVirtualDispatch(
  db: Database.Database,
  scipToLoreId: Map<string, number>,
  symbolInfoMap: Map<string, import('../../scip/scip_pb.js').SymbolInformation>,
  symbolDefinitions: Map<string, { filePath: string; line: number; character: number }>,
  layer: string,
  generation: number,
  log: ReturnType<typeof getLogger>,
): number {
  // Step 1: Build a map from type SCIP symbol → method SCIP symbols
  const typeToMethods = new Map<string, string[]>();
  for (const scipSymbol of scipToLoreId.keys()) {
    // Only methods (symbols ending with `().` that live inside a type `#`)
    if (!/\(\+?\d*\)\.$/.test(scipSymbol)) continue;
    const parentType = extractParentTypeSymbol(scipSymbol);
    if (!parentType) continue;
    let methods = typeToMethods.get(parentType);
    if (!methods) { methods = []; typeToMethods.set(parentType, methods); }
    methods.push(scipSymbol);
  }

  // Step 2: Collect implements relationships from SCIP SymbolInformation
  // Direction: symInfo.symbol (concrete type) has rel.isImplementation → rel.symbol (interface)
  const implementsPairs: Array<{ concreteTypeScip: string; interfaceTypeScip: string }> = [];
  for (const [scipSymbol, info] of symbolInfoMap) {
    for (const rel of info.relationships) {
      if (rel.isImplementation && rel.symbol) {
        implementsPairs.push({ concreteTypeScip: scipSymbol, interfaceTypeScip: rel.symbol });
      }
    }
  }

  if (implementsPairs.length === 0) return 0;

  // Step 3: For each implements pair, match methods by descriptor and
  // copy call edges from interface method callers to concrete methods.
  let edgesInserted = 0;

  // Prepared statement to find callers of a given callee
  const findCallers = db.prepare(
    `SELECT caller_id, file_id, callee_name, call_line, call_character,
            resolved_type_signature, resolved_return_type,
            definition_uri, definition_path, definition_line, definition_character
       FROM symbol_refs
      WHERE callee_id = ?`,
  );

  const findExistingCallSite = db.prepare(
    `SELECT 1
       FROM symbol_refs
      WHERE caller_id = ?
        AND callee_id = ?
        AND call_line = ?
        AND call_character IS ?
      LIMIT 1`,
  );

  const insertVDispatch = db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, resolved_type_signature, resolved_return_type, definition_uri, definition_path, definition_line, definition_character, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertVirtualDispatch = db.transaction(() => {
    for (const { concreteTypeScip, interfaceTypeScip } of implementsPairs) {
      const interfaceMethods = typeToMethods.get(interfaceTypeScip);
      const concreteMethods = typeToMethods.get(concreteTypeScip);
      if (!interfaceMethods || !concreteMethods) continue;

      // Build descriptor → concrete SCIP symbol map
      const concreteByDescriptor = new Map<string, string>();
      for (const cm of concreteMethods) {
        const desc = extractMethodDescriptor(cm);
        if (desc) concreteByDescriptor.set(desc, cm);
      }

      // Match interface methods to concrete methods by descriptor
      for (const im of interfaceMethods) {
        const desc = extractMethodDescriptor(im);
        if (!desc) continue;
        const concreteScip = concreteByDescriptor.get(desc);
        if (!concreteScip) continue;

        const interfaceMethodId = scipToLoreId.get(im);
        const concreteMethodId = scipToLoreId.get(concreteScip);
        if (!interfaceMethodId || !concreteMethodId) continue;

        // Find all callers of the interface method
        const callers = findCallers.all(interfaceMethodId) as Array<{
          caller_id: number;
          file_id: number;
          callee_name: string;
          call_line: number;
          call_character: number | null;
          resolved_type_signature: string | null;
          resolved_return_type: string | null;
          definition_uri: string | null;
          definition_path: string | null;
          definition_line: number | null;
          definition_character: number | null;
        }>;

        for (const caller of callers) {
          // Don't insert if the exact call site already resolves to this concrete callee.
          const existing = findExistingCallSite.get(
            caller.caller_id,
            concreteMethodId,
            caller.call_line,
            caller.call_character,
          );
          if (existing) continue;

          // Use the concrete method's name and definition info
          const concreteName = extractNameFromScipSymbol(concreteScip);
          const concreteDef = symbolDefinitions.get(concreteScip);
          const concreteDefUri = concreteDef ? pathToFileURL(concreteDef.filePath).toString() : null;

          try {
            insertVDispatch.run(
              caller.caller_id,
              caller.file_id,
              concreteMethodId,
              concreteName,
              caller.call_line,
              caller.call_character,
              'virtual_dispatch',
              'scip_definition',
              caller.resolved_type_signature,
              caller.resolved_return_type,
              concreteDefUri,
              concreteDef?.filePath ?? null,
              concreteDef?.line ?? null,
              concreteDef?.character ?? null,
              layer, generation,
            );
            edgesInserted++;
          } catch {
            // FK constraint or duplicate — skip
          }
        }
      }
    }
  });

  insertVirtualDispatch();

  if (edgesInserted > 0) {
    log.indexing('scip-indexer: virtual dispatch edges materialized', {
      implementsPairs: implementsPairs.length,
      edgesInserted,
    });
  }

  return edgesInserted;
}

/**
 * Determine the Lore language for a SCIP document.
 *
 * Many SCIP indexers (including scip-typescript) leave the `language` field
 * blank.  When that happens, infer from the file extension.
 */
function inferLoreLanguage(scipLanguage: string, relativePath: string): string | null {
  // Try explicit language first
  if (scipLanguage) {
    const mapped = SCIP_LANG_MAP[scipLanguage.toLowerCase()];
    if (mapped) return mapped;
  }

  // Infer from file extension
  const dotIdx = relativePath.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = relativePath.slice(dotIdx).toLowerCase();
    return EXT_TO_LANG[ext] ?? null;
  }

  return null;
}

// ─── Test-visible helpers ───────────────────────────────────────────────────
// Exported for unit testing only.  Not part of the public API.

export {
  estimateSymbolEndLine as _estimateSymbolEndLine,
  inferTypeRefKind as _inferTypeRefKind,
  extractImportPathFromSource as _extractImportPathFromSource,
  inferKindFromScipSymbol as _inferKindFromScipSymbol,
  inferLoreLanguage as _inferLoreLanguage,
  classifyScipReference as _classifyScipReference,
  extractNameFromScipSymbol as _extractNameFromScipSymbol,
  extractParentTypeSymbol as _extractParentTypeSymbol,
  extractMethodDescriptor as _extractMethodDescriptor,
};
