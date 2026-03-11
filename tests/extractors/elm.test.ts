import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ElmExtractor } from '../../src/indexer/extractors/elm.js';

const ext = new ElmExtractor();
const fixture = (name: string) => parseAndExtractStrict('elm', path.join(import.meta.dirname, '../fixtures/elm', name), ext);

describe('Elm function extraction', () => {
  const r = fixture('function.elm');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Elm type alias extraction', () => {
  const r = fixture('type-alias.elm');
  test('extracts type alias', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'type' }));
  });
});

describe('Elm custom type extraction', () => {
  const r = fixture('custom-type.elm');
  test('extracts custom type', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'type' }));
  });
});

describe('Elm port extraction', () => {
  const r = fixture('port.elm');
  test('extracts port symbol', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'sendMessage' }));
  });
});

describe('Elm import extraction', () => {
  const r = fixture('imports.elm');
  test('extracts imports', () => {
    expect(r.imports).toHaveLength(2);
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'Html' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'String' }));
  });
});
