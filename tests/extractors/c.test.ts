import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { CExtractor } from '../../src/indexer/extractors/c.js';

const ext = new CExtractor();
const fixture = (name: string) => parseAndExtractStrict('c', path.join(import.meta.dirname, '../fixtures/c', name), ext);

describe('C function extraction', () => {
  const r = fixture('functions.c');
  test('extracts functions', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'print_point', kind: 'function' }));
  });
});

describe('C struct extraction', () => {
  const r = fixture('struct.c');
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct' }));
  });
});

describe('C enum extraction', () => {
  const r = fixture('enum.c');
  test('extracts enum', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });
});

describe('C typedef extraction', () => {
  const r = fixture('typedef.c');
  test('extracts typedefs', () => {
    const typedefs = r.symbols.filter(s => s.kind === 'typedef');
    expect(typedefs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('C macro extraction', () => {
  const r = fixture('macros.c');
  test('extracts function-like and object-like macros', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'SQUARE', kind: 'macro' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'PI', kind: 'macro' }));
  });
});

describe('C function prototype extraction', () => {
  const r = fixture('prototype.c');
  test('extracts forward declaration', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'multiply', kind: 'function' }));
  });
});

describe('C include extraction', () => {
  const r = fixture('includes.c');
  test('extracts system and local includes', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'stdio.h' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'myheader.h' }));
  });
});

describe('C direct call-ref', () => {
  const r = fixture('callref-direct.c');
  test('extracts direct call with callerSymbol', () => {
    expect(r.callRefs).toHaveLength(1);
    expect(r.callRefs[0]).toMatchObject({ calleeRaw: 'bar', callerSymbol: 'foo', callKind: 'direct' });
  });
});

describe('C macro call-ref', () => {
  const r = fixture('callref-macro.c');
  test('tags macro call with callKind=macro', () => {
    const macroRefs = r.callRefs.filter(c => c.callKind === 'macro');
    expect(macroRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'SQUARE' }));
  });
});

describe('C indirect call-ref via function pointer', () => {
  const r = fixture('callref-indirect.c');
  test('tags indirect call with isIndirect=true', () => {
    const indirect = r.callRefs.filter(c => c.isIndirect === true);
    expect(indirect.length).toBeGreaterThan(0);
    expect(indirect.every(c => c.callKind === 'indirect')).toBe(true);
  });
});

describe('C parameter type ref', () => {
  const r = fixture('typeref-parameter.c');
  test('extracts parameter type ref', () => {
    const params = r.typeRefs.filter(t => t.refKind === 'parameter');
    expect(params).toContainEqual(expect.objectContaining({ typeRaw: 'Point', enclosingSymbol: 'print_point' }));
  });
});

describe('C variable type ref', () => {
  const r = fixture('typeref-variable.c');
  test('extracts variable type ref', () => {
    const vars = r.typeRefs.filter(t => t.refKind === 'variable');
    expect(vars).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});

describe('C header file', () => {
  const headerResult = parseAndExtractStrict('c', path.join(import.meta.dirname, '../fixtures/c/sample.h'), ext);
  test('extracts function prototypes', () => {
    const funcs = headerResult.symbols.filter(s => s.kind === 'function');
    expect(funcs.map(f => f.name)).toEqual(expect.arrayContaining(['buffer_create', 'buffer_destroy', 'buffer_append']));
  });
  test('extracts struct, enum, typedef, and macro', () => {
    expect(headerResult.symbols.some(s => s.kind === 'struct' && s.name === 'Buffer')).toBe(true);
    expect(headerResult.symbols.some(s => s.kind === 'enum' && s.name === 'Status')).toBe(true);
    expect(headerResult.symbols.some(s => s.kind === 'typedef')).toBe(true);
    expect(headerResult.symbols.some(s => s.kind === 'macro' && s.name === 'MAX_SIZE')).toBe(true);
  });
});
