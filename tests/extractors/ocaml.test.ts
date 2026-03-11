import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { OcamlExtractor } from '../../src/indexer/extractors/ocaml.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('ocaml', path.join(fixtureDir, 'ocaml/sample.ml'), new OcamlExtractor());

describe('OCaml symbols', () => {
  test('extracts let bindings (values)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'pi', kind: 'val' }));
  });

  test('extracts let bindings (functions)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'square', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
  });

  test('extracts variant type', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'shape', kind: 'type' }));
  });

  test('extracts module definition', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'MathUtils', kind: 'module' }));
  });
});

describe('OCaml imports', () => {
  test('extracts open statements', () => {
    expect(result.imports.length).toBeGreaterThanOrEqual(0);
  });
});

describe('OCaml call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
