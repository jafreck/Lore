import { describe, it, expect } from 'vitest';
import { ScalaExtractor } from '../../../src/parsing/extractors/scala.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new ScalaExtractor();

function extract(source: string) {
  const tree = pool.parse('scala', source)!;
  return extractor.extract(tree, source, 'test.scala');
}

describe('ScalaExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function definition', () => {
      const result = extract('def greet(name: String): String = s"Hello $name"');
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts class definition', () => {
      const result = extract('class Foo { }');
      const sym = result.symbols.find(s => s.name === 'Foo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts trait definition', () => {
      const result = extract('trait Drawable { def draw(): Unit }');
      const sym = result.symbols.find(s => s.name === 'Drawable');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('trait');
    });

    it('extracts object definition', () => {
      const result = extract('object Singleton { }');
      const sym = result.symbols.find(s => s.name === 'Singleton');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts val definition', () => {
      const result = extract('val x = 42');
      const sym = result.symbols.find(s => s.name === 'x');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('val');
    });

    it('extracts var definition', () => {
      const result = extract('var count = 0');
      const sym = result.symbols.find(s => s.name === 'count');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('var');
    });

    it('extracts case class', () => {
      const result = extract('case class User(name: String, age: Int)');
      const sym = result.symbols.find(s => s.name === 'User');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });
  });

  describe('import extraction', () => {
    it('extracts simple import', () => {
      const result = extract('import scala.collection.mutable.ArrayBuffer');
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
      const imp = result.imports[0]!;
      expect(imp.importedNames).toContain('ArrayBuffer');
    });

    it('extracts grouped import', () => {
      const result = extract('import scala.collection.mutable.{ArrayBuffer, ListBuffer}');
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts wildcard import', () => {
      const result = extract('import scala.collection.mutable._');
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('call ref extraction', () => {
    it('extracts function calls', () => {
      const source = `def foo(): Unit = { bar() }
def bar(): Unit = { }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'bar');
      expect(ref).toBeDefined();
    });
  });
});
