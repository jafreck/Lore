import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { HaskellExtractor } from '../../src/indexer/extractors/haskell.js';

const ext = new HaskellExtractor();
const fixture = (name: string) => parseAndExtractStrict('haskell', path.join(import.meta.dirname, '../fixtures/haskell', name), ext);

describe('Haskell function extraction', () => {
  const r = fixture('functions.hs');
  test('extracts function definitions', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('Haskell type signature extraction', () => {
  const r = fixture('signature.hs');
  test('extracts type signature as signature kind', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'signature' }));
  });
});

describe('Haskell data type extraction', () => {
  const r = fixture('data-type.hs');
  test('extracts data type', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'type' }));
  });
});

describe('Haskell class and instance extraction', () => {
  const r = fixture('class-instance.hs');
  test('extracts type class', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Describable', kind: 'class' }));
  });
  test('extracts instance', () => {
    expect(r.symbols.some(s => s.kind === 'instance')).toBe(true);
  });
});

describe('Haskell import extraction', () => {
  const r = fixture('imports.hs');
  test('extracts module sources', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'Data.List' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'Data.Map' }));
  });
});

describe('Haskell call-ref extraction', () => {
  const r = fixture('callref.hs');
  test('produces call refs', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});
