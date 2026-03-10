/**
 * @module indexer/stages/scip-source
 *
 * Pipeline stage: for SCIP-covered languages, populate `files`, `symbols`,
 * `symbol_refs`, `type_refs`, `symbol_relationships`, and `file_imports`
 * **directly from the SCIP index** — bypassing tree-sitter entirely.
 *
 * This is the SCIP-primary architecture.  SCIP is the source of truth for
 * both the symbol table and the call graph.  For each SCIP document:
 *
 * 1. **Symbols**: Definition occurrences → `symbols` rows; kinds inferred
 *    from SCIP descriptor suffixes; spans from `enclosing_range`.
 * 2. **Refs**: Non-definition, non-local reference occurrences →
 *    `symbol_refs` rows with both `caller_id` and `callee_id` resolved
 *    using containment (which symbol's span encloses this ref?) and
 *    definition lookup (where is the referenced SCIP symbol defined?).
 *
 * SCIP refs are inserted **pre-resolved** with `resolution_method =
 * 'scip_definition'`.  The downstream resolution stage only processes
 * refs from non-SCIP languages.
 *
 * ## Data written
 *
 * Same tables as `SourceIndexStage`: `files`, `symbols`, `symbols_fts`,
 * `symbol_refs`, `type_refs`, `symbol_relationships`, `file_imports`.
 *
 * ## Pipeline ordering
 *
 * This stage runs **before** `SourceIndexStage`.  It stores which
 * languages and files it handled in `context.scipSourcedLanguages` and
 * `context.scipSourcedFiles` so the tree-sitter path can skip them.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { resolve } from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  SymbolRole,
  type Document as ScipDocument,
  type Occurrence as ScipOccurrence,
  type SymbolInformation as ScipSymbolInformation,
} from '../scip/scip_pb.js';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../db.js';
import { buildStructuralEmbeddingText } from '../embedder.js';
import { normalizeTypeName } from '../call-graph.js';
import { SCIP_SUPPORTED_LANGUAGES, resolveScipIndexerRegistry } from '../scip/registry.js';
import type { EffectiveScipSettings } from '../scip/config.js';
import { getLogger } from '../../logger.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

// ─── Stage implementation ────────────────────────────────────────────────────

export class ScipSourceStage implements PipelineStage {
  readonly name = 'scip-source';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    if (!context.scip?.enabled) return;

    const log = context.log;
    const rootDir = context.walkerConfig.rootDir;

    // Load SCIP index
    const indexBuffer = this.loadScipIndex(context.scip, rootDir);
    if (!indexBuffer) {
      log.indexing('scip-source: no SCIP index available');
      return;
    }

    const scipIndex = fromBinary(IndexSchema, indexBuffer);
    log.indexing('scip-source: loaded index', {
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

    log.indexing('scip-source: languages covered', { languages: [...coveredLanguages] });

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
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = db.prepare(
      'INSERT INTO symbols_fts(rowid, name, signature, kind) VALUES (?, ?, ?, ?)',
    );
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTypeRef = db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertImport = db.prepare(
      'INSERT INTO file_imports (file_id, raw_import) VALUES (?, ?)',
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

        const sizeBytes = Buffer.byteLength(source, 'utf8');
        const hash = crypto.createHash('sha256').update(source).digest('hex');

        // Delete existing data for this file (like SourceIndexStage does)
        const existing = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(absPath, branch) as
          | { id: number } | undefined;
        if (existing) {
          db.prepare('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)').run(existing.id);
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
        const docDefs = new Map<string, { line: number; character: number; startLine: number; endLine: number }>();
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Definition) === 0) continue;
          if (!occ.symbol || occ.symbol.startsWith('local ')) continue;

          const line = occ.range[0] ?? 0;
          const character = occ.range[1] ?? 0;

          // Use enclosing_range for span; fall back to just the definition line
          let startLine = line;
          let endLine = line;
          if (occ.enclosingRange.length >= 3) {
            startLine = occ.enclosingRange[0] ?? line;
            endLine = occ.enclosingRange.length >= 4
              ? (occ.enclosingRange[2] ?? line)
              : startLine;
          }

          // Keep the first definition per symbol in this file
          if (!docDefs.has(occ.symbol)) {
            docDefs.set(occ.symbol, { line, character, startLine, endLine });
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

          const info = insertSymbol.run(
            fileId, name, kind,
            defLoc.startLine, defLoc.endLine,
            signature || null, docComment,
          ) as { lastInsertRowid: number | bigint };
          const loreId = Number(info.lastInsertRowid);
          scipToLoreId.set(symInfo.symbol, loreId);

          insertFts.run(
            loreId, name,
            buildStructuralEmbeddingText({ name, signature: signature || null }),
            kind,
          );
        }

        // Insert imports (from Import-role occurrences)
        const seenImports = new Set<string>();
        for (const occ of doc.occurrences) {
          if ((occ.symbolRoles & SymbolRole.Import) !== 0 && occ.symbol) {
            // Extract the package portion as the raw import
            const parts = occ.symbol.split(' ');
            const rawImport = parts.length >= 4 ? parts[3] : occ.symbol;
            if (rawImport && !seenImports.has(rawImport)) {
              seenImports.add(rawImport);
              insertImport.run(fileId, rawImport);
            }
          }
        }
      }
    });
    processDocuments();

    log.indexing('scip-source: symbols inserted', {
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
          const calleeName = extractNameFromScipSymbol(occ.symbol);
          const isExternal = !calleeId && isExternalSymbol(occ.symbol);
          const method = calleeId ? 'scip_definition' : (isExternal ? 'external_definition' : 'unresolved');

          if (refKind === 'type') {
            insertTypeRef.run(
              fileId,
              callerId,
              calleeId,
              calleeName,
              normalizeTypeName(calleeName),
              'other',
              line,
              character,
              method,
            );
            typeRefsInserted++;
          } else {
            // refKind === 'call'
            insertCallRef.run(
              callerId,
              fileId,
              calleeId,
              calleeName,
              line,
              character,
              'direct',
              method,
            );
            refsInserted++;
            if (isExternal) refsExternal++;
          }
        }
      }
    });
    processRefs();

    log.indexing('scip-source: refs inserted', {
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

  private loadScipIndex(settings: EffectiveScipSettings, rootDir: string): Uint8Array | null {
    // Try pre-computed index directory first
    if (settings.indexDir) {
      const candidates = [
        join(rootDir, settings.indexDir, 'index.scip'),
        // Language-specific index files
        ...['typescript', 'javascript', 'python', 'java', 'rust', 'c', 'cpp', 'csharp', 'ruby', 'php'].map(
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
      try {
        const outputPath = join(rootDir, `.lore-scip-${lang}.scip`);
        const args = indexer.args.map(a => a.replace(/\{output\}/g, outputPath));
        execFileSync(indexer.command, args, {
          cwd: rootDir,
          timeout: settings.timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
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
  cpp: 'cpp',
  csharp: 'csharp',
  ruby: 'ruby',
  php: 'php',
  go: 'go',
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
