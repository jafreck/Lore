import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { LuaExtractor } from '../../src/indexer/extractors/lua.js';

const ext = new LuaExtractor();
const fixture = (name: string) => parseAndExtractStrict('lua', path.join(import.meta.dirname, '../fixtures/lua', name), ext);

describe('Lua function extraction', () => {
  const r = fixture('function.lua');
  test('extracts function', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'greet', kind: 'function' });
  });
});

describe('Lua local function extraction', () => {
  const r = fixture('local-function.lua');
  test('extracts local function', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'helper', kind: 'function' });
  });
});

describe('Lua require import extraction', () => {
  const r = fixture('imports.lua');
  test('extracts require calls as imports', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'json' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'utils' }));
  });
});

describe('Lua call-ref extraction', () => {
  const r = fixture('callref.lua');
  test('extracts call refs', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});
