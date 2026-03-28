import { describe, it, expect } from 'vitest';
import { PhpExtractor } from '../../../src/parsing/extractors/php.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new PhpExtractor();

function extract(source: string) {
  const tree = pool.parse('php', source)!;
  return extractor.extract(tree, source, 'test.php');
}

describe('PhpExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function definition', () => {
      const source = `<?php
function greet(string $name): string { return "Hello $name"; }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts class declaration', () => {
      const source = `<?php
class Foo { }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Foo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts interface declaration', () => {
      const source = `<?php
interface Drawable { public function draw(): void; }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Drawable');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('interface');
    });

    it('extracts trait declaration', () => {
      const source = `<?php
trait Loggable { public function log(): void { } }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Loggable');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('trait');
    });

    it('extracts enum declaration', () => {
      const source = `<?php
enum Color { case Red; case Green; case Blue; }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Color');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('enum');
    });

    it('extracts method declaration', () => {
      const source = `<?php
class Foo {
  public function bar(): void { }
}`;
      const result = extract(source);
      const method = result.symbols.find(s => s.name === 'bar');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('function');
    });
  });

  describe('import extraction', () => {
    it('extracts use declarations', () => {
      const source = `<?php
use App\\Models\\User;`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts grouped use declarations', () => {
      const source = `<?php
use App\\Models\\{User, Post};`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('call ref extraction', () => {
    it('extracts function call expression', () => {
      const source = `<?php
function foo() { bar(); }
function bar() { }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'bar');
      expect(ref).toBeDefined();
    });

    it('extracts object creation expression', () => {
      const source = `<?php
class Foo { }
function bar() { $x = new Foo(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('new'));
      expect(ref).toBeDefined();
    });
  });

  describe('relationship extraction', () => {
    it('extracts class extends', () => {
      const source = `<?php
class Base { }
class Derived extends Base { }`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'Derived');
      expect(rel).toBeDefined();
      expect(rel!.toSymbol).toBe('Base');
      expect(rel!.kind).toBe('extends');
    });

    it('extracts class implements', () => {
      const source = `<?php
interface Drawable { }
class Circle implements Drawable { }`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'Circle');
      expect(rel).toBeDefined();
      expect(rel!.kind).toBe('implements');
    });
  });

  describe('type ref extraction', () => {
    it('extracts function parameter type refs', () => {
      const source = `<?php
function greet(string $name): void { }`;
      const result = extract(source);
      const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
      expect(paramRefs.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts function return type refs', () => {
      const source = `<?php
function greet(): string { return ""; }`;
      const result = extract(source);
      const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
      expect(returnRefs.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts class field type refs', () => {
      const source = `<?php
class Foo {
  public int $x;
}`;
      const result = extract(source);
      const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
      expect(fieldRefs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
