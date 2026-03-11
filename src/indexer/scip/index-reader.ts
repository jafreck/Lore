/**
 * @module indexer/scip/index-reader
 *
 * Parses a SCIP index (protobuf binary) into in-memory lookup structures
 * that the enrichment coordinator can query by file + position.
 *
 * Uses the official SCIP protobuf schema (vendored `scip_pb.ts`) with
 * `@bufbuild/protobuf` for decoding — no manual wire-format parsing.
 *
 * ## SCIP data model (relevant subset)
 *
 * - `Index.documents[]` — per-file occurrences and symbol definitions
 * - `Index.external_symbols[]` — hover docs for symbols from other packages
 * - `Occurrence.range` — `[startLine, startChar, endChar]` (3-elem) or
 *   `[startLine, startChar, endLine, endChar]` (4-elem), 0-based
 * - `Occurrence.symbol_roles` — bitset; bit 0 = Definition
 * - `SymbolInformation.documentation` — markdown hover text
 * - `SymbolInformation.signature_documentation` — structured signature
 */

import { resolve } from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  SymbolRole,
  type Index as ScipIndex,
  type Document as ScipDocument,
  type Occurrence as ScipOccurrence,
  type SymbolInformation as ScipSymbolInformation,
} from './scip_pb.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ScipDefinitionLocation {
  /** Absolute path to the file containing the definition. */
  filePath: string;
  /** 0-based line number. */
  line: number;
  /** 0-based character offset. */
  character: number;
}

export interface ScipSymbolInfo {
  symbol: string;
  documentation: string[];
  displayName: string;
  signatureText: string | null;
}

export interface ScipOccurrenceRecord {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  symbol: string;
  isDefinition: boolean;
}

/**
 * In-memory SCIP index optimised for enrichment lookups.
 *
 * Given a file path + position, returns the definition location and
 * type signature for the symbol at that position.
 */
export class ScipIndexData {
  /** symbol → definition location */
  private readonly definitions = new Map<string, ScipDefinitionLocation>();
  /** symbol → metadata (docs, display name, signature) */
  private readonly symbolInfo = new Map<string, ScipSymbolInfo>();
  /** absolute file path → sorted occurrences */
  private readonly fileOccurrences = new Map<string, ScipOccurrenceRecord[]>();
  /** Set of languages present in this index */
  readonly languages = new Set<string>();

  constructor(private readonly projectRoot: string) {}

  addDocument(doc: ScipDocument): void {
    const absPath = resolve(this.projectRoot, doc.relativePath);
    if (doc.language) this.languages.add(doc.language.toLowerCase());

    const records: ScipOccurrenceRecord[] = [];
    for (const occ of doc.occurrences) {
      const range = occ.range;
      if (range.length < 3) continue;
      const startLine = range[0]!;
      const startChar = range[1]!;
      const endLine = range.length >= 4 ? range[2]! : startLine;
      const endChar = range.length >= 4 ? range[3]! : range[2]!;
      const isDefinition = (occ.symbolRoles & SymbolRole.Definition) !== 0;
      records.push({
        startLine,
        startCharacter: startChar,
        endLine,
        endCharacter: endChar,
        symbol: occ.symbol,
        isDefinition,
      });

      // Register definition locations.
      if (isDefinition && occ.symbol && !occ.symbol.startsWith('local ')) {
        if (!this.definitions.has(occ.symbol)) {
          this.definitions.set(occ.symbol, { filePath: absPath, line: startLine, character: startChar });
        }
      }
    }

    // Sort by (startLine, startCharacter) for binary search.
    records.sort((a, b) => a.startLine - b.startLine || a.startCharacter - b.startCharacter);
    this.fileOccurrences.set(absPath, records);

    // Index symbol info from document-level symbols.
    for (const sym of doc.symbols) {
      if (sym.symbol) {
        this.symbolInfo.set(sym.symbol, toScipSymbolInfo(sym));
      }
    }
  }

  addExternalSymbol(sym: ScipSymbolInformation): void {
    if (sym.symbol) {
      this.symbolInfo.set(sym.symbol, toScipSymbolInfo(sym));
    }
  }

  /**
   * Look up the occurrence at (or nearest to) the given position in a file.
   */
  findOccurrence(filePath: string, line: number, character: number): ScipOccurrenceRecord | null {
    const occs = this.fileOccurrences.get(filePath);
    if (!occs || occs.length === 0) return null;

    // Binary search for the first occurrence on this line.
    let lo = 0;
    let hi = occs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (occs[mid]!.startLine < line) lo = mid + 1;
      else hi = mid;
    }

    // Scan forward through occurrences on this line to find the best match.
    let best: ScipOccurrenceRecord | null = null;
    let bestDistance = Infinity;

    for (let i = lo; i < occs.length && occs[i]!.startLine === line; i++) {
      const occ = occs[i]!;
      // Exact containment: character is within the occurrence range.
      if (character >= occ.startCharacter && (occ.endLine > line || character <= occ.endCharacter)) {
        return occ;
      }
      // Nearest on the same line.
      const dist = Math.abs(occ.startCharacter - character);
      if (dist < bestDistance) {
        bestDistance = dist;
        best = occ;
      }
    }

    // Allow a nearby match (within 5 characters) on the same line.
    return bestDistance <= 5 ? best : null;
  }

  /**
   * Resolve a SCIP symbol string to its definition location.
   */
  getDefinition(symbol: string): ScipDefinitionLocation | null {
    return this.definitions.get(symbol) ?? null;
  }

  /**
   * Get symbol metadata (documentation, signature).
   */
  getSymbolInfo(symbol: string): ScipSymbolInfo | null {
    return this.symbolInfo.get(symbol) ?? null;
  }

  /** Number of indexed files. */
  get fileCount(): number { return this.fileOccurrences.size; }

  /** Number of unique symbols with known definition locations. */
  get definitionCount(): number { return this.definitions.size; }
}

// ─── Protobuf → internal type conversion ──────────────────────────────────────

function toScipSymbolInfo(sym: ScipSymbolInformation): ScipSymbolInfo {
  return {
    symbol: sym.symbol,
    documentation: [...sym.documentation],
    displayName: sym.displayName,
    signatureText: sym.signatureDocumentation?.text || null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a SCIP protobuf index from raw bytes.
 *
 * @param buffer       The raw protobuf bytes (e.g. `fs.readFileSync(path)`).
 * @param projectRoot  Absolute path to the project root.  Document
 *                     `relative_path` values are resolved against this.
 * @returns Populated `ScipIndexData` ready for enrichment queries.
 */
export function parseScipIndex(buffer: Uint8Array, projectRoot: string): ScipIndexData {
  const decoded: ScipIndex = fromBinary(IndexSchema, buffer);
  const index = new ScipIndexData(projectRoot);

  for (const doc of decoded.documents) {
    index.addDocument(doc);
  }
  for (const sym of decoded.externalSymbols) {
    index.addExternalSymbol(sym);
  }

  return index;
}

/**
 * Extract a human-readable type signature from SCIP symbol documentation.
 *
 * Strips markdown code fences and extracts the first meaningful line,
 * similar to how the LSP enrichment extracts hover text.
 */
export function extractSignatureFromDocs(info: ScipSymbolInfo): string | null {
  // Prefer signature_documentation text.
  if (info.signatureText) {
    const cleaned = info.signatureText
      .replace(/```[a-z0-9_+-]*\n/giu, '')
      .replace(/```/gu, '')
      .trim();
    return cleaned || null;
  }

  // Fall back to first documentation entry that looks like a signature.
  for (const doc of info.documentation) {
    const cleaned = doc
      .replace(/```[a-z0-9_+-]*\n/giu, '')
      .replace(/```/gu, '')
      .trim();
    if (cleaned && looksLikeSignature(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

/** Heuristic: does this text look like a code signature? */
function looksLikeSignature(text: string): boolean {
  const firstLine = text.split('\n')[0] ?? '';
  return /(?:function|def|fn|func|class|interface|type|const|let|var|pub|export|public|private|protected)\s/u.test(firstLine)
    || /\(.*\)/u.test(firstLine)
    || /:\s*\w/u.test(firstLine)
    || /->\s*\w/u.test(firstLine);
}

/**
 * Extract a return type from a type signature string.
 * Reuses the same heuristics as LSP enrichment.
 */
export function extractReturnType(signature: string | null): string | null {
  if (!signature) return null;
  const lines = signature.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const firstLine = lines[0]!;

  const functionStyle = firstLine.match(/\)\s*:\s*([^={]+)$/u);
  if (functionStyle?.[1]) return functionStyle[1].trim();

  const arrowStyle = firstLine.match(/->\s*([^={]+)$/u);
  if (arrowStyle?.[1]) return arrowStyle[1].trim();

  const colonStyle = firstLine.match(/:\s*([^={]+)$/u);
  if (colonStyle?.[1]) return colonStyle[1].trim();

  return null;
}
