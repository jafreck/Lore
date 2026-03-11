import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { LuaExtractor } from '../../src/indexer/extractors/lua.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('lua', path.join(fixtureDir, 'lua/sample.lua'), new LuaExtractor());

describe('Lua symbols', () => {
  test('extracts global functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts local functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'square', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'clamp', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });
});

describe('Lua imports', () => {
  test('extracts require calls', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'json' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'utils' }));
  });
});

describe('Lua call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
