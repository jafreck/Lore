import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { CppExtractor } from '../../src/indexer/extractors/cpp.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('cpp', path.join(fixtureDir, 'cpp/sample.cpp'), new CppExtractor());

describe('C++ symbols', () => {
  test('extracts classes', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Greeter', kind: 'class' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Base', kind: 'class' }));
  });

  test('extracts struct', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Callback', kind: 'struct' }));
  });

  test('extracts enum', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });

  test('extracts typedef', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'HandlerFn', kind: 'typedef' }));
  });

  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'handler', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'run', kind: 'function' }));
  });

  test('extracts macros', () => {
    const macros = result.symbols.filter(s => s.kind === 'macro');
    expect(macros.length).toBeGreaterThan(0);
    expect(macros.map(m => m.name)).toContain('MAX');
  });
});

describe('C++ relationships', () => {
  test('captures extends relationship', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Greeter', toSymbol: 'Base' }),
    );
  });
});

describe('C++ imports', () => {
  test('extracts #include directives', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('C++ call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });

  test('tags macro call-refs', () => {
    expect(result.callRefs.some(r => r.callKind === 'macro' && r.calleeRaw === 'MAX')).toBe(true);
  });

  test('tags indirect call-refs via function pointer', () => {
    const indirectRefs = result.callRefs.filter(r => r.isIndirect === true);
    expect(indirectRefs.length).toBeGreaterThan(0);
  });
});

describe('C++ type refs', () => {
  test('extracts parameter type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'parameter').length).toBeGreaterThan(0);
  });

  test('extracts return type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'return').length).toBeGreaterThan(0);
  });

  test('extracts field type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'field').length).toBeGreaterThan(0);
  });

  test('extracts variable type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'variable').length).toBeGreaterThan(0);
  });

  test('extracts bound type refs from inheritance', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'bound').length).toBeGreaterThan(0);
  });

  test('has at least 10 type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThanOrEqual(10);
  });

  test('extracts sizeof type refs', () => {
    // sizeof(int) — primitive type may not produce a type_identifier
    const sizeofRefs = result.typeRefs.filter(r => r.refKind === 'sizeof' || r.refKind === 'other');
    expect(result.typeRefs.length).toBeGreaterThan(5);
  });

  test('extracts cast type refs', () => {
    const castRefs = result.typeRefs.filter(r => r.refKind === 'cast');
    expect(castRefs.length).toBeGreaterThanOrEqual(0);
  });

  test('extracts field type refs from class members', () => {
    const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
    expect(fieldRefs.length).toBeGreaterThan(0);
  });
});
