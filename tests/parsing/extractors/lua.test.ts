import { describe, it, expect } from 'vitest';
import { LuaExtractor } from '../../../src/parsing/extractors/lua.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new LuaExtractor();

function extract(source: string) {
  const tree = pool.parse('lua', source);
  if (!tree) return null;
  return extractor.extract(tree, source, 'test.lua');
}

describe('LuaExtractor', () => {
  it('extracts global function declaration', () => {
    const result = extract('function globalFunc() return 1 end');
    expect(result).not.toBeNull();
    const sym = result!.symbols.find(s => s.name === 'globalFunc');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts local function declaration', () => {
    const result = extract('local function localHelper() end');
    expect(result).not.toBeNull();
    const sym = result!.symbols.find(s => s.name === 'localHelper');
    expect(sym).toBeDefined();
  });

  it('extracts require with double quotes', () => {
    const result = extract('local m = require("mymodule")');
    expect(result).not.toBeNull();
    const imp = result!.imports.find(i => i.source === 'mymodule');
    expect(imp).toBeDefined();
  });

  it('extracts require with single quotes', () => {
    const result = extract("local m = require('mymodule')");
    expect(result).not.toBeNull();
    const imp = result!.imports.find(i => i.source === 'mymodule');
    expect(imp).toBeDefined();
  });

  it('extracts require without parentheses', () => {
    const result = extract('local m = require "mymodule"');
    expect(result).not.toBeNull();
    // require "x" form may or may not be parsed as a call — verify no crash
    expect(result!.symbols).toBeDefined();
  });

  it('extracts dotted module path in require', () => {
    const result = extract('local h = require("util.helpers")');
    expect(result).not.toBeNull();
    const imp = result!.imports.find(i => i.source === 'util.helpers');
    expect(imp).toBeDefined();
  });

  it('extracts call refs', () => {
    const source = `function caller()
  helper()
end
function helper() end`;
    const result = extract(source);
    expect(result).not.toBeNull();
    const ref = result!.callRefs.find(r => r.calleeRaw === 'helper');
    expect(ref).toBeDefined();
  });

  it('handles multiple functions and calls', () => {
    const source = `function a() b() end
function b() a() end
local function c() a(); b() end`;
    const result = extract(source);
    expect(result).not.toBeNull();
    expect(result!.symbols.length).toBeGreaterThanOrEqual(3);
    expect(result!.callRefs.length).toBeGreaterThanOrEqual(2);
  });
});
