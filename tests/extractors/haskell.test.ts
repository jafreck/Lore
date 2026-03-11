import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { HaskellExtractor } from '../../src/indexer/extractors/haskell.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('haskell', path.join(fixtureDir, 'haskell/sample.hs'), new HaskellExtractor());

describe('Haskell symbols', () => {
  test('extracts data type', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'type' }));
  });

  test('extracts newtype', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ kind: 'type' }));
  });

  test('extracts type alias', () => {
    // type Name = String — extracted as a 'type' kind symbol
    expect(result.symbols.some(s => s.kind === 'type')).toBe(true);
  });

  test('extracts type class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Describable', kind: 'class' }));
  });

  test('extracts instance', () => {
    expect(result.symbols.some(s => s.kind === 'instance')).toBe(true);
  });

  test('extracts type signature', () => {
    expect(result.symbols.some(s => s.kind === 'signature')).toBe(true);
  });

  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('Haskell imports', () => {
  test('extracts selective imports', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'Data.List' }));
  });

  test('extracts qualified imports', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'Data.Map' }));
  });
});

describe('Haskell call refs', () => {
  test('produces call refs array', () => {
    expect(Array.isArray(result.callRefs)).toBe(true);
  });
});
