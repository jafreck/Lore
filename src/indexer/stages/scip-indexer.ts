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
import type { PipelineContext, PipelineStage, ScipTreeSitterFileData } from '../pipeline.js';
import type { Database } from '../../db/schema.js';
import { normalizeTypeName } from '../../resolution/call-graph.js';
import { SCIP_SUPPORTED_LANGUAGES, resolveScipIndexerRegistry } from '../../scip/registry.js';
import type { EffectiveScipSettings } from '../../scip/config.js';
import { getLogger } from '../../logger.js';
import { extractReturnType, iterateScipDocuments } from '../../scip/index-reader.js';
import { getSpecsForLanguage, installScipIndexer } from '../../scip/installer.js';
import { ensureCompilationDatabase } from '../../scip/compdb.js';
import { EXT_TO_LANG } from '../../discovery/walker.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ParserPool } from '../../parsing/parser.js';
import type Parser from 'tree-sitter';
import type { RawCallRef, RawTypeRef } from '../../parsing/extractors/types.js';

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
 * Extract the parent SCIP symbol string by stripping the last descriptor.
 *
 * SCIP symbols are formed by chaining descriptors: `scheme package desc1 desc2 desc3`
 * The parent of `desc3` is `scheme package desc1 desc2`.
 *
 * E.g. `scip-java maven pkg 1.0 com/fasterxml/jackson/BeanSerializer#serialize().`
 * → `scip-java maven pkg 1.0 com/fasterxml/jackson/BeanSerializer#`
 *
 * Returns `null` if the symbol has no parent (top-level or unparseable).
 */
function extractParentScipSymbol(scipSymbol: string): string | null {
  if (!scipSymbol || scipSymbol.startsWith('local ')) return null;

  // Find the end of the package section (3 space-separated segments after scheme)
  // Format: <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' <descriptors>
  let spaceCount = 0;
  let packageEnd = 0;
  for (let i = 0; i < scipSymbol.length; i++) {
    if (scipSymbol[i] === ' ' && (i === 0 || scipSymbol[i - 1] !== ' ')) {
      spaceCount++;
      if (spaceCount === 4) {
        packageEnd = i + 1;
        break;
      }
    }
  }
  if (packageEnd === 0) return null;

  const descriptorPart = scipSymbol.slice(packageEnd);
  if (!descriptorPart) return null;

  // Split descriptors by suffix characters (/, #, ., :, !), keeping delimiters
  // Method descriptors end with '().' or '(+N).'
  // We need to find the start of the last descriptor

  // Strategy: tokenize from the end. The last descriptor ends at the string end
  // and starts after the previous descriptor's suffix.
  // Descriptor suffixes: / # . : ! and method pattern ().

  // Strip the last descriptor by finding where it starts
  let lastDescStart = descriptorPart.length;

  // Walk backward to find the start of the last descriptor
  // A method descriptor ends with `().` — check for that pattern first
  if (descriptorPart.endsWith('.')) {
    // Could be a method `name().` or a term `name.`
    const beforeDot = descriptorPart.slice(0, -1);
    const parenClose = beforeDot.lastIndexOf(')');
    if (parenClose >= 0) {
      // Find matching open paren
      const parenOpen = beforeDot.lastIndexOf('(', parenClose);
      if (parenOpen >= 0) {
        // Method descriptor: everything from start-of-name to end
        // Find where the name starts (after previous suffix)
        lastDescStart = findDescriptorNameStart(beforeDot, parenOpen);
      }
    }
    if (lastDescStart === descriptorPart.length) {
      // Simple term: name.
      const nameEnd = descriptorPart.length - 1; // position of '.'
      lastDescStart = findDescriptorNameStart(descriptorPart, nameEnd);
    }
  } else if (descriptorPart.endsWith('#') || descriptorPart.endsWith('/') ||
             descriptorPart.endsWith(':') || descriptorPart.endsWith('!')) {
    const nameEnd = descriptorPart.length - 1;
    lastDescStart = findDescriptorNameStart(descriptorPart, nameEnd);
  } else {
    // Unknown suffix pattern
    return null;
  }

  if (lastDescStart <= 0) return null;

  const parentDescriptors = descriptorPart.slice(0, lastDescStart);
  if (!parentDescriptors) return null;

  return scipSymbol.slice(0, packageEnd) + parentDescriptors;
}

/**
 * Find where a descriptor name starts, given the position of its suffix.
 * Walks backward past the name (possibly backtick-escaped) to the previous
 * descriptor's suffix character.
 */
function findDescriptorNameStart(s: string, suffixPos: number): number {
  let i = suffixPos - 1;
  // Handle backtick-escaped identifiers
  if (i >= 0 && s[i] === '`') {
    // Walk back to the opening backtick
    i--;
    while (i >= 0 && s[i] !== '`') i--;
    return i;
  }
  // Walk back through simple identifier characters
  while (i >= 0 && /[_+\-$a-zA-Z0-9]/.test(s[i]!)) i--;
  return i + 1;
}

/**
 * Count the number of descriptors in a SCIP symbol string.
 *
 * Used to sort symbols shallowest-first so parents are inserted before
 * children.  Counts descriptor-ending characters (`/`, `#`, `.`, `:`, `!`)
 * after the package prefix.
 */
function descriptorDepth(scipSymbol: string): number {
  // Skip past the 4-space-separated package header
  let spaceCount = 0;
  let start = 0;
  for (let i = 0; i < scipSymbol.length; i++) {
    if (scipSymbol[i] === ' ' && (i === 0 || scipSymbol[i - 1] !== ' ')) {
      spaceCount++;
      if (spaceCount === 4) { start = i + 1; break; }
    }
  }
  // Count descriptor suffix characters in the descriptor portion
  let depth = 0;
  for (let i = start; i < scipSymbol.length; i++) {
    const ch = scipSymbol[i];
    if (ch === '/' || ch === '#' || ch === '.' || ch === ':' || ch === '!') depth++;
  }
  return depth;
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


// ─── Type-ref kind inference ──────────────────────────────────────────────────

// ─── Tree-sitter AST helpers ────────────────────────────────────────────────

/** Node types that represent import statements across languages. */
const IMPORT_NODE_TYPES = new Set([
  'import_statement', 'import_declaration', 'preproc_include',
  'use_declaration', 'require_call', 'import_from_statement',
  'using_directive', 'call_expression',
]);

/** Node types that represent call expressions across languages. */
const CALL_NODE_TYPES = new Set([
  'call_expression', 'function_call', 'invocation_expression',
  'method_invocation', 'call', 'new_expression',
]);

/** Node types that represent member access across languages. */
const MEMBER_NODE_TYPES = new Set([
  'member_expression', 'field_expression', 'attribute',
  'member_access_expression', 'qualified_identifier',
  'selector_expression',
]);

function inferTypeRefKindFromTree(
  tree: Parser.Tree, refLine: number, refChar: number,
): string | null {
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row: refLine, column: refChar });
  if (!node) return null;

  for (let depth = 0; depth < 6 && node; depth++) {
    const t = node.type;
    if (t === 'return_type' || (t === 'type_annotation' && node.parent?.type === 'function_declaration')) return 'return';
    if (t === 'type_parameter_constraint' || t === 'constraint') return 'bound';
    if (t === 'type_arguments' || t === 'generic_type' || t === 'type_argument_list') return 'generic_arg';
    if (t === 'required_parameter' || t === 'formal_parameter' || t === 'parameter_declaration' || t === 'typed_parameter') return 'parameter';
    if (t === 'field_declaration' || t === 'property_declaration' || t === 'field_definition') return 'field';
    if (t === 'variable_declarator' || t === 'lexical_declaration' || t === 'variable_declaration') return 'variable';
    node = node.parent;
  }
  return null;
}

function isCallExpression(
  tree: Parser.Tree, line: number, char: number,
): boolean {
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row: line, column: char });
  for (let depth = 0; depth < 4 && node; depth++) {
    if (CALL_NODE_TYPES.has(node.type)) return true;
    node = node.parent;
  }
  return false;
}

function extractReceiverName(
  tree: Parser.Tree, line: number, char: number,
): string | null {
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row: line, column: char });
  for (let depth = 0; depth < 4 && node; depth++) {
    if (MEMBER_NODE_TYPES.has(node.type)) {
      const obj = node.childForFieldName('object') ?? node.childForFieldName('operand') ?? node.firstChild;
      if (obj && obj.type !== node.type) {
        return obj.text;
      }
    }
    node = node.parent;
  }
  return null;
}

/**
 * Extract an import path from the tree-sitter AST at `importLine`.
 * Returns `null` if no import node is found, signalling regex fallback.
 */
function extractImportPathFromTree(
  tree: Parser.Tree, importLine: number,
): string | null {
  // Find any node on the import line
  const node = tree.rootNode.descendantForPosition({ row: importLine, column: 0 });
  if (!node) return null;

  // Walk up to find the import statement node
  let importNode: Parser.SyntaxNode | null = node;
  for (let depth = 0; depth < 6 && importNode; depth++) {
    if (IMPORT_NODE_TYPES.has(importNode.type)) break;
    importNode = importNode.parent;
  }
  if (!importNode || !IMPORT_NODE_TYPES.has(importNode.type)) return null;

  // Look for string literal or dotted-name children (recurse one level
  // for languages like Go where the path is nested inside an import_spec).
  const candidates: Parser.SyntaxNode[] = [];
  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i)!;
    candidates.push(child);
    // Recurse into wrapper nodes (e.g. Go's import_spec)
    for (let j = 0; j < child.childCount; j++) {
      candidates.push(child.child(j)!);
    }
  }
  for (const child of candidates) {
    if (child.type === 'string' || child.type === 'string_literal' ||
        child.type === 'interpreted_string_literal' || child.type === 'system_lib_string') {
      // Strip surrounding quotes
      const text = child.text;
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'")) ||
          (text.startsWith('<') && text.endsWith('>'))) {
        return text.slice(1, -1);
      }
      return text;
    }
    // Dotted import path (Java/Python/Kotlin): `import foo.bar.Baz`
    if (child.type === 'dotted_name' || child.type === 'scoped_identifier' ||
        child.type === 'qualified_identifier') {
      return child.text;
    }
  }
  return null;
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

    // Decode all SCIP index buffers once and keep the decoded objects alive.
    // A lazy generator is provided for the deferred ScipRefStage so that
    // documents are accessed without a redundant flat-array copy.
    const parsedIndexes = indexBuffers.map(buf => fromBinary(IndexSchema, buf));

    // Generator used only for the single-pass ScipRefStage iteration stored in
    // context.scipRefData.  All in-scope preprocessing passes iterate
    // parsedIndexes directly (nested for-of) to avoid generator overhead.
    function* iterateAllDocuments(): Generator<ScipDocument> {
      for (const idx of parsedIndexes) {
        yield* idx.documents;
      }
    }

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
    // Internal symbols are those whose SCIP string starts with the same
    // scheme + package as symbols defined in the index's own documents.
    const internalPrefixes = new Set<string>();
    for (const idx of parsedIndexes) {
      for (const doc of idx.documents) {
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
    for (const idx of parsedIndexes) {
      for (const doc of idx.documents) {
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
    }

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
    const importParserPool = new ParserPool();

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

        // Delete existing data for this file (like SourceIndexStage does)
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
            // No enclosing_range — tree-sitter (SourceIndexStage) will
            // overwrite end_line with accurate spans.
            endLine = line;
          }

          // Keep the first definition per symbol in this file
          if (!docDefs.has(symbol)) {
            docDefs.set(symbol, { line, character, startLine, endLine });
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
          const kind = inferKindFromScipSymbol(symInfo.symbol, docHint);

          // Skip parameters, type parameters, and module-level namespace symbols
          if (kind === 'parameter' || kind === 'module') continue;

          const signature = extractSignatureFromDoc(firstDoc);
          const docComment = symInfo.documentation.slice(1).join('\n').trim() || null;

          // Compute enrichment data inline (definition + type signature)
          const resolvedTypeSig = signature || null;
          const resolvedReturnType = extractReturnType(resolvedTypeSig);
          const definitionUri = pathToFileURL(absPath).toString();

          // Resolve parent_symbol_id by walking the SCIP descriptor chain
          // upward until we find a parent that was already inserted.
          let parentLoreId: number | null = null;
          let candidateScip = extractParentScipSymbol(symInfo.symbol);
          while (candidateScip) {
            const id = scipToLoreId.get(candidateScip);
            if (id !== undefined) {
              parentLoreId = id;
              break;
            }
            candidateScip = extractParentScipSymbol(candidateScip);
          }

          const info = insertSymbol.run(
            fileId, name, kind,
            defLoc.startLine, defLoc.endLine,
            signature || null, docComment,
            resolvedTypeSig, resolvedReturnType, definitionUri, absPath,
            parentLoreId,
            layer, generation,
          ) as { lastInsertRowid: number | bigint };
          const loreId = Number(info.lastInsertRowid);
          scipToLoreId.set(symInfo.symbol, loreId);
        }

        // Insert imports (from Import-role occurrences)
        // Prefer tree-sitter AST import extraction; fall back to SCIP package descriptor.
        // Use symbolDefinitions to pre-resolve imports to target file IDs.
        let importTree: Parser.Tree | null = null;
        try { importTree = importParserPool.parse(loreLang, source); } catch { /* ignore parse failure */ }

        const seenImports = new Map<string, number | null>(); // rawImport → resolved file ID
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Import) !== 0 && occ.symbol) {
            const importLine = occ.range[0] ?? 0;

            let srcImport: string | null = null;
            if (importTree) {
              srcImport = extractImportPathFromTree(importTree, importLine);
            }
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

    // ── Stash data for deferred ref processing ────────────────────────────
    // Pass 2+3 (containment index + ref insertion) are deferred to
    // ScipRefStage, which runs AFTER SourceIndexStage patches symbol
    // end_line values with accurate tree-sitter spans.  This avoids the
    // brittle estimateSymbolEndLine heuristic for caller resolution.
    context.scipRefData = {
      scipToLoreId,
      symbolDefinitions,
      symbolInfoMap,
      fileIdMap,
      documents: iterateAllDocuments(),
      isExternalSymbol,
    };

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

    // Determine which SCIP-supported languages actually exist in the project
    // so we don't waste time running irrelevant indexers (e.g., scip-go on a C project).
    const projectLanguages = staleLanguages ?? detectProjectLanguages(resolve(rootDir));

    // Auto-install missing indexers only for languages present in the project.
    const missingLanguages = [...projectLanguages].filter(
      (lang) => resolvedIndexers[lang] && !resolvedIndexers[lang]!.available,
    );
    if (missingLanguages.length > 0) {
      const attempted = new Set<string>();
      for (const lang of missingLanguages) {
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

// ─── ScipRefStage ─────────────────────────────────────────────────────────────

/**
 * Deferred SCIP ref insertion stage.
 *
 * Runs AFTER `SourceIndexStage` so that symbol `end_line` values have been
 * patched with accurate tree-sitter spans. This ensures the containment
 * index used for `caller_id` resolution is correct, avoiding the brittle
 * `estimateSymbolEndLine` brace-counting heuristic.
 *
 * Reads `context.scipRefData` (stashed by `ScipIndexerStage`) and:
 *  1. Builds a containment index from the DB (with patched spans)
 *  2. Inserts `symbol_refs` and `type_refs` from SCIP occurrences
 *  3. Materializes virtual dispatch edges
 */
export class ScipRefStage implements PipelineStage {
  readonly name = 'ScipRefStage';

  async execute(context: PipelineContext, _mode: string): Promise<void> {
    const data = context.scipRefData;
    if (!data) return; // No SCIP data — nothing to do

    const { scipToLoreId, symbolDefinitions, symbolInfoMap, fileIdMap, documents, isExternalSymbol } = data;
    const db = context.db;
    const branch = context.branch;
    const layer = context.layer;
    const generation = context.generation;
    const log = context.log;
    const rootDir = context.walkerConfig.rootDir;

    // Prepared statements
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, resolved_type_signature, resolved_return_type, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTypeRef = db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method, resolved_type_signature, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Build a containment index for caller resolution.
    // Because this stage runs AFTER SourceIndexStage, symbol end_line
    // values have been patched with accurate tree-sitter spans.
    // Only callable kinds (function, method, class, constructor, variable)
    // are included — properties and other non-callable symbols should not
    // be assigned as callers even when they lexically contain a call site.
    const fileSymbolSpans = new Map<number, Array<{ id: number; startLine: number; endLine: number }>>();
    {
      const rows = db.prepare(
        `SELECT s.id, s.file_id, s.start_line, s.end_line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.branch = ?
           AND s.kind IN ('function', 'method', 'class', 'constructor', 'variable')
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

    function findContainingSymbol(fileId: number, line: number): number | null {
      const spans = fileSymbolSpans.get(fileId);
      if (!spans) return null;
      for (const span of spans) {
        if (line >= span.startLine && line <= span.endLine) {
          return span.id;
        }
      }
      return null;
    }

    // Insert call refs and type refs from SCIP reference occurrences
    let refsInserted = 0;
    let refsExternal = 0;
    let refsNoCaller = 0;
    let refsLocal = 0;
    let refsSkippedNonCall = 0;
    let typeRefsInserted = 0;

    const scipDocs = [...(documents as Iterable<ScipDocument>)];
    const sipInfoMap = symbolInfoMap as Map<string, ScipSymbolInformation>;
    const scipTreeSitterData = context.scipTreeSitterData;
    const parserPool = new ParserPool();

    const SCIP_REF_BATCH_SIZE = 200;
    const processRefBatch = db.transaction((batch: ScipDocument[]) => {
      for (const doc of batch) {
        const absPath = resolve(rootDir, doc.relativePath);
        const fileId = fileIdMap.get(absPath);
        if (!fileId) continue;
        const treeData = scipTreeSitterData?.get(absPath);

        const source: string | undefined = context.sourceCache.get(absPath);
        let tree: Parser.Tree | null = null;
        if (source) {
          const loreLang = inferLoreLanguage(doc.language, doc.relativePath);
          if (loreLang) {
            try { tree = parserPool.parse(loreLang, source); } catch { /* ignore parse failure */ }
          }
        }

        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Definition) !== 0) continue;
          if (!occ.symbol) continue;

          if (occ.symbol.startsWith('local ')) {
            refsLocal++;
            continue;
          }

          let refKind = classifyScipReference(occ.symbol);
          const line = occ.range[0] ?? 0;
          const character = occ.range[1] ?? 0;
          const calleeName = extractNameFromScipSymbol(occ.symbol);
          const matchedCallRef = findMatchingCallRef(treeData, line, character, calleeName);
          if (refKind === 'skip') {
            // Term-value refs (ending in '.') may be calls to arrow-function
            // or const-assigned function values. Reuse the tree-sitter call
            // refs captured during the metrics pass instead of reparsing here.
            if (matchedCallRef) {
              refKind = 'call';
            } else if (tree && isCallExpression(tree, line, character)) {
              refKind = 'call';
            } else {
              refsSkippedNonCall++;
              continue;
            }
          }

          const callerId = findContainingSymbol(fileId, line);
          if (!callerId) {
            refsNoCaller++;
            continue;
          }

          const calleeId = scipToLoreId.get(occ.symbol) ?? null;
          const isExternal = !calleeId && isExternalSymbol(occ.symbol);
          const method = calleeId ? 'scip_definition' : (isExternal ? 'external_definition' : 'unresolved');

          if (refKind === 'type') {
            const typeRefKind = findMatchingTypeRefKind(treeData, line, character, calleeName)
              ?? (tree ? inferTypeRefKindFromTree(tree, line, character) : null)
              ?? 'other';
            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = sipInfoMap.get(occ.symbol);
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
            let resolvedCalleeName = calleeName;
            if (matchedCallRef?.calleeRaw) {
              resolvedCalleeName = matchedCallRef.calleeRaw;
            } else if (tree) {
              const receiverText = extractReceiverName(tree, line, character);
              if (receiverText) {
                resolvedCalleeName = `${receiverText}.${calleeName}`;
              }
            }

            const refDef = symbolDefinitions.get(occ.symbol);
            const refInfo = sipInfoMap.get(occ.symbol);
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
    for (let batchStart = 0; batchStart < scipDocs.length; batchStart += SCIP_REF_BATCH_SIZE) {
      processRefBatch(scipDocs.slice(batchStart, batchStart + SCIP_REF_BATCH_SIZE));
    }

    log.indexing('scip-refs: refs inserted', {
      callRefs: refsInserted,
      typeRefs: typeRefsInserted,
      external: refsExternal,
      noCaller: refsNoCaller,
      skippedLocal: refsLocal,
      skippedNonCall: refsSkippedNonCall,
    });

    // Materialize virtual dispatch edges
    materializeVirtualDispatch(
      db, scipToLoreId, sipInfoMap, symbolDefinitions, layer, generation, log,
    );

    // Free the stashed data
    context.scipRefData = undefined;
    context.scipTreeSitterData = undefined;
  }

  async dispose(): Promise<void> {}
}

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

function findMatchingCallRef(
  treeData: ScipTreeSitterFileData | undefined,
  line: number,
  character: number,
  calleeName: string,
): RawCallRef | null {
  const candidates = treeData?.callRefsByLine.get(line);
  if (!candidates || candidates.length === 0) return null;

  let best: RawCallRef | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const raw = candidate.calleeRaw.replace(/^new\s+/, '');
    const suffix = raw.split(/[.:>#-]/).filter(Boolean).at(-1) ?? raw;
    if (raw !== calleeName && suffix !== calleeName && !raw.endsWith(`.${calleeName}`)) {
      continue;
    }

    const distance = candidate.character === undefined
      ? bestDistance
      : Math.abs(candidate.character - character);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function findMatchingTypeRefKind(
  treeData: ScipTreeSitterFileData | undefined,
  line: number,
  character: number,
  calleeName: string,
): RawTypeRef['refKind'] | null {
  const candidates = treeData?.typeRefsByLine.get(line);
  if (!candidates || candidates.length === 0) return null;

  let best: RawTypeRef | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const normalizedName = normalizeTypeName(calleeName);
  for (const candidate of candidates) {
    if (normalizeTypeName(candidate.typeRaw) !== normalizedName) continue;
    const distance = candidate.character === undefined
      ? bestDistance
      : Math.abs(candidate.character - character);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best?.refKind ?? null;
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
 * Uses a bulk SQL approach: builds a temp table of (interface_method_id →
 * concrete_method_id) mappings, then does a single INSERT ... SELECT to
 * copy all caller edges at once.
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
  const implementsPairs: Array<{ concreteTypeScip: string; interfaceTypeScip: string }> = [];
  for (const [scipSymbol, info] of symbolInfoMap) {
    for (const rel of info.relationships) {
      if (rel.isImplementation && rel.symbol) {
        implementsPairs.push({ concreteTypeScip: scipSymbol, interfaceTypeScip: rel.symbol });
      }
    }
  }

  if (implementsPairs.length === 0) return 0;

  // Step 3: Build the method mapping in-memory: interface_method_id → (concrete_method_id, concrete_name, concrete_def)
  type MethodMapping = {
    interfaceMethodId: number;
    concreteMethodId: number;
    concreteName: string;
    concreteDefUri: string | null;
    concreteDefPath: string | null;
    concreteDefLine: number | null;
    concreteDefChar: number | null;
  };
  const mappings: MethodMapping[] = [];

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

    for (const im of interfaceMethods) {
      const desc = extractMethodDescriptor(im);
      if (!desc) continue;
      const concreteScip = concreteByDescriptor.get(desc);
      if (!concreteScip) continue;

      const interfaceMethodId = scipToLoreId.get(im);
      const concreteMethodId = scipToLoreId.get(concreteScip);
      if (!interfaceMethodId || !concreteMethodId) continue;

      const concreteName = extractNameFromScipSymbol(concreteScip);
      const concreteDef = symbolDefinitions.get(concreteScip);

      mappings.push({
        interfaceMethodId,
        concreteMethodId,
        concreteName,
        concreteDefUri: concreteDef ? pathToFileURL(concreteDef.filePath).toString() : null,
        concreteDefPath: concreteDef?.filePath ?? null,
        concreteDefLine: concreteDef?.line ?? null,
        concreteDefChar: concreteDef?.character ?? null,
      });
    }
  }

  if (mappings.length === 0) return 0;

  // Step 4: Bulk insert using a temp table + INSERT ... SELECT
  const edgesInserted = db.transaction(() => {
    // Create temp table with the interface→concrete method mappings
    db.exec(`CREATE TEMP TABLE _vdispatch_map (
      iface_method_id INTEGER NOT NULL,
      concrete_method_id INTEGER NOT NULL,
      concrete_name TEXT NOT NULL,
      concrete_def_uri TEXT,
      concrete_def_path TEXT,
      concrete_def_line INTEGER,
      concrete_def_char INTEGER
    )`);

    const insertMapping = db.prepare(
      `INSERT INTO _vdispatch_map VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of mappings) {
      insertMapping.run(
        m.interfaceMethodId, m.concreteMethodId, m.concreteName,
        m.concreteDefUri, m.concreteDefPath, m.concreteDefLine, m.concreteDefChar,
      );
    }

    // Single bulk INSERT: for each mapping, copy all callers of the
    // interface method as new virtual_dispatch edges to the concrete method,
    // skipping rows that already exist at the same call site.
    const result = db.prepare(`
      INSERT INTO symbol_refs (
        caller_id, file_id, callee_id, callee_name,
        call_line, call_character, call_kind, resolution_method,
        resolved_type_signature, resolved_return_type,
        definition_uri, definition_path, definition_line, definition_character,
        layer, generation
      )
      SELECT
        sr.caller_id, sr.file_id, m.concrete_method_id, m.concrete_name,
        sr.call_line, sr.call_character, 'virtual_dispatch', 'scip_definition',
        sr.resolved_type_signature, sr.resolved_return_type,
        m.concrete_def_uri, m.concrete_def_path, m.concrete_def_line, m.concrete_def_char,
        @layer, @gen
      FROM _vdispatch_map m
      JOIN symbol_refs sr ON sr.callee_id = m.iface_method_id
      WHERE NOT EXISTS (
        SELECT 1 FROM symbol_refs ex
        WHERE ex.caller_id = sr.caller_id
          AND ex.callee_id = m.concrete_method_id
          AND ex.call_line = sr.call_line
          AND ex.call_character IS sr.call_character
      )
    `).run({ layer, gen: generation });

    db.exec(`DROP TABLE _vdispatch_map`);

    return result.changes;
  })();

  if (edgesInserted > 0) {
    log.indexing('scip-indexer: virtual dispatch edges materialized', {
      implementsPairs: implementsPairs.length,
      methodMappings: mappings.length,
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
  inferKindFromScipSymbol as _inferKindFromScipSymbol,
  inferLoreLanguage as _inferLoreLanguage,
  classifyScipReference as _classifyScipReference,
  extractNameFromScipSymbol as _extractNameFromScipSymbol,
  extractParentTypeSymbol as _extractParentTypeSymbol,
  extractMethodDescriptor as _extractMethodDescriptor,
  extractParentScipSymbol as _extractParentScipSymbol,
};
