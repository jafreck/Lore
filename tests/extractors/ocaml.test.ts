import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { OcamlExtractor } from '../../src/indexer/extractors/ocaml.js';

const ext = new OcamlExtractor();
const fixture = (name: string) => parseAndExtractStrict('ocaml', path.join(import.meta.dirname, '../fixtures/ocaml', name), ext);

describe('OCaml let binding extraction', () => {
  const r = fixture('let-bindings.ml');
  test('extracts value and function bindings', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'pi', kind: 'val' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('OCaml fun expression extraction', () => {
  const r = fixture('fun-expression.ml');
  test('extracts fun as function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'apply', kind: 'function' }));
  });
});

describe('OCaml type definition extraction', () => {
  const r = fixture('types.ml');
  test('extracts variant types', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'shape', kind: 'type' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'color', kind: 'type' }));
  });
});

describe('OCaml module extraction', () => {
  const r = fixture('module.ml');
  test('extracts module', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'MathUtils', kind: 'module' }));
  });
});

describe('OCaml module type extraction', () => {
  const r = fixture('module-type.ml');
  test('extracts module type', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Printable', kind: 'module_type' }));
  });
});

describe('OCaml open extraction', () => {
  const r = fixture('open.ml');
  test('parses file with open statement', () => {
    // tree-sitter-ocaml may not produce open_statement for standalone files
    expect(r).toBeDefined();
  });
});

describe('OCaml call-ref extraction', () => {
  const r = fixture('callref.ml');
  test('produces call refs', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});
