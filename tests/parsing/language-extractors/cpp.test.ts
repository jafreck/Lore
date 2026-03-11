import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { CppExtractor } from '../../../src/parsing/extractors/cpp.js';

const ext = new CppExtractor();
const fixture = (name: string) => parseAndExtractStrict('cpp', path.join(import.meta.dirname, '../../fixtures/cpp', name), ext);

describe('C++ class extraction', () => {
  const r = fixture('class.cpp');
  test('extracts classes', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Greeter', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Base', kind: 'class' }));
  });
  test('extracts inheritance relationship', () => {
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'extends', fromSymbol: 'Greeter', toSymbol: 'Base' }));
  });
});

describe('C++ struct extraction', () => {
  const r = fixture('struct.cpp');
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Callback', kind: 'struct' }));
  });
});

describe('C++ enum extraction', () => {
  const r = fixture('enum.cpp');
  test('extracts enum', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });
});

describe('C++ typedef extraction', () => {
  const r = fixture('typedef.cpp');
  test('extracts typedef', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'HandlerFn', kind: 'typedef' }));
  });
});

describe('C++ macro extraction', () => {
  const r = fixture('macros.cpp');
  test('extracts macros', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'MAX', kind: 'macro' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'VERSION', kind: 'macro' }));
  });
});

describe('C++ function extraction', () => {
  const r = fixture('function.cpp');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('C++ function prototype extraction', () => {
  const r = fixture('prototype.cpp');
  test('extracts forward declaration', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('C++ include extraction', () => {
  const r = fixture('includes.cpp');
  test('extracts includes', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'iostream' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'myheader.h' }));
  });
});

describe('C++ direct call-ref', () => {
  const r = fixture('callref-direct.cpp');
  test('extracts call with callerSymbol', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'bar', callerSymbol: 'foo', callKind: 'direct' }));
  });
});

describe('C++ macro call-ref', () => {
  const r = fixture('callref-macro.cpp');
  test('tags macro call', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'MAX', callKind: 'macro' }));
  });
});

describe('C++ indirect call-ref', () => {
  const r = fixture('callref-indirect.cpp');
  test('tags indirect call', () => {
    const indirect = r.callRefs.filter(c => c.isIndirect === true);
    expect(indirect.length).toBeGreaterThan(0);
    expect(indirect[0]!.callKind).toBe('indirect');
  });
});

describe('C++ function type refs', () => {
  const r = fixture('typeref-function.cpp');
  test('extracts parameter and return type refs', () => {
    const params = r.typeRefs.filter(t => t.refKind === 'parameter');
    const returns = r.typeRefs.filter(t => t.refKind === 'return');
    expect(params).toContainEqual(expect.objectContaining({ typeRaw: 'Config' }));
    expect(returns).toContainEqual(expect.objectContaining({ typeRaw: 'Config' }));
  });
});

describe('C++ field type refs', () => {
  const r = fixture('typeref-field.cpp');
  test('extracts field type ref', () => {
    const fields = r.typeRefs.filter(t => t.refKind === 'field');
    expect(fields).toContainEqual(expect.objectContaining({ typeRaw: 'Item' }));
  });
});

describe('C++ variable type refs', () => {
  const r = fixture('typeref-variable.cpp');
  test('extracts variable type ref', () => {
    const vars = r.typeRefs.filter(t => t.refKind === 'variable');
    expect(vars).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});

describe('C++ bound type refs from inheritance', () => {
  const r = fixture('typeref-bound.cpp');
  test('extracts bound type ref', () => {
    const bounds = r.typeRefs.filter(t => t.refKind === 'bound');
    expect(bounds).toContainEqual(expect.objectContaining({ typeRaw: 'Base' }));
  });
});
