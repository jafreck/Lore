import { describe, it, expect } from 'vitest';
import { JavaExtractor } from '../../../src/parsing/extractors/java.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new JavaExtractor();

function extract(source: string) {
  const tree = pool.parse('java', source)!;
  return extractor.extract(tree, source, 'Test.java');
}

describe('JavaExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts class declaration', () => {
      const result = extract('class Foo {}');
      const sym = result.symbols.find(s => s.name === 'Foo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts interface declaration', () => {
      const result = extract('interface Serializable { void serialize(); }');
      const sym = result.symbols.find(s => s.name === 'Serializable');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('interface');
    });

    it('extracts enum declaration', () => {
      const result = extract('enum Color { RED, GREEN, BLUE }');
      const sym = result.symbols.find(s => s.name === 'Color');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('enum');
    });

    it('extracts method declaration', () => {
      const source = `class Foo {
  public int add(int a, int b) { return a + b; }
}`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
      // Java extractMethod uses 'function' as default kind
      expect(sym!.kind).toBe('function');
      expect(sym!.parentName).toBe('Foo');
    });

    it('extracts constructor declaration', () => {
      const source = `class Foo {
  public Foo(int x) {}
}`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Foo' && s.kind === 'constructor');
      expect(sym).toBeDefined();
    });

    it('extracts nested class with parentName', () => {
      const source = `class Outer {
  class Inner {}
}`;
      const result = extract(source);
      const inner = result.symbols.find(s => s.name === 'Inner');
      expect(inner).toBeDefined();
      expect(inner!.parentName).toBe('Outer');
    });
  });

  describe('import extraction', () => {
    it('extracts import declarations', () => {
      const source = `import java.util.List;\nimport java.util.Map;\nclass Foo {}`;
      const result = extract(source);
      expect(result.imports.length).toBe(2);
      expect(result.imports[0].source).toContain('java.util.List');
    });

    it('extracts wildcard import', () => {
      const source = `import java.util.*;\nclass Foo {}`;
      const result = extract(source);
      expect(result.imports.some(i => i.source.includes('java.util'))).toBe(true);
    });
  });

  describe('call ref extraction', () => {
    it('extracts method invocations', () => {
      const source = `class Foo {
  void bar() { System.out.println("hello"); }
}`;
      const result = extract(source);
      expect(result.callRefs.length).toBeGreaterThan(0);
    });

    it('extracts constructor calls (new)', () => {
      const source = `class Foo {
  void bar() { Object obj = new ArrayList(); }
}`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('ArrayList'));
      expect(ref).toBeDefined();
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

    it('extracts implements relationship', () => {
      const source = `class MyList implements List {}`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.kind === 'implements');
      expect(rel).toBeDefined();
      expect(rel!.fromSymbol).toBe('MyList');
      expect(rel!.toSymbol).toBe('List');
    });
  });

  describe('type ref extraction', () => {
    it('extracts parameter type refs', () => {
      const source = `class Foo {
  void process(MyData data) {}
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyData');
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('parameter');
    });

    it('extracts return type refs', () => {
      const source = `class Foo {
  MyResult compute() { return null; }
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyResult');
      expect(ref).toBeDefined();
      expect(ref!.refKind).toBe('return');
    });

    it('extracts field type refs', () => {
      const source = `class Foo {
  private Config config;
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'Config');
      expect(ref).toBeDefined();
    });

    it('extracts local variable type refs', () => {
      const source = `class Foo {
  void bar() { MyType x = new MyType(); }
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType' && r.refKind === 'variable');
      expect(ref).toBeDefined();
    });

    it('extracts cast type refs', () => {
      const source = `class Foo {
  void bar(Object o) { MyType x = (MyType) o; }
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType' && r.refKind === 'cast');
      expect(ref).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty class', () => {
      const result = extract('class Empty {}');
      expect(result.symbols).toHaveLength(1);
    });

    it('handles empty source', () => {
      const result = extract('');
      expect(result.symbols).toEqual([]);
    });
  });

  describe('inheritance and type ref coverage', () => {
    it('extracts class extending another class', () => {
      const source = `class Child extends Parent {
  void method() {}
}`;
      const result = extract(source);
      const rels = result.relationships.filter(r => r.fromSymbol === 'Child' && r.kind === 'extends');
      expect(rels.length).toBe(1);
      expect(rels[0]!.toSymbol).toBe('Parent');
    });

    it('extracts class implementing multiple interfaces', () => {
      const source = `class MyClass implements Serializable, Comparable<MyClass> {
  public int compareTo(MyClass other) { return 0; }
}`;
      const result = extract(source);
      const rels = result.relationships.filter(r => r.fromSymbol === 'MyClass' && r.kind === 'implements');
      expect(rels.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts interface extending interfaces', () => {
      const source = `interface ReadWrite extends Readable, Writable {}`;
      const result = extract(source);
      const rels = result.relationships.filter(r => r.fromSymbol === 'ReadWrite');
      expect(rels.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts field type refs', () => {
      const source = `class Config {
  private String name;
  public int count;
}`;
      const result = extract(source);
      const refs = result.typeRefs.filter(r => r.typeRaw === 'String' || r.typeRaw === 'int');
      expect(refs.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts varargs parameter', () => {
      const source = `class Logger {
  void log(String... messages) {}
}`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'log')).toBeDefined();
    });

    it('extracts local variable type ref', () => {
      const source = `class Foo {
  void run() {
    int x = 5;
    String name = "test";
  }
}`;
      const result = extract(source);
      const refs = result.typeRefs.filter(r => r.typeRaw === 'int' || r.typeRaw === 'String');
      expect(refs.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts cast expression type ref', () => {
      const source = `class Converter {
  void convert(Object obj) {
    String s = (String) obj;
  }
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'String');
      expect(ref).toBeDefined();
    });

    it('extracts method return type', () => {
      const source = `class Service {
  public String getName() { return "test"; }
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'String' && r.refKind === 'return');
      expect(ref).toBeDefined();
    });
  });
});
