import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ElmExtractor } from '../../src/indexer/extractors/elm.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('elm', path.join(fixtureDir, 'elm/sample.elm'), new ElmExtractor());

describe('Elm symbols', () => {
  test('extracts type alias', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'type' }));
  });

  test('extracts union type', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'type' }));
  });

  test('extracts port annotation', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'sendMessage', kind: 'port' }));
  });

  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts plain value declaration', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'version' }));
  });

  test('extracts function with body call refs', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'view' }));
  });
});

describe('Elm imports', () => {
  test('extracts imports with exposing', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('Elm call refs', () => {
  test('produces non-empty call refs from view function', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
