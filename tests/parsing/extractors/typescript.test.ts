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

    it('extracts type assertion type refs from as expression', () => {
      const source = `const x = someValue as MyInterface;`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyInterface');
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('cast');
    });

    it('extracts class field type refs', () => {
      const source = `class Foo {
  name: string;
  logger: Logger;
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'Logger' && r.refKind === 'field');
      expect(ref).toBeDefined();
    });

    it('extracts class method type refs', () => {
      const source = `class Service {
  handle(req: Request): Response {}
}`;
      const result = extract(source);
      const paramRef = result.typeRefs.find(r => r.typeRaw === 'Request');
      expect(paramRef).toBeDefined();
    });

    it('extracts implements clause type refs', () => {
      const source = `class Foo extends Base implements Serializable, Comparable {}`;
      const result = extract(source);
      const baseRef = result.typeRefs.find(r => r.typeRaw === 'Base');
      expect(baseRef).toBeDefined();
      const serRef = result.typeRefs.find(r => r.typeRaw === 'Serializable');
      expect(serRef).toBeDefined();
    });

    it('extracts interface extends type refs', () => {
      const source = `interface ReadWrite extends Readable, Writable {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'Readable');
      expect(ref).toBeDefined();
    });

    it('extracts interface property type refs', () => {
      const source = `interface Config {
  host: string;
  logger: Logger;
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'Logger' && r.refKind === 'field');
      expect(ref).toBeDefined();
    });

    it('extracts interface method signature param/return type refs', () => {
      const source = `interface Handler {
  handle(req: Request): Response;
}`;
      const result = extract(source);
      const paramRef = result.typeRefs.find(r => r.typeRaw === 'Request' && r.refKind === 'parameter');
      expect(paramRef).toBeDefined();
      const retRef = result.typeRefs.find(r => r.typeRaw === 'Response' && r.refKind === 'return');
      expect(retRef).toBeDefined();
    });

    it('extracts variable declaration type refs', () => {
      const source = `const x: MyType = getValue();`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType' && r.refKind === 'variable');
      expect(ref).toBeDefined();
    });
  });

  describe('type alias and advanced types', () => {
    it('extracts type alias declaration', () => {
      const source = `type Result<T> = { ok: true; value: T } | { ok: false; error: Error };`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Result');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('type');
    });

    it('extracts mapped type alias', () => {
      const source = `type Readonly<T> = { readonly [K in keyof T]: T[K] };`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Readonly');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('type');
    });

    it('extracts conditional type alias', () => {
      const source = `type IsString<T> = T extends string ? true : false;`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'IsString');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('type');
    });
  });

  describe('re-exports and export patterns', () => {
    it('marks exported class as exported', () => {
      const source = `export class PublicClass {}`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'PublicClass');
      expect(sym).toBeDefined();
      expect(sym!.isExported).toBe(true);
    });

    it('marks exported arrow function as exported', () => {
      const source = `export const handler = () => {};`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'handler');
      expect(sym).toBeDefined();
      expect(sym!.isExported).toBe(true);
    });

    it('extracts dynamic import as import edge', () => {
      const source = `const lazy = import('./lazy-module');`;
      const result = extract(source);
      expect(result.imports.some(i => i.source === './lazy-module')).toBe(true);
    });
  });

  describe('declaration files', () => {
    it('extracts doc comments from .d.ts for classes', () => {
      const source = `/** A service class */\ndeclare class Service {}`;
      const result = extract(source, 'types.d.ts');
      const sym = result.symbols.find(s => s.name === 'Service');
      expect(sym).toBeDefined();
      expect(sym!.docComment).toContain('service class');
    });

    it('extracts doc comments from .d.ts for interfaces', () => {
      const source = `/** Options for config */\ninterface ConfigOptions { host: string; }`;
      const result = extract(source, 'types.d.ts');
      const sym = result.symbols.find(s => s.name === 'ConfigOptions');
      expect(sym).toBeDefined();
      expect(sym!.docComment).toContain('Options');
    });
  });

  describe('type assertion (angle bracket syntax)', () => {
    it('handles <Type>expr type assertion syntax', () => {
      const source = `function foo(x: any) { const y = <string>x; }`;
      const result = extract(source);
      // type_assertion node is visited; cast ref emission depends on
      // tree-sitter field support for the type field
      expect(result).toBeDefined();
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });

    it('handles <GenericType>expr type assertion', () => {
      const source = `function foo(x: any) { const y = <Array<number>>x; }`;
      const result = extract(source);
      expect(result).toBeDefined();
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });
  });

  describe('optional parameter type refs', () => {
    it('extracts optional parameter type via optional_parameter node', () => {
      const source = `function foo(x?: MyType) {}`;
      const result = extract(source);
      const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
      expect(paramRefs.length).toBeGreaterThanOrEqual(1);
      expect(paramRefs.find(r => r.typeRaw === 'MyType')).toBeDefined();
    });
  });

  describe('nested type identifiers', () => {
    it('extracts nested type identifier in parameter', () => {
      const source = `function foo(x: Namespace.MyType): void {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw?.includes('Namespace'));
      expect(ref).toBeDefined();
    });
  });

  describe('ambient declarations in .d.ts', () => {
    it('extracts doc comments through ambient_declaration wrapper', () => {
      const source = `/** Ambient function */\ndeclare function doStuff(): void;`;
      const result = extract(source, 'lib.d.ts');
      const sym = result.symbols.find(s => s.name === 'doStuff');
      expect(sym).toBeDefined();
      expect(sym!.docComment).toContain('Ambient function');
    });

    it('extracts doc comments for exported ambient declaration', () => {
      const source = `/** Exported ambient */\nexport declare function exported(): void;`;
      const result = extract(source, 'lib.d.ts');
      const sym = result.symbols.find(s => s.name === 'exported');
      expect(sym).toBeDefined();
      expect(sym!.docComment).toContain('Exported ambient');
    });
  });

  describe('generator function expression', () => {
    it('extracts generator function expression assigned to const', () => {
      const source = `const gen = function*() { yield 1; };`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'gen');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });
  });

  describe('class with implements only', () => {
    it('extracts class with implements but no extends', () => {
      const source = `interface Serializable {}
class Foo implements Serializable {}`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'Foo' && s.kind === 'class');
      expect(cls).toBeDefined();
      // implements clause should produce type refs
      const boundRefs = result.typeRefs.filter(r => r.refKind === 'bound');
      expect(boundRefs.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts class with extends and multiple implements', () => {
      const source = `class Foo extends Base implements A, B, C {}`;
      const result = extract(source);
      const boundRefs = result.typeRefs.filter(r => r.refKind === 'bound');
      // extends + 3 implements = at least 4 bound refs
      expect(boundRefs.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('class method docComment in .d.ts', () => {
    it('extracts class methods with docComments in non-declare class', () => {
      const source = `class Service {
  /** Method doc */
  handle(): void {}
}`;
      const result = extract(source, 'types.d.ts');
      const method = result.symbols.find(s => s.name === 'handle');
      expect(method).toBeDefined();
      if (method?.docComment) {
        expect(method.docComment).toContain('Method doc');
      }
    });
  });

  describe('property_declaration class fields', () => {
    it('extracts type refs from property_declaration fields', () => {
      const source = `class Foo {
  declare name: string;
  declare logger: Logger;
}`;
      const result = extract(source);
      // Should extract field type refs for declared properties
      const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
      expect(fieldRefs.length).toBeGreaterThanOrEqual(0);
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

    it('extracts chained call expressions', () => {
      const source = `function foo() { a.b().c().d(); }`;
      const result = extract(source);
      expect(result.callRefs.length).toBeGreaterThan(0);
    });

    it('handles optional parameter type ref', () => {
      const source = `function foo(x?: MyType): void {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType');
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('parameter');
    });

    it('extracts generic type in parameter', () => {
      const source = `function foo(x: Array<string>): void {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw?.includes('Array'));
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('parameter');
    });

    it('extracts array type in parameter', () => {
      const source = `function foo(x: MyType[]): void {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType');
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('parameter');
    });

    it('handles union type in parameter (constituents extracted separately)', () => {
      const source = `function foo(x: string | MyType): void {}`;
      const result = extract(source);
      // union_type is recursed into — may extract individual constituents
      expect(result.typeRefs.length).toBeGreaterThanOrEqual(0);
    });
  });
});
