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

  // Get the last descriptor's name
  // Descriptors are separated by ., #, /, :, or ()
  const parts = cleaned.split(/[.#/:]/);
  let name = parts[parts.length - 1] || '';

  // Remove backtick escaping
  name = name.replace(/`/g, '');

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

    // Load SCIP index
    const indexBuffer = await this.loadScipIndex(context.scip, rootDir, staleLanguages);
    if (!indexBuffer) {
      log.indexing('scip-indexer: no SCIP index available');
      return;
    }

    const scipIndex = fromBinary(IndexSchema, indexBuffer);
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
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment, resolved_type_signature, resolved_return_type, definition_uri, definition_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, resolved_type_signature, resolved_return_type, definition_uri, definition_path, definition_line, definition_character)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTypeRef = db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method, resolved_type_signature, definition_uri, definition_path, definition_line, definition_character)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertImport = db.prepare(
      'INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)',
    );
    const insertRelationship = db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method, definition_uri, definition_path, definition_line, definition_character)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

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
        const fileInfo = insertFile.run(absPath, branch, loreLang, sizeBytes, hash, source) as { lastInsertRowid: number | bigint };
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

          // Use enclosing_range for span; fall back to source-based estimation
          let startLine = line;
          let endLine = line;
          if (enclosingRange.length >= 3) {
            startLine = enclosingRange[0] ?? line;
            endLine = enclosingRange.length >= 4
              ? (enclosingRange[2] ?? line)
              : startLine;
          } else {
            // No enclosing_range — estimate from source
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
          ) as { lastInsertRowid: number | bigint };
          const loreId = Number(info.lastInsertRowid);
          scipToLoreId.set(symInfo.symbol, loreId);
        }

        // Insert imports (from Import-role occurrences)
        // Prefer the actual import path from source; fall back to SCIP package
        const seenImports = new Set<string>();
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
            if (rawImport && !seenImports.has(rawImport)) {
              seenImports.add(rawImport);
              insertImport.run(fileId, rawImport);
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

            insertTypeRef.run(
              fileId,
              callerId,
              calleeId,
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
            );
            typeRefsInserted++;
          } else {
            // refKind === 'call'

            // Resolve enrichment metadata for the callee
            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = symbolInfoMap.get(occ.symbol);
            const refSig = refInfo ? extractSignatureFromDoc(refInfo.documentation[0] ?? '') || null : null;
            const refReturnType = extractReturnType(refSig);
            const refDefUri = refDef ? pathToFileURL(refDef.filePath).toString() : null;

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
            );
            refsInserted++;
            if (isExternal) refsExternal++;
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

  private async loadScipIndex(
    settings: EffectiveScipSettings,
    rootDir: string,
    staleLanguages: Set<string> | null = null,
  ): Promise<Uint8Array | null> {
    // Try pre-computed index directory first
    if (settings.indexDir) {
      // When staleLanguages is set, prefer per-language index files so
      // we only load the languages that actually need re-processing.
      if (staleLanguages) {
        for (const lang of staleLanguages) {
          const candidate = join(rootDir, settings.indexDir, `${lang}.scip`);
          if (existsSync(candidate)) {
            return readFileSync(candidate);
          }
        }
      }
      const candidates = [
        join(rootDir, settings.indexDir, 'index.scip'),
        // Language-specific index files
        ...['typescript', 'javascript', 'python', 'java', 'rust', 'c', 'cpp', 'csharp', 'ruby', 'php', 'go', 'dart'].map(
          lang => join(rootDir, settings.indexDir!, `${lang}.scip`),
        ),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return readFileSync(candidate);
        }
      }
    }

    // Try running an indexer
    const resolvedIndexers = resolveScipIndexerRegistry(settings.indexers);
    for (const [lang, indexer] of Object.entries(resolvedIndexers)) {
      if (!indexer.available) continue;
      // Per-language staleness: skip indexers for languages that haven't changed.
      if (staleLanguages && !staleLanguages.has(lang)) continue;
      try {
        const outputPath = join(rootDir, `.lore-scip-${lang}.scip`);
        const args = indexer.args.map(a => a.replace(/\{output\}/g, outputPath));
        const execFileAsync = promisify(execFile);
        await execFileAsync(indexer.command, args, {
          cwd: rootDir,
          timeout: settings.timeoutMs,
        });
        // Check for output
        for (const candidate of [outputPath, join(rootDir, 'index.scip')]) {
          if (existsSync(candidate)) {
            const data = readFileSync(candidate);
            try { fs.unlinkSync(candidate); } catch { /* best effort */ }
            return data;
          }
        }
      } catch {
        continue;
      }
    }

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

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.scala': 'scala',
  '.sc': 'scala',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.go': 'go',
  '.dart': 'dart',
};

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
};
