import { describe, it, expect } from 'vitest';
import { extractReturnType } from '../../src/enrichment-types.js';
import { ScipIndexData, extractSignatureFromDocs, type ScipSymbolInfo } from '../../src/scip/index-reader.js';

// ─── extractReturnType ────────────────────────────────────────────────────────

describe('extractReturnType', () => {
  it('returns null for null input', () => {
    expect(extractReturnType(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractReturnType('')).toBeNull();
  });

  it('extracts return type from TypeScript function signature', () => {
    expect(extractReturnType('function foo(x: number): string')).toBe('string');
  });

  it('returns null for arrow-style without colon-return pattern', () => {
    expect(extractReturnType('(x: number) => string')).toBeNull(); // no '):'  pattern
  });

  it('extracts return type from Rust-style arrow', () => {
    expect(extractReturnType('fn foo(x: i32) -> String')).toBe('String');
  });

  it('extracts return type from Python-style annotation', () => {
    expect(extractReturnType('def foo(x: int) -> str')).toBe('str');
  });

  it('extracts return type from colon-style', () => {
    expect(extractReturnType('val x: Int')).toBe('Int');
  });

  it('extracts complex generic return type', () => {
    expect(extractReturnType('function bar(): Promise<string[]>')).toBe('Promise<string[]>');
  });

  it('handles multiline signature (takes first line)', () => {
    const sig = 'function baz(\n  x: number,\n  y: string\n): boolean';
    // First line is "function baz(" — no return type there
    const result = extractReturnType(sig);
    // It only looks at first line, so it won't find ): boolean on a later line
    expect(result).toBeNull();
  });

  it('handles whitespace-only input', () => {
    expect(extractReturnType('   ')).toBeNull();
  });

  it('stops at = sign (ignores initializers)', () => {
    expect(extractReturnType('const x: number = 5')).toBeNull();
  });

  it('stops at { (ignores body)', () => {
    expect(extractReturnType('function foo(): void {')).toBeNull();
  });
});

// ─── ScipIndexData ────────────────────────────────────────────────────────────

describe('ScipIndexData', () => {
  it('starts with zero counts', () => {
    const data = new ScipIndexData('/project');
    expect(data.fileCount).toBe(0);
    expect(data.definitionCount).toBe(0);
    expect(data.languages.size).toBe(0);
  });

  it('addDocument indexes occurrences and definitions', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/main.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [0, 4, 12], // line 0, cols 4-12
          symbol: 'ts . main . myFunc .',
          symbolRoles: 1, // Definition
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
          enclosingRange: [],
        },
        {
          range: [5, 2, 10], // line 5, cols 2-10
          symbol: 'ts . main . helper .',
          symbolRoles: 0, // Reference
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
          enclosingRange: [],
        },
      ],
      symbols: [
        {
          symbol: 'ts . main . myFunc .',
          documentation: ['A function'],
          relationships: [],
          displayName: 'myFunc',
          signatureDocumentation: { text: 'function myFunc(): void', language: 'typescript' },
          kind: 0,
          enclosingSymbol: '',
        },
      ],
      $typeName: 'scip.Document',
    } as any);

    expect(data.fileCount).toBe(1);
    expect(data.definitionCount).toBe(1);
    expect(data.languages.has('typescript')).toBe(true);
  });

  it('findOccurrence locates an occurrence on a specific line and character', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/main.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [10, 4, 15],
          symbol: 'ts . main . foo .',
          symbolRoles: 1,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
          enclosingRange: [],
        },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    const occ = data.findOccurrence('/project/src/main.ts', 10, 8);
    expect(occ).not.toBeNull();
    expect(occ!.symbol).toBe('ts . main . foo .');
  });

  it('findOccurrence returns null for unknown file', () => {
    const data = new ScipIndexData('/project');
    expect(data.findOccurrence('/project/unknown.ts', 0, 0)).toBeNull();
  });

  it('getDefinition resolves a symbol to its location', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/main.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [5, 0, 10],
          symbol: 'ts . main . MyClass .',
          symbolRoles: 1, // Definition
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
          enclosingRange: [],
        },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    const def = data.getDefinition('ts . main . MyClass .');
    expect(def).not.toBeNull();
    expect(def!.filePath).toBe('/project/src/main.ts');
    expect(def!.line).toBe(5);
    expect(def!.character).toBe(0);
  });

  it('getDefinition returns null for unknown symbol', () => {
    const data = new ScipIndexData('/project');
    expect(data.getDefinition('unknown.symbol')).toBeNull();
  });

  it('getSymbolInfo returns metadata for indexed symbol', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/main.ts',
      language: 'typescript',
      occurrences: [],
      symbols: [
        {
          symbol: 'ts . main . helper .',
          documentation: ['Helper function'],
          relationships: [],
          displayName: 'helper',
          signatureDocumentation: { text: 'function helper(): void', language: 'typescript' },
          kind: 0,
          enclosingSymbol: '',
        },
      ],
      $typeName: 'scip.Document',
    } as any);

    const info = data.getSymbolInfo('ts . main . helper .');
    expect(info).not.toBeNull();
    expect(info!.displayName).toBe('helper');
    expect(info!.documentation).toContain('Helper function');
  });

  it('getSymbolInfo returns null for unknown symbol', () => {
    const data = new ScipIndexData('/project');
    expect(data.getSymbolInfo('unknown')).toBeNull();
  });

  it('addExternalSymbol stores metadata', () => {
    const data = new ScipIndexData('/project');
    data.addExternalSymbol({
      symbol: 'ext . lib . Thing .',
      documentation: ['External thing'],
      relationships: [],
      displayName: 'Thing',
      signatureDocumentation: { text: 'class Thing', language: '' },
      kind: 0,
      enclosingSymbol: '',
    } as any);

    const info = data.getSymbolInfo('ext . lib . Thing .');
    expect(info).not.toBeNull();
    expect(info!.displayName).toBe('Thing');
  });

  it('merge combines two ScipIndexData instances', () => {
    const a = new ScipIndexData('/project');
    const b = new ScipIndexData('/project');

    a.addDocument({
      relativePath: 'a.ts',
      language: 'typescript',
      occurrences: [
        { range: [0, 0, 5], symbol: 'sym.a', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    b.addDocument({
      relativePath: 'b.ts',
      language: 'python',
      occurrences: [
        { range: [0, 0, 5], symbol: 'sym.b', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    a.merge(b);
    expect(a.fileCount).toBe(2);
    expect(a.definitionCount).toBe(2);
    expect(a.languages.has('typescript')).toBe(true);
    expect(a.languages.has('python')).toBe(true);
  });

  it('merge preserves existing entries (no overwrite)', () => {
    const a = new ScipIndexData('/project');
    const b = new ScipIndexData('/project');

    a.addDocument({
      relativePath: 'a.ts',
      language: 'typescript',
      occurrences: [
        { range: [0, 0, 5], symbol: 'sym.a', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    b.addDocument({
      relativePath: 'a.ts',
      language: 'typescript',
      occurrences: [
        { range: [10, 0, 5], symbol: 'sym.a', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    a.merge(b);
    // a already had a.ts — merge should not overwrite
    const def = a.getDefinition('sym.a');
    expect(def!.line).toBe(0); // from first addition
  });

  it('skips local symbols in definition index', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'x.ts',
      language: 'typescript',
      occurrences: [
        { range: [0, 0, 5], symbol: 'local 42', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    expect(data.getDefinition('local 42')).toBeNull();
    expect(data.definitionCount).toBe(0);
  });

  it('rejects documents that escape project root', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: '../etc/passwd',
      language: '',
      occurrences: [],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    expect(data.fileCount).toBe(0);
  });

  it('handles 4-element range (multi-line occurrence)', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/multi.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [5, 2, 8, 10], // startLine=5, startChar=2, endLine=8, endChar=10
          symbol: 'ts . multi . bigBlock .',
          symbolRoles: 1,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
          enclosingRange: [],
        },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    // Should find the occurrence when querying within the multi-line range
    const occ = data.findOccurrence('/project/src/multi.ts', 5, 5);
    expect(occ).not.toBeNull();
    expect(occ!.symbol).toBe('ts . multi . bigBlock .');
    expect(occ!.endLine).toBe(8);
  });

  it('findOccurrence returns null for empty occurrence list', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/empty.ts',
      language: 'typescript',
      occurrences: [],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    expect(data.findOccurrence('/project/src/empty.ts', 0, 0)).toBeNull();
  });

  it('findOccurrence uses nearby match within 5 characters', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/near.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [10, 20, 30],
          symbol: 'ts . near . sym .',
          symbolRoles: 0,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
          enclosingRange: [],
        },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    // Query 3 chars away — should still match
    const occ = data.findOccurrence('/project/src/near.ts', 10, 23);
    expect(occ).not.toBeNull();
    expect(occ!.symbol).toBe('ts . near . sym .');
  });

  it('findOccurrence returns null when too far away', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/far.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [10, 20, 30],
          symbol: 'ts . far . sym .',
          symbolRoles: 0,
          overrideDocumentation: [],
          syntaxKind: 0,
          diagnostics: [],
          enclosingRange: [],
        },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    // Query 50 chars away — should NOT match
    const occ = data.findOccurrence('/project/src/far.ts', 10, 70);
    expect(occ).toBeNull();
  });

  it('merges duplicate documents for same path', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/dup.ts',
      language: 'typescript',
      occurrences: [
        { range: [0, 0, 5], symbol: 'sym.first', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);
    data.addDocument({
      relativePath: 'src/dup.ts',
      language: 'typescript',
      occurrences: [
        { range: [10, 0, 5], symbol: 'sym.second', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    // Both symbols should be accessible
    expect(data.getDefinition('sym.first')).not.toBeNull();
    expect(data.getDefinition('sym.second')).not.toBeNull();
    // But file count stays 1 since path is the same
    expect(data.fileCount).toBe(1);
  });

  it('skips occurrences with range < 3 elements', () => {
    const data = new ScipIndexData('/project');
    data.addDocument({
      relativePath: 'src/badrange.ts',
      language: 'typescript',
      occurrences: [
        { range: [0, 5], symbol: 'bad.range', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
        { range: [1, 0, 10], symbol: 'good.range', symbolRoles: 1, overrideDocumentation: [], syntaxKind: 0, diagnostics: [], enclosingRange: [] },
      ],
      symbols: [],
      $typeName: 'scip.Document',
    } as any);

    expect(data.getDefinition('bad.range')).toBeNull();
    expect(data.getDefinition('good.range')).not.toBeNull();
  });
});

// ─── extractSignatureFromDocs ─────────────────────────────────────────────────

describe('extractSignatureFromDocs', () => {
  it('returns signatureText when available', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: [],
      displayName: 'test',
      signatureText: 'function test(): void',
    };
    expect(extractSignatureFromDocs(info)).toBe('function test(): void');
  });

  it('strips code fences from signatureText', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: [],
      displayName: 'test',
      signatureText: '```typescript\nfunction test(): void\n```',
    };
    expect(extractSignatureFromDocs(info)).toBe('function test(): void');
  });

  it('returns null when signatureText is empty', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: [],
      displayName: 'test',
      signatureText: '',
    };
    expect(extractSignatureFromDocs(info)).toBeNull();
  });

  it('falls back to documentation when no signatureText', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: ['function test(x: number): string'],
      displayName: 'test',
      signatureText: null,
    };
    expect(extractSignatureFromDocs(info)).toBe('function test(x: number): string');
  });

  it('returns null when documentation has no signature-like text', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: ['This is just a description with no code.'],
      displayName: 'test',
      signatureText: null,
    };
    expect(extractSignatureFromDocs(info)).toBeNull();
  });

  it('detects signature with arrow return type', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: ['fn foo(x: i32) -> String'],
      displayName: 'test',
      signatureText: null,
    };
    expect(extractSignatureFromDocs(info)).toBe('fn foo(x: i32) -> String');
  });

  it('detects signature with colon type annotation', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: ['val x: Int'],
      displayName: 'test',
      signatureText: null,
    };
    expect(extractSignatureFromDocs(info)).toBe('val x: Int');
  });

  it('detects signature with parentheses', () => {
    const info: ScipSymbolInfo = {
      symbol: 'test',
      documentation: ['greet(name)'],
      displayName: 'test',
      signatureText: null,
    };
    expect(extractSignatureFromDocs(info)).toBe('greet(name)');
  });
});
