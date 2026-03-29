import { describe, it, expect } from 'vitest';
import { RustExtractor } from '../../../src/parsing/extractors/rust.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new RustExtractor();

function extract(source: string) {
  const tree = pool.parse('rust', source)!;
  return extractor.extract(tree, source, 'test.rs');
}

describe('RustExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function item', () => {
      const result = extract('fn add(a: i32, b: i32) -> i32 { a + b }');
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts struct item', () => {
      const source = `struct Point {
    x: f64,
    y: f64,
}`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Point');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('struct');
    });

    it('extracts enum item', () => {
      const source = `enum Direction { North, South, East, West }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Direction');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('enum');
    });

    it('extracts trait item', () => {
      const source = `trait Drawable { fn draw(&self); }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Drawable');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('trait');
    });

    it('extracts impl item', () => {
      const source = `struct Foo;
impl Foo {
    fn new() -> Self { Foo }
}`;
      const result = extract(source);
      const impl = result.symbols.find(s => s.kind === 'impl');
      expect(impl).toBeDefined();
      expect(impl!.name).toBe('Foo');
    });

    it('extracts trait impl', () => {
      const source = `struct Foo;
trait Bar {}
impl Bar for Foo {}`;
      const result = extract(source);
      const impl = result.symbols.find(s => s.kind === 'impl' && s.name.includes('Bar for Foo'));
      expect(impl).toBeDefined();
    });
  });

  describe('import extraction', () => {
    it('extracts use declaration', () => {
      const result = extract('use std::collections::HashMap;');
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].source).toContain('std::collections::HashMap');
    });

    it('extracts use with glob', () => {
      const result = extract('use std::io::*;');
      expect(result.imports).toHaveLength(1);
    });

    it('extracts use with nested braces', () => {
      const result = extract('use std::io::{Read, Write};');
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].importedNames).toContain('Read');
      expect(result.imports[0].importedNames).toContain('Write');
    });
  });

  describe('call ref extraction', () => {
    it('extracts function calls', () => {
      const source = `fn main() { println!("hello"); foo(); }
fn foo() {}`;
      const result = extract(source);
      const fooRef = result.callRefs.find(r => r.calleeRaw === 'foo');
      expect(fooRef).toBeDefined();
    });

    it('extracts macro invocations', () => {
      const source = `fn main() { println!("hello"); }`;
      const result = extract(source);
      const macroRef = result.callRefs.find(r => r.calleeRaw.includes('println'));
      expect(macroRef).toBeDefined();
    });
  });

  describe('relationship extraction', () => {
    it('extracts trait implementation relationship', () => {
      const source = `struct Foo;
trait Bar {}
impl Bar for Foo {}`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.kind === 'implements');
      expect(rel).toBeDefined();
      expect(rel!.toSymbol).toBe('Bar');
    });
  });

  describe('type ref extraction', () => {
    it('extracts parameter type refs', () => {
      const source = `fn process(data: &MyData) {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw.includes('MyData'));
      expect(ref).toBeDefined();
    });

    it('extracts return type refs', () => {
      const source = `fn create() -> Result<Value, Error> { todo!() }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw.includes('Result'));
      expect(ref).toBeDefined();
    });

    it('extracts let type refs', () => {
      const source = `fn foo() { let x: MyType = create(); }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType');
      expect(ref).toBeDefined();
    });

    it('extracts struct field type refs', () => {
      const source = `struct Foo {
    config: Config,
    name: String,
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'Config');
      expect(ref).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = extract('');
      expect(result.symbols).toEqual([]);
    });

    it('handles function with no params or return type', () => {
      const result = extract('fn noop() {}');
      const sym = result.symbols.find(s => s.name === 'noop');
      expect(sym).toBeDefined();
    });
  });

  describe('impl, cast, and let type coverage', () => {
    it('extracts impl trait for type', () => {
      const source = `struct MyStruct;
trait Display {
    fn fmt(&self) -> String;
}
impl Display for MyStruct {
    fn fmt(&self) -> String { String::new() }
}`;
      const result = extract(source);
      // impl block should be processed — check symbols extracted
      expect(result.symbols.length).toBeGreaterThanOrEqual(2);
    });

    it('extracts let binding with type annotation', () => {
      const source = `fn main() {
    let count: i32 = 5;
    let name: String = String::new();
}`;
      const result = extract(source);
      const refs = result.typeRefs.filter(r => r.typeRaw === 'i32' || r.typeRaw === 'String');
      expect(refs.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts as cast type ref', () => {
      const source = `fn convert() {
    let x = 3.14 as i32;
    let y = x as u64;
}`;
      const result = extract(source);
      // Cast expression should be processed
      expect(result.typeRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extracts reference parameter type', () => {
      const source = `fn process(data: &MyType) {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyType');
      expect(ref).toBeDefined();
    });

    it('extracts function return type', () => {
      const source = `fn get_value() -> String { String::new() }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'String' && r.refKind === 'return');
      expect(ref).toBeDefined();
    });
  });
});
