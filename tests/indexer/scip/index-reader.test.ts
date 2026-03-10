/**
 * Tests for the SCIP protobuf index reader.
 *
 * These tests construct minimal valid protobuf bytes for SCIP messages
 * and verify that `parseScipIndex` correctly decodes them into the
 * in-memory lookup structures.
 */

import { describe, expect, it } from 'vitest';
import {
  parseScipIndex,
  extractSignatureFromDocs,
  extractReturnType,
  type ScipIndexData,
} from '../../../src/indexer/scip/index-reader.js';

// ─── Protobuf encoding helpers ────────────────────────────────────────────────

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(fieldNumber: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNumber, 2);
  const length = encodeVarint(data.length);
  const result = new Uint8Array(tag.length + length.length + data.length);
  result.set(tag, 0);
  result.set(length, tag.length);
  result.set(data, tag.length + length.length);
  return result;
}

function encodeString(fieldNumber: number, value: string): Uint8Array {
  return encodeLengthDelimited(fieldNumber, new TextEncoder().encode(value));
}

function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNumber, 0);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

function encodePackedInt32(fieldNumber: number, values: number[]): Uint8Array {
  const parts: Uint8Array[] = values.map(v => encodeVarint(v >>> 0));
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const packed = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    packed.set(p, offset);
    offset += p.length;
  }
  return encodeLengthDelimited(fieldNumber, packed);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

// ─── Build a minimal SCIP index ──────────────────────────────────────────────

function buildOccurrence(opts: {
  range: number[];
  symbol: string;
  symbolRoles?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (opts.range.length > 0) parts.push(encodePackedInt32(1, opts.range));
  if (opts.symbol) parts.push(encodeString(2, opts.symbol));
  if (opts.symbolRoles) parts.push(encodeVarintField(3, opts.symbolRoles));
  return concat(...parts);
}

function buildSymbolInfo(opts: {
  symbol: string;
  documentation?: string[];
  displayName?: string;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeString(1, opts.symbol));
  for (const doc of opts.documentation ?? []) {
    parts.push(encodeString(3, doc));
  }
  if (opts.displayName) parts.push(encodeString(6, opts.displayName));
  return concat(...parts);
}

function buildDocument(opts: {
  relativePath: string;
  language?: string;
  occurrences?: Uint8Array[];
  symbols?: Uint8Array[];
}): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeString(1, opts.relativePath));
  for (const occ of opts.occurrences ?? []) {
    parts.push(encodeLengthDelimited(2, occ));
  }
  for (const sym of opts.symbols ?? []) {
    parts.push(encodeLengthDelimited(3, sym));
  }
  if (opts.language) parts.push(encodeString(4, opts.language));
  return concat(...parts);
}

function buildIndex(documents: Uint8Array[], externalSymbols?: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const doc of documents) {
    parts.push(encodeLengthDelimited(2, doc));
  }
  for (const sym of externalSymbols ?? []) {
    parts.push(encodeLengthDelimited(3, sym));
  }
  return concat(...parts);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseScipIndex', () => {
  it('decodes a minimal index with one document and a definition occurrence', () => {
    const defOcc = buildOccurrence({
      range: [10, 4, 10, 20],            // line 10, char 4–20
      symbol: 'npm . project 1.0 `src/`/MyClass#',
      symbolRoles: 1,                     // Definition bit
    });
    const refOcc = buildOccurrence({
      range: [25, 2, 15],                // line 25, char 2–15 (3-elem short form)
      symbol: 'npm . project 1.0 `src/`/MyClass#',
      symbolRoles: 0,                     // Reference only
    });
    const symInfo = buildSymbolInfo({
      symbol: 'npm . project 1.0 `src/`/MyClass#',
      documentation: ['A sample class'],
      displayName: 'MyClass',
    });
    const doc = buildDocument({
      relativePath: 'src/main.ts',
      language: 'TypeScript',
      occurrences: [defOcc, refOcc],
      symbols: [symInfo],
    });

    const indexBytes = buildIndex([doc]);
    const parsed = parseScipIndex(indexBytes, '/project');

    expect(parsed.fileCount).toBe(1);
    expect(parsed.definitionCount).toBe(1);
    expect(parsed.languages.has('typescript')).toBe(true);

    // Definition lookup
    const def = parsed.getDefinition('npm . project 1.0 `src/`/MyClass#');
    expect(def).not.toBeNull();
    expect(def!.filePath).toBe('/project/src/main.ts');
    expect(def!.line).toBe(10);
    expect(def!.character).toBe(4);

    // Symbol info lookup
    const info = parsed.getSymbolInfo('npm . project 1.0 `src/`/MyClass#');
    expect(info).not.toBeNull();
    expect(info!.displayName).toBe('MyClass');
    expect(info!.documentation).toEqual(['A sample class']);

    // Occurrence lookup by position
    const foundDef = parsed.findOccurrence('/project/src/main.ts', 10, 4);
    expect(foundDef).not.toBeNull();
    expect(foundDef!.isDefinition).toBe(true);
    expect(foundDef!.symbol).toBe('npm . project 1.0 `src/`/MyClass#');

    // Reference occurrence
    const foundRef = parsed.findOccurrence('/project/src/main.ts', 25, 2);
    expect(foundRef).not.toBeNull();
    expect(foundRef!.isDefinition).toBe(false);
  });

  it('handles multiple documents', () => {
    const doc1 = buildDocument({
      relativePath: 'src/a.ts',
      language: 'TypeScript',
      occurrences: [
        buildOccurrence({ range: [0, 0, 0, 10], symbol: 'sym1', symbolRoles: 1 }),
      ],
    });
    const doc2 = buildDocument({
      relativePath: 'src/b.ts',
      language: 'TypeScript',
      occurrences: [
        buildOccurrence({ range: [5, 3, 5, 15], symbol: 'sym2', symbolRoles: 1 }),
      ],
    });

    const indexBytes = buildIndex([doc1, doc2]);
    const parsed = parseScipIndex(indexBytes, '/root');

    expect(parsed.fileCount).toBe(2);
    expect(parsed.definitionCount).toBe(2);

    expect(parsed.getDefinition('sym1')!.filePath).toBe('/root/src/a.ts');
    expect(parsed.getDefinition('sym2')!.filePath).toBe('/root/src/b.ts');
  });

  it('resolves 3-element short range correctly', () => {
    const occ = buildOccurrence({
      range: [7, 10, 25],    // startLine=7, startChar=10, endChar=25 (endLine=7)
      symbol: 'test_sym',
      symbolRoles: 1,
    });
    const doc = buildDocument({
      relativePath: 'file.py',
      language: 'Python',
      occurrences: [occ],
    });
    const parsed = parseScipIndex(buildIndex([doc]), '/p');
    const found = parsed.findOccurrence('/p/file.py', 7, 10);
    expect(found).not.toBeNull();
    expect(found!.startLine).toBe(7);
    expect(found!.startCharacter).toBe(10);
    expect(found!.endLine).toBe(7);
    expect(found!.endCharacter).toBe(25);
  });

  it('does not register local symbols as definitions', () => {
    const occ = buildOccurrence({
      range: [0, 0, 10],
      symbol: 'local 42',
      symbolRoles: 1, // Even though it's a definition
    });
    const doc = buildDocument({
      relativePath: 'local.ts',
      occurrences: [occ],
    });
    const parsed = parseScipIndex(buildIndex([doc]), '/r');
    expect(parsed.getDefinition('local 42')).toBeNull();
  });

  it('handles empty index gracefully', () => {
    const parsed = parseScipIndex(new Uint8Array(0), '/empty');
    expect(parsed.fileCount).toBe(0);
    expect(parsed.definitionCount).toBe(0);
  });

  it('external_symbols are queryable', () => {
    const extSym = buildSymbolInfo({
      symbol: 'npm . react 18.0 Component#',
      documentation: ['React base component'],
      displayName: 'Component',
    });
    const parsed = parseScipIndex(buildIndex([], [extSym]), '/p');
    const info = parsed.getSymbolInfo('npm . react 18.0 Component#');
    expect(info).not.toBeNull();
    expect(info!.displayName).toBe('Component');
  });

  it('findOccurrence returns nearest on same line within tolerance', () => {
    const occ = buildOccurrence({
      range: [5, 10, 5, 20],
      symbol: 'nearby',
      symbolRoles: 0,
    });
    const doc = buildDocument({
      relativePath: 'test.ts',
      occurrences: [occ],
    });
    const parsed = parseScipIndex(buildIndex([doc]), '/r');

    // Exact match
    expect(parsed.findOccurrence('/r/test.ts', 5, 10)).not.toBeNull();

    // Within 5 character tolerance
    expect(parsed.findOccurrence('/r/test.ts', 5, 12)).not.toBeNull();

    // Too far away
    expect(parsed.findOccurrence('/r/test.ts', 5, 30)).toBeNull();

    // Wrong line
    expect(parsed.findOccurrence('/r/test.ts', 6, 10)).toBeNull();
  });
});

describe('extractSignatureFromDocs', () => {
  it('extracts from signatureText', () => {
    const result = extractSignatureFromDocs({
      symbol: 'test',
      documentation: [],
      displayName: 'test',
      signatureText: '```ts\nfunction foo(x: number): string\n```',
    });
    expect(result).toBe('function foo(x: number): string');
  });

  it('falls back to documentation that looks like a signature', () => {
    const result = extractSignatureFromDocs({
      symbol: 'test',
      documentation: ['A description.', 'function bar(a: string): void'],
      displayName: 'test',
      signatureText: null,
    });
    expect(result).toBe('function bar(a: string): void');
  });

  it('returns null when no signature found', () => {
    const result = extractSignatureFromDocs({
      symbol: 'test',
      documentation: ['This is just a description'],
      displayName: 'test',
      signatureText: null,
    });
    expect(result).toBeNull();
  });
});

describe('extractReturnType', () => {
  it('extracts from function-style signature', () => {
    expect(extractReturnType('function foo(x: number): string')).toBe('string');
  });

  it('extracts from arrow-style signature', () => {
    expect(extractReturnType('fn process(data: &[u8]) -> Result<Vec<u8>>')).toBe('Result<Vec<u8>>');
  });

  it('extracts from colon-style', () => {
    expect(extractReturnType('const x: number')).toBe('number');
  });

  it('returns null for unknown format', () => {
    expect(extractReturnType('something else')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractReturnType(null)).toBeNull();
  });
});
