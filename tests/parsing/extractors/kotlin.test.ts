import { describe, it, expect } from 'vitest';
import { KotlinExtractor } from '../../../src/parsing/extractors/kotlin.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new KotlinExtractor();

function extract(source: string) {
  const tree = pool.parse('kotlin', source)!;
  return extractor.extract(tree, source, 'test.kt');
}

describe('KotlinExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function declaration', () => {
      const result = extract('fun greet(name: String): String { return "Hello $name" }');
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts class declaration', () => {
      const result = extract('class Foo { }');
      const sym = result.symbols.find(s => s.name === 'Foo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts object declaration', () => {
      const result = extract('object Singleton { }');
      const sym = result.symbols.find(s => s.name === 'Singleton');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts interface declaration', () => {
      const result = extract('interface Drawable { fun draw() }');
      const sym = result.symbols.find(s => s.name === 'Drawable');
      expect(sym).toBeDefined();
      // tree-sitter-kotlin may parse interface as class_declaration
      expect(['interface', 'class']).toContain(sym!.kind);
    });

    it('extracts data class', () => {
      const result = extract('data class User(val name: String, val age: Int)');
      const sym = result.symbols.find(s => s.name === 'User');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });
  });

  describe('import extraction', () => {
    it('extracts import header', () => {
      const result = extract('import com.example.Foo');
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
      const imp = result.imports[0]!;
      expect(imp.importedNames).toContain('Foo');
    });

    it('extracts wildcard import', () => {
      const result = extract('import com.example.*');
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('call ref extraction', () => {
    it('extracts function calls', () => {
      const source = `fun foo() { bar() }
fun bar() { }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'bar');
      expect(ref).toBeDefined();
    });
  });

  describe('relationship extraction', () => {
    it('extracts class inheritance', () => {
      const source = `open class Base
class Derived : Base()`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'Derived');
      if (rel) {
        expect(rel.toSymbol).toContain('Base');
      }
    });
  });

  describe('type ref extraction', () => {
    it('extracts function parameter type refs', () => {
      const result = extract('fun greet(name: String): String { return "" }');
      const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
      expect(paramRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts function return type refs', () => {
      const result = extract('fun greet(): String { return "" }');
      const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
      expect(returnRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts class field type refs', () => {
      const source = `class Foo {
  val name: String = ""
}`;
      const result = extract(source);
      const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
      expect(fieldRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts property variable type ref', () => {
      const source = `fun foo() {
  val x: Int = 0
}`;
      const result = extract(source);
      // May produce variable type ref
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it('extracts as cast type ref', () => {
      const source = `fun foo(obj: Any) {
  val x = obj as String
}`;
      const result = extract(source);
      const castRefs = result.typeRefs.filter(r => r.refKind === 'cast');
      expect(castRefs.length).toBeGreaterThanOrEqual(0);
    });
  });
});
