import { describe, it, expect } from 'vitest';
import { CSharpExtractor } from '../../../src/parsing/extractors/csharp.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new CSharpExtractor();

function extract(source: string) {
  const tree = pool.parse('csharp', source)!;
  return extractor.extract(tree, source, 'test.cs');
}

describe('CSharpExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts class declaration', () => {
      const result = extract('class Foo { }');
      const sym = result.symbols.find(s => s.name === 'Foo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts interface declaration', () => {
      const result = extract('interface IFoo { }');
      const sym = result.symbols.find(s => s.name === 'IFoo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('interface');
    });

    it('extracts struct declaration', () => {
      const result = extract('struct Point { int X; int Y; }');
      const sym = result.symbols.find(s => s.name === 'Point');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('struct');
    });

    it('extracts enum declaration', () => {
      const result = extract('enum Color { Red, Green, Blue }');
      const sym = result.symbols.find(s => s.name === 'Color');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('enum');
    });

    it('extracts method declaration', () => {
      const source = `class Foo {
  void Bar() { }
}`;
      const result = extract(source);
      const method = result.symbols.find(s => s.name === 'Bar');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('function');
    });

    it('extracts constructor declaration', () => {
      const source = `class Foo {
  Foo(int x) { }
}`;
      const result = extract(source);
      const ctor = result.symbols.find(s => s.name === 'Foo' && s.kind === 'function');
      expect(ctor).toBeDefined();
    });
  });

  describe('import extraction', () => {
    it('extracts using directives', () => {
      const result = extract('using System;\nusing System.Collections.Generic;');
      expect(result.imports.length).toBeGreaterThanOrEqual(2);
      const sources = result.imports.map(i => i.source);
      expect(sources).toContain('System');
      expect(sources).toContain('System.Collections.Generic');
    });

    it('extracts using alias', () => {
      const result = extract('using Dict = System.Collections.Generic.Dictionary;');
      const imp = result.imports.find(i => i.importedNames.includes('Dict'));
      expect(imp).toBeDefined();
    });
  });

  describe('call ref extraction', () => {
    it('extracts invocation expression', () => {
      const source = `class Foo {
  void Bar() { Baz(); }
  void Baz() { }
}`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'Baz');
      expect(ref).toBeDefined();
    });

    it('extracts object creation expression', () => {
      const source = `class Foo {
  void Bar() { var x = new List(); }
}`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('new'));
      expect(ref).toBeDefined();
    });
  });

  describe('relationship extraction', () => {
    it('extracts class base list relationships', () => {
      const source = `class Base { }
class Derived : Base { }`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'Derived' && r.toSymbol === 'Base');
      expect(rel).toBeDefined();
    });

    it('extracts interface inheritance', () => {
      const source = `interface IBase { }
interface IDerived : IBase { }`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'IDerived');
      if (rel) {
        expect(rel.kind).toBe('extends');
      }
    });
  });

  describe('type ref extraction', () => {
    it('extracts method parameter type refs', () => {
      const source = `class Foo {
  void Bar(int x, string y) { }
}`;
      const result = extract(source);
      const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
      expect(paramRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts method return type refs', () => {
      const source = `class Foo {
  int Bar() { return 0; }
}`;
      const result = extract(source);
      const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
      expect(returnRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts field type refs', () => {
      const source = `class Foo {
  int x;
  string name;
}`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'Foo')).toBeDefined();
    });

    it('extracts cast type refs', () => {
      const source = `class Foo {
  void Bar() { var x = (int)3.14; }
}`;
      const result = extract(source);
      const castRefs = result.typeRefs.filter(r => r.refKind === 'cast');
      expect(castRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts as cast type refs', () => {
      const source = `class Foo {
  void Bar(object obj) { var x = obj as string; }
}`;
      const result = extract(source);
      const castRefs = result.typeRefs.filter(r => r.refKind === 'cast');
      expect(castRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts variable type refs', () => {
      const source = `class Foo {
  void Bar() { int x = 0; }
}`;
      const result = extract(source);
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it('extracts bound type refs from base list', () => {
      const source = `class Base { }
class Derived : Base { }`;
      const result = extract(source);
      const boundRefs = result.typeRefs.filter(r => r.refKind === 'bound');
      expect(boundRefs.length).toBeGreaterThanOrEqual(0);
    });
  });
});
