import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { JuliaExtractor } from '../../src/indexer/extractors/julia.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('julia', path.join(fixtureDir, 'julia/sample.jl'), new JuliaExtractor());

describe('Julia symbols', () => {
  test('extracts module', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Sample', kind: 'module' }));
  });

  test('extracts struct', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct' }));
  });

  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });
});

describe('Julia imports', () => {
  test('extracts using statement', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'LinearAlgebra' }));
  });

  test('extracts import statement', () => {
    expect(result.imports.length).toBeGreaterThan(1);
  });
});

describe('Julia call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
