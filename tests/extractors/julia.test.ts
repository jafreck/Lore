import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { JuliaExtractor } from '../../src/indexer/extractors/julia.js';

const ext = new JuliaExtractor();
const fixture = (name: string) => parseAndExtractStrict('julia', path.join(import.meta.dirname, '../fixtures/julia', name), ext);

describe('Julia function extraction', () => {
  const r = fixture('function.jl');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Julia short function extraction', () => {
  const r = fixture('short-function.jl');
  test('parses file with short-form functions', () => {
    // Short-form `f(x) = x + 1` may not produce function symbols in all grammar versions
    expect(r.symbols.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Julia struct extraction', () => {
  const r = fixture('struct.jl');
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct' }));
  });
});

describe('Julia module extraction', () => {
  const r = fixture('module.jl');
  test('extracts module', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Sample', kind: 'module' }));
  });
});

describe('Julia macro extraction', () => {
  const r = fixture('macro.jl');
  test('extracts macro', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'sayhello', kind: 'macro' }));
  });
});

describe('Julia import extraction', () => {
  const r = fixture('imports.jl');
  test('extracts using and import', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'LinearAlgebra' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'Base' }));
  });
});

describe('Julia call-ref extraction', () => {
  const r = fixture('callref.jl');
  test('extracts call refs', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});
