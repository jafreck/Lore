/**
 * @module indexer/scip/index-reader
 *
 * Parses a SCIP index (protobuf binary) into in-memory lookup structures
 * that the enrichment coordinator can query by file + position.
 *
 * Implements a minimal protobuf wire-format decoder for exactly the SCIP
 * fields Lore needs — no external protobuf dependency required.
 *
 * ## SCIP data model (relevant subset)
 *
 * ```
 * Index {
 *   Metadata metadata = 1;
 *   repeated Document documents = 2;
 *   repeated SymbolInformation external_symbols = 3;
 * }
 * Document {
 *   string relative_path = 1;
 *   repeated Occurrence occurrences = 2;
 *   repeated SymbolInformation symbols = 3;
 *   string language = 4;
 * }
 * Occurrence {
 *   repeated int32 range = 1;   // packed
 *   string symbol = 2;
 *   int32 symbol_roles = 3;
 * }
 * SymbolInformation {
 *   string symbol = 1;
 *   repeated string documentation = 3;
 *   string display_name = 6;
 *   Document signature_documentation = 7;
 * }
 * ```
 *
 * Occurrence ranges are `[startLine, startChar, endLine, endChar]` (4 elems)
 * or `[startLine, startChar, endChar]` (3 elems, endLine = startLine).
 * Definition occurrences have bit 0 of `symbol_roles` set.
 */

import { join, resolve } from 'node:path';

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

  addDocument(doc: RawScipDocument): void {
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
      const isDefinition = (occ.symbolRoles & 0x1) !== 0;
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
        // Only keep the first definition per symbol (in case of duplicates).
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
        this.symbolInfo.set(sym.symbol, {
          symbol: sym.symbol,
          documentation: sym.documentation,
          displayName: sym.displayName,
          signatureText: sym.signatureText,
        });
      }
    }
  }

  addExternalSymbol(sym: RawScipSymbolInfo): void {
    if (sym.symbol) {
      this.symbolInfo.set(sym.symbol, {
        symbol: sym.symbol,
        documentation: sym.documentation,
        displayName: sym.displayName,
        signatureText: sym.signatureText,
      });
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

// ─── Raw decoded types ────────────────────────────────────────────────────────

export interface RawScipDocument {
  relativePath: string;
  language: string;
  occurrences: Array<{ range: number[]; symbol: string; symbolRoles: number }>;
  symbols: RawScipSymbolInfo[];
}

export interface RawScipSymbolInfo {
  symbol: string;
  documentation: string[];
  displayName: string;
  signatureText: string | null;
}

// ─── Minimal protobuf wire-format decoder ─────────────────────────────────────

/** Protobuf wire types. */
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

class ProtobufReader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  get done(): boolean { return this.pos >= this.buf.length; }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++]!;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error('Varint too long');
    }
    throw new Error('Unexpected end of buffer reading varint');
  }

  readSignedVarint(): number {
    const raw = this.readVarint();
    return raw | 0; // Interpret as signed 32-bit.
  }

  readTag(): { fieldNumber: number; wireType: number } {
    const v = this.readVarint();
    return { fieldNumber: v >>> 3, wireType: v & 0x7 };
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    if (this.pos + length > this.buf.length) {
      throw new Error(`Unexpected end of buffer: need ${length} bytes at offset ${this.pos}`);
    }
    const result = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return result;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  readPackedInt32(): number[] {
    const bytes = this.readBytes();
    const sub = new ProtobufReader(bytes);
    const values: number[] = [];
    while (!sub.done) {
      values.push(sub.readSignedVarint());
    }
    return values;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint();
        break;
      case WIRE_FIXED64:
        this.pos += 8;
        break;
      case WIRE_LENGTH_DELIMITED:
        this.pos += this.readVarint();
        break;
      case WIRE_FIXED32:
        this.pos += 4;
        break;
      default:
        throw new Error(`Unknown wire type: ${wireType}`);
    }
  }
}

// ─── SCIP message decoders ────────────────────────────────────────────────────

function decodeOccurrence(data: Uint8Array): { range: number[]; symbol: string; symbolRoles: number } {
  const reader = new ProtobufReader(data);
  let range: number[] = [];
  let symbol = '';
  let symbolRoles = 0;

  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1: // range — packed repeated int32
        if (wireType === WIRE_LENGTH_DELIMITED) {
          range = reader.readPackedInt32();
        } else {
          range.push(reader.readSignedVarint());
        }
        break;
      case 2: // symbol
        symbol = reader.readString();
        break;
      case 3: // symbol_roles
        symbolRoles = reader.readSignedVarint();
        break;
      default:
        reader.skip(wireType);
    }
  }
  return { range, symbol, symbolRoles };
}

function decodeSymbolInfo(data: Uint8Array): RawScipSymbolInfo {
  const reader = new ProtobufReader(data);
  let symbol = '';
  const documentation: string[] = [];
  let displayName = '';
  let signatureText: string | null = null;

  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1: // symbol
        symbol = reader.readString();
        break;
      case 3: // documentation (repeated string)
        documentation.push(reader.readString());
        break;
      case 6: // display_name
        displayName = reader.readString();
        break;
      case 7: { // signature_documentation (Document message — extract text field)
        const docBytes = reader.readBytes();
        signatureText = extractDocumentText(docBytes);
        break;
      }
      default:
        reader.skip(wireType);
    }
  }
  return { symbol, documentation, displayName, signatureText };
}

/** Extract text from an embedded Document message (field 5 = text). */
function extractDocumentText(data: Uint8Array): string | null {
  const reader = new ProtobufReader(data);
  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 5 && wireType === WIRE_LENGTH_DELIMITED) {
      return reader.readString();
    }
    reader.skip(wireType);
  }
  return null;
}

function decodeDocument(data: Uint8Array): RawScipDocument {
  const reader = new ProtobufReader(data);
  let relativePath = '';
  let language = '';
  const occurrences: Array<{ range: number[]; symbol: string; symbolRoles: number }> = [];
  const symbols: RawScipSymbolInfo[] = [];

  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1: // relative_path
        relativePath = reader.readString();
        break;
      case 2: // occurrences (repeated Occurrence)
        occurrences.push(decodeOccurrence(reader.readBytes()));
        break;
      case 3: // symbols (repeated SymbolInformation)
        symbols.push(decodeSymbolInfo(reader.readBytes()));
        break;
      case 4: // language
        language = reader.readString();
        break;
      default:
        reader.skip(wireType);
    }
  }
  return { relativePath, language, occurrences, symbols };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a SCIP protobuf index from raw bytes.
 *
 * @param buffer    The raw protobuf bytes (e.g. `fs.readFileSync(path)`).
 * @param projectRoot  Absolute path to the project root.  Document
 *                     `relative_path` values are resolved against this.
 * @returns Populated `ScipIndexData` ready for enrichment queries.
 */
export function parseScipIndex(buffer: Uint8Array, projectRoot: string): ScipIndexData {
  const index = new ScipIndexData(projectRoot);
  const reader = new ProtobufReader(buffer);

  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1: // metadata — skip (not needed for enrichment)
        reader.skip(wireType);
        break;
      case 2: // documents
        index.addDocument(decodeDocument(reader.readBytes()));
        break;
      case 3: // external_symbols
        index.addExternalSymbol(decodeSymbolInfo(reader.readBytes()));
        break;
      default:
        reader.skip(wireType);
    }
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
