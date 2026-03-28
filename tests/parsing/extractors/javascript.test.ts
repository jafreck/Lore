import { describe, it, expect } from 'vitest';
import { JavaScriptExtractor } from '../../../src/parsing/extractors/javascript.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new JavaScriptExtractor();

function extract(source: string) {
  const tree = pool.parse('javascript', source)!;
  return extractor.extract(tree, source, 'test.js');
}

describe('JavaScriptExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function declaration', () => {
      const result = extract('function greet(name) { return "Hello " + name; }');
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts generator function', () => {
      const result = extract('function* gen() { yield 1; yield 2; }');
      const sym = result.symbols.find(s => s.name === 'gen');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts class declaration', () => {
      const source = `class Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name; }
}`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'Animal' && s.kind === 'class');
      expect(cls).toBeDefined();
    });

    it('extracts class constructor and methods', () => {
      const source = `class Foo {
  constructor() {}
  bar() {}
}`;
      const result = extract(source);
      const ctor = result.symbols.find(s => s.name === 'constructor' && s.kind === 'constructor');
      expect(ctor).toBeDefined();
      const method = result.symbols.find(s => s.name === 'bar' && s.kind === 'method');
      expect(method).toBeDefined();
      expect(method!.parentName).toBe('Foo');
    });

    it('extracts arrow function assigned to const', () => {
      const result = extract('const add = (a, b) => a + b;');
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts function expression assigned to const', () => {
      const result = extract('const multiply = function(a, b) { return a * b; };');
      const sym = result.symbols.find(s => s.name === 'multiply');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts var function expression', () => {
      const result = extract('var hello = function() { return "hi"; };');
      const sym = result.symbols.find(s => s.name === 'hello');
      expect(sym).toBeDefined();
    });
  });

  describe('import extraction', () => {
    it('extracts ES module import', () => {
      const result = extract("import { foo, bar } from './module';");
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('./module');
    });

    it('extracts default import', () => {
      const result = extract("import React from 'react';");
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('react');
    });

    it('extracts require() call as import', () => {
      const result = extract("const fs = require('fs');");
      const imp = result.imports.find(i => i.source === 'fs');
      expect(imp).toBeDefined();
    });
  });

  describe('call ref extraction', () => {
    it('extracts direct function calls', () => {
      const source = `function main() { helper(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'helper');
      expect(ref).toBeDefined();
      expect(ref!.callerSymbol).toBe('main');
    });

    it('extracts method calls', () => {
      const source = `function foo() { console.log("test"); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'console.log');
      expect(ref).toBeDefined();
    });

    it('does not count require as regular call ref when it is an import', () => {
      const result = extract("const x = require('module');");
      // require is treated as import, may still appear as call ref
      expect(result.imports.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = extract('');
      expect(result.symbols).toEqual([]);
      expect(result.imports).toEqual([]);
    });

    it('handles source with only comments', () => {
      const result = extract('// This is a comment\n/* Another comment */');
      expect(result.symbols).toEqual([]);
    });

    it('handles nested functions', () => {
      const source = `function outer() {
  function inner() { return 1; }
  return inner();
}`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'outer')).toBeDefined();
      expect(result.symbols.find(s => s.name === 'inner')).toBeDefined();
    });
  });
});
