import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { RustExtractor } from '../../../src/parsing/extractors/rust.js';

const ext = new RustExtractor();
const fixture = (name: string) => parseAndExtractStrict('rust', path.join(import.meta.dirname, '../../fixtures/rust', name), ext);

describe('Rust struct extraction', () => {
  const r = fixture('struct.rs');
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'struct' }));
  });
});

describe('Rust enum extraction', () => {
  const r = fixture('enum.rs');
  test('extracts enum', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });
});

describe('Rust trait extraction', () => {
  const r = fixture('trait.rs');
  test('extracts trait', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'trait' }));
  });
});

describe('Rust impl extraction', () => {
  const r = fixture('impl.rs');
  test('extracts impl with trait relationship', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape for Circle', kind: 'impl' }));
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'implements', toSymbol: 'Shape' }));
  });
});

describe('Rust function extraction', () => {
  const r = fixture('function.rs');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Rust use import extraction', () => {
  const r = fixture('imports.rs');
  test('extracts use imports', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'std::fmt' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'std::collections::HashMap' }));
  });
});

describe('Rust call-ref extraction', () => {
  const r = fixture('callref.rs');
  test('extracts macro call ref', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'format!', callerSymbol: 'greet' }));
  });
});

describe('Rust return type ref', () => {
  const r = fixture('typeref-return.rs');
  test('extracts return type ref', () => {
    const returns = r.typeRefs.filter(t => t.refKind === 'return');
    expect(returns).toContainEqual(expect.objectContaining({ typeRaw: 'Config', enclosingSymbol: 'load' }));
  });
});

describe('Rust parameter type ref', () => {
  const r = fixture('typeref-parameter.rs');
  test('extracts parameter type ref', () => {
    const params = r.typeRefs.filter(t => t.refKind === 'parameter');
    expect(params).toContainEqual(expect.objectContaining({ typeRaw: 'Config', enclosingSymbol: 'save' }));
  });
});

describe('Rust cast type ref', () => {
  const r = fixture('typeref-cast.rs');
  test('parses file with as-cast without error', () => {
    // Rust as-casts use primitive types that don't produce type_identifier nodes
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });
});

describe('Rust variable type ref', () => {
  const r = fixture('typeref-variable.rs');
  test('extracts variable type ref', () => {
    const vars = r.typeRefs.filter(t => t.refKind === 'variable');
    expect(vars).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});
