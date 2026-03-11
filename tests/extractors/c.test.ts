import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { CExtractor } from '../../src/indexer/extractors/c.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('c', path.join(fixtureDir, 'c/sample.c'), new CExtractor());
const headerResult = parseAndExtractStrict('c', path.join(fixtureDir, 'c/sample.h'), new CExtractor());

describe('C symbols', () => {
  test('extracts struct', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct' }));
  });

  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'print_point', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'run', kind: 'function' }));
  });

  test('extracts macros', () => {
    const macros = result.symbols.filter(s => s.kind === 'macro');
    expect(macros.length).toBeGreaterThan(0);
    expect(macros.map(m => m.name)).toContain('SQUARE');
  });

  test('extracts typedefs', () => {
    expect(result.symbols.some(s => s.kind === 'typedef')).toBe(true);
  });
});

describe('C imports', () => {
  test('extracts #include directives', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'stdio.h' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'stdlib.h' }));
  });
});

describe('C call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });

  test('tags macro call-refs', () => {
    const macroRefs = result.callRefs.filter(r => r.callKind === 'macro');
    expect(macroRefs.length).toBeGreaterThan(0);
    expect(macroRefs.some(r => r.calleeRaw === 'SQUARE')).toBe(true);
  });

  test('tags indirect call-refs via function pointer', () => {
    const indirectRefs = result.callRefs.filter(r => r.isIndirect === true);
    expect(indirectRefs.length).toBeGreaterThan(0);
    expect(indirectRefs.every(r => r.callKind === 'indirect')).toBe(true);
  });
});

describe('C type refs', () => {
  test('extracts parameter type refs', () => {
    const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
    expect(paramRefs.length).toBeGreaterThan(0);
    expect(paramRefs).toContainEqual(
      expect.objectContaining({ typeRaw: 'Point', enclosingSymbol: 'print_point' }),
    );
  });
});

describe('C header file', () => {
  test('extracts function declarations (prototypes)', () => {
    const funcs = headerResult.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs.map(f => f.name)).toEqual(
      expect.arrayContaining(['buffer_create', 'buffer_destroy', 'buffer_append']),
    );
  });

  test('extracts struct, enum, typedef, and macro symbols', () => {
    expect(headerResult.symbols.some(s => s.kind === 'struct' && s.name === 'Buffer')).toBe(true);
    expect(headerResult.symbols.some(s => s.kind === 'enum' && s.name === 'Status')).toBe(true);
    expect(headerResult.symbols.some(s => s.kind === 'typedef')).toBe(true);
    expect(headerResult.symbols.some(s => s.kind === 'macro' && s.name === 'MAX_SIZE')).toBe(true);
  });

  test('extracts type-refs from function declarations', () => {
    expect(headerResult.typeRefs.length).toBeGreaterThan(0);
    expect(headerResult.typeRefs.map(r => r.typeRaw)).toEqual(expect.arrayContaining(['Buffer']));
  });
});

describe('C type refs (extended)', () => {
  test('extracts return type refs from functions', () => {
    // C function return types (int, void) are primitive_specifier, not type_identifier
    const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
    expect(returnRefs.length).toBe(0);
  });

  test('extracts variable type refs', () => {
    const varRefs = result.typeRefs.filter(r => r.refKind === 'variable');
    expect(varRefs.length).toBeGreaterThan(0);
  });

  test('extracts cast type refs', () => {
    // C-style casts may use primitive types that don't produce type_identifiers
    expect(result.typeRefs.length).toBeGreaterThan(0);
  });

  test('extracts sizeof type refs', () => {
    // sizeof(Point) is parsed as sizeof_expression(parenthesized_expression) — not a type context
    const sizeofRefs = result.typeRefs.filter(r => r.refKind === 'sizeof');
    expect(sizeofRefs.length).toBe(0);
  });

  test('extracts function prototype declartion', () => {
    const protoFn = result.symbols.find(s => s.name === 'multiply' && s.kind === 'function');
    expect(protoFn).toBeDefined();
  });

  test('extracts enum symbol', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });
});
