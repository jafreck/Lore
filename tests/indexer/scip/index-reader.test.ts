/**
 * Tests for the SCIP protobuf index reader.
 *
 * Uses `@bufbuild/protobuf` `toBinary`/`create` to construct valid SCIP
 * protobuf messages, then verifies `parseScipIndex` correctly decodes
 * them into the in-memory lookup structures.
 */

import { describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  DocumentSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
  SymbolRole,
} from '../../../src/indexer/scip/scip_pb.js';
import {
  parseScipIndex,
  extractSignatureFromDocs,
  extractReturnType,
} from '../../../src/indexer/scip/index-reader.js';

// ─── Helper: build a SCIP index as protobuf bytes ─────────────────────────────

function buildIndexBytes(opts: {
  documents?: Array<{
    relativePath: string;
    language?: string;
    occurrences?: Array<{
      range: number[];
      symbol: string;
      symbolRoles?: number;
    }>;
    symbols?: Array<{
      symbol: string;
      documentation?: string[];
      displayName?: string;
    }>;
  }>;
  externalSymbols?: Array<{
    symbol: string;
    documentation?: string[];
    displayName?: string;
  }>;
}): Uint8Array {
  const index = create(IndexSchema, {
    documents: (opts.documents ?? []).map(d => create(DocumentSchema, {
      relativePath: d.relativePath,
      language: d.language ?? '',
      occurrences: (d.occurrences ?? []).map(o => create(OccurrenceSchema, {
        range: o.range,
        symbol: o.symbol,
        symbolRoles: o.symbolRoles ?? 0,
      })),
      symbols: (d.symbols ?? []).map(s => create(SymbolInformationSchema, {
        symbol: s.symbol,
        documentation: s.documentation ?? [],
        displayName: s.displayName ?? '',
      })),
    })),
    externalSymbols: (opts.externalSymbols ?? []).map(s => create(SymbolInformationSchema, {
      symbol: s.symbol,
      documentation: s.documentation ?? [],
      displayName: s.displayName ?? '',
    })),
  });
  return toBinary(IndexSchema, index);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseScipIndex', () => {
  it('decodes a minimal index with one document and a definition occurrence', () => {
    const sym = 'npm . project 1.0 `src/`/MyClass#';
    const bytes = buildIndexBytes({
      documents: [{
        relativePath: 'src/main.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [10, 4, 10, 20], symbol: sym, symbolRoles: SymbolRole.Definition },
          { range: [25, 2, 15], symbol: sym, symbolRoles: 0 },
        ],
        symbols: [{
          symbol: sym,
          documentation: ['A sample class'],
          displayName: 'MyClass',
        }],
      }],
    });

    const parsed = parseScipIndex(bytes, '/project');

    expect(parsed.fileCount).toBe(1);
    expect(parsed.definitionCount).toBe(1);
    expect(parsed.languages.has('typescript')).toBe(true);

    // Definition lookup
    const def = parsed.getDefinition(sym);
    expect(def).not.toBeNull();
    expect(def!.filePath).toBe('/project/src/main.ts');
    expect(def!.line).toBe(10);
    expect(def!.character).toBe(4);

    // Symbol info lookup
    const info = parsed.getSymbolInfo(sym);
    expect(info).not.toBeNull();
    expect(info!.displayName).toBe('MyClass');
    expect(info!.documentation).toEqual(['A sample class']);

    // Occurrence lookup by position
    const foundDef = parsed.findOccurrence('/project/src/main.ts', 10, 4);
    expect(foundDef).not.toBeNull();
    expect(foundDef!.isDefinition).toBe(true);
    expect(foundDef!.symbol).toBe(sym);

    // Reference occurrence
    const foundRef = parsed.findOccurrence('/project/src/main.ts', 25, 2);
    expect(foundRef).not.toBeNull();
    expect(foundRef!.isDefinition).toBe(false);
  });

  it('handles multiple documents', () => {
    const bytes = buildIndexBytes({
      documents: [
        {
          relativePath: 'src/a.ts',
          language: 'TypeScript',
          occurrences: [
            { range: [0, 0, 0, 10], symbol: 'sym1', symbolRoles: SymbolRole.Definition },
          ],
        },
        {
          relativePath: 'src/b.ts',
          language: 'TypeScript',
          occurrences: [
            { range: [5, 3, 5, 15], symbol: 'sym2', symbolRoles: SymbolRole.Definition },
          ],
        },
      ],
    });

    const parsed = parseScipIndex(bytes, '/root');

    expect(parsed.fileCount).toBe(2);
    expect(parsed.definitionCount).toBe(2);
    expect(parsed.getDefinition('sym1')!.filePath).toBe('/root/src/a.ts');
    expect(parsed.getDefinition('sym2')!.filePath).toBe('/root/src/b.ts');
  });

  it('resolves 3-element short range correctly', () => {
    const bytes = buildIndexBytes({
      documents: [{
        relativePath: 'file.py',
        language: 'Python',
        occurrences: [
          { range: [7, 10, 25], symbol: 'test_sym', symbolRoles: SymbolRole.Definition },
        ],
      }],
    });

    const parsed = parseScipIndex(bytes, '/p');
    const found = parsed.findOccurrence('/p/file.py', 7, 10);
    expect(found).not.toBeNull();
    expect(found!.startLine).toBe(7);
    expect(found!.startCharacter).toBe(10);
    expect(found!.endLine).toBe(7);
    expect(found!.endCharacter).toBe(25);
  });

  it('does not register local symbols as definitions', () => {
    const bytes = buildIndexBytes({
      documents: [{
        relativePath: 'local.ts',
        occurrences: [
          { range: [0, 0, 10], symbol: 'local 42', symbolRoles: SymbolRole.Definition },
        ],
      }],
    });

    const parsed = parseScipIndex(bytes, '/r');
    expect(parsed.getDefinition('local 42')).toBeNull();
  });

  it('handles empty index gracefully', () => {
    const bytes = buildIndexBytes({});
    const parsed = parseScipIndex(bytes, '/empty');
    expect(parsed.fileCount).toBe(0);
    expect(parsed.definitionCount).toBe(0);
  });

  it('external_symbols are queryable', () => {
    const bytes = buildIndexBytes({
      externalSymbols: [{
        symbol: 'npm . react 18.0 Component#',
        documentation: ['React base component'],
        displayName: 'Component',
      }],
    });

    const parsed = parseScipIndex(bytes, '/p');
    const info = parsed.getSymbolInfo('npm . react 18.0 Component#');
    expect(info).not.toBeNull();
    expect(info!.displayName).toBe('Component');
  });

  it('findOccurrence returns nearest on same line within tolerance', () => {
    const bytes = buildIndexBytes({
      documents: [{
        relativePath: 'test.ts',
        occurrences: [
          { range: [5, 10, 5, 20], symbol: 'nearby', symbolRoles: 0 },
        ],
      }],
    });

    const parsed = parseScipIndex(bytes, '/r');

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
