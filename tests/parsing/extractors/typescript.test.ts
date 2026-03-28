import { describe, it, expect } from 'vitest';
import { TypeScriptExtractor } from '../../../src/parsing/extractors/typescript.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new TypeScriptExtractor();

function extract(source: string, filePath = 'test.ts') {
  const tree = pool.parse('typescript', source)!;
  return extractor.extract(tree, source, filePath);
}

describe('TypeScriptExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function declaration', () => {
      const result = extract('function greet(name: string): string { return name; }');
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
      expect(sym!.startLine).toBe(0);
    });

    it('extracts generator function', () => {
      const result = extract('function* gen() { yield 1; }');
      const sym = result.symbols.find(s => s.name === 'gen');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts class declaration', () => {
      const source = `class MyClass {
  constructor() {}
  greet() { return 'hi'; }
}`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'MyClass');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
    });

    it('extracts class constructor and methods as separate symbols', () => {
      const source = `class Foo {
  constructor(x: number) {}
  bar(): void {}
}`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'constructor' && s.kind === 'constructor')).toBeDefined();
      expect(result.symbols.find(s => s.name === 'bar' && s.kind === 'method')).toBeDefined();

      const bar = result.symbols.find(s => s.name === 'bar')!;
      expect(bar.parentName).toBe('Foo');
    });

    it('extracts interface declaration', () => {
      const result = extract('interface Greetable { greet(): string; }');
      const sym = result.symbols.find(s => s.name === 'Greetable');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('interface');
    });

    it('extracts type alias', () => {
      const result = extract('type ID = string | number;');
      const sym = result.symbols.find(s => s.name === 'ID');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('type');
    });

    it('extracts enum declaration', () => {
      const result = extract('enum Color { Red, Green, Blue }');
      const sym = result.symbols.find(s => s.name === 'Color');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('enum');
    });

    it('extracts arrow function assigned to const', () => {
      const result = extract('const add = (a: number, b: number) => a + b;');
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts function expression assigned to const', () => {
      const result = extract('const multiply = function(a: number, b: number) { return a * b; };');
      const sym = result.symbols.find(s => s.name === 'multiply');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('marks exported symbols', () => {
      const result = extract('export function publicFn() {}');
      const sym = result.symbols.find(s => s.name === 'publicFn');
      expect(sym).toBeDefined();
      expect(sym!.isExported).toBe(true);
    });

    it('does not mark non-exported symbols', () => {
      const result = extract('function privateFn() {}');
      const sym = result.symbols.find(s => s.name === 'privateFn');
      expect(sym).toBeDefined();
      expect(sym!.isExported).toBeUndefined();
    });

    it('extracts docComments in .d.ts files', () => {
      const source = `/** Greets someone */\nfunction greet(): void;`;
      const result = extract(source, 'types.d.ts');
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.docComment).toContain('Greets someone');
    });

    it('extracts function signature (without body)', () => {
      const result = extract('function greet(): void;', 'types.d.ts');
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });
  });

  describe('import extraction', () => {
    it('extracts named imports', () => {
      const result = extract("import { foo, bar } from './module';");
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('./module');
    });

    it('extracts default import', () => {
      const result = extract("import React from 'react';");
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('react');
    });

    it('extracts namespace import', () => {
      const result = extract("import * as path from 'path';");
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toBe('path');
    });

    it('extracts dynamic import', () => {
      const result = extract("const mod = import('./lazy');");
      expect(result.imports.some(i => i.source === './lazy')).toBe(true);
    });
  });

  describe('call ref extraction', () => {
    it('extracts direct function calls', () => {
      const source = `function foo() { bar(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'bar');
      expect(ref).toBeDefined();
      expect(ref!.callerSymbol).toBe('foo');
    });

    it('extracts method calls', () => {
      const source = `function foo() { obj.method(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'obj.method');
      expect(ref).toBeDefined();
    });

    it('extracts chained calls', () => {
      const source = `function foo() { a.b().c(); }`;
      const result = extract(source);
      expect(result.callRefs.length).toBeGreaterThan(0);
    });
  });

  describe('relationship extraction', () => {
    it('extracts extends relationship', () => {
      const source = `class Child extends Parent {}`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.kind === 'extends');
      expect(rel).toBeDefined();
      expect(rel!.fromSymbol).toBe('Child');
      expect(rel!.toSymbol).toBe('Parent');
    });
  });

  describe('type ref extraction', () => {
    it('extracts parameter type refs', () => {
      const source = `function foo(x: MyType): void {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType');
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('parameter');
    });

    it('extracts return type refs', () => {
      const source = `function foo(): MyResult { return {} as any; }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyResult');
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('return');
    });

    it('extracts as-expression cast type refs', () => {
      const source = `const x = something as MyType;`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType');
      expect(ref).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = extract('');
      expect(result.symbols).toEqual([]);
      expect(result.imports).toEqual([]);
    });

    it('handles source with syntax errors', () => {
      const result = extract('function { broken; !!!');
      // Should not throw, can produce partial results
      expect(result).toBeDefined();
    });

    it('attaches astNode to symbols', () => {
      const result = extract('function foo() {}');
      const sym = result.symbols.find(s => s.name === 'foo');
      expect(sym).toBeDefined();
      expect(sym!.astNode).toBeDefined();
    });
  });
});
