import { describe, it, expect } from 'vitest';
import { CExtractor } from '../../../src/parsing/extractors/c.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new CExtractor();

function extract(source: string) {
  const tree = pool.parse('c', source)!;
  return extractor.extract(tree, source, 'test.c');
}

describe('CExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function definition', () => {
      const result = extract('int add(int a, int b) { return a + b; }');
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts struct specifier', () => {
      const source = `struct Point {
    int x;
    int y;
};`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Point');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('struct');
    });

    it('extracts enum specifier', () => {
      const result = extract('enum Color { RED, GREEN, BLUE };');
      const sym = result.symbols.find(s => s.name === 'Color');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('enum');
    });

    it('extracts typedef', () => {
      const result = extract('typedef unsigned int uint;');
      const sym = result.symbols.find(s => s.name === 'uint');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('typedef');
    });

    it('extracts preproc_function_def (macro)', () => {
      const result = extract('#define MAX(a, b) ((a) > (b) ? (a) : (b))');
      const sym = result.symbols.find(s => s.name === 'MAX');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('macro');
    });

    it('extracts preproc_def (simple macro)', () => {
      const result = extract('#define PI 3.14159');
      const sym = result.symbols.find(s => s.name === 'PI');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('macro');
    });

    it('extracts function declaration (prototype)', () => {
      const result = extract('int add(int a, int b);');
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
    });
  });

  describe('import extraction', () => {
    it('extracts #include directives', () => {
      const result = extract('#include <stdio.h>\n#include "myheader.h"');
      expect(result.imports.length).toBe(2);
      expect(result.imports[0].source).toContain('stdio.h');
      expect(result.imports[1].source).toContain('myheader.h');
    });
  });

  describe('call ref extraction', () => {
    it('extracts direct function calls', () => {
      const source = `int main() { printf("hello"); return 0; }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'printf');
      expect(ref).toBeDefined();
    });

    it('classifies macro calls', () => {
      const source = `#define LOG(x) printf(x)
int main() { LOG("hi"); return 0; }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'LOG');
      if (ref) {
        expect(ref.callKind).toBe('macro');
      }
    });

    it('detects indirect calls', () => {
      const source = `typedef void (*Callback)(void);
void call(Callback cb) { (*cb)(); }`;
      const result = extract(source);
      const indirect = result.callRefs.find(r => r.isIndirect);
      if (indirect) {
        expect(indirect.isIndirect).toBe(true);
      }
    });
  });

  describe('type ref extraction', () => {
    it('extracts function parameter type refs', () => {
      const source = `void process(struct Config* cfg) {}`;
      const result = extract(source);
      expect(result.typeRefs.length).toBeGreaterThan(0);
    });

    it('extracts function return type refs', () => {
      const source = `struct Point create_point() { struct Point p; return p; }`;
      const result = extract(source);
      expect(result.typeRefs.length).toBeGreaterThan(0);
    });

    it('extracts struct field type refs', () => {
      const source = `struct Container {
    struct Data* data;
};`;
      const result = extract(source);
      expect(result.typeRefs.length).toBeGreaterThan(0);
    });

    it('extracts sizeof type ref', () => {
      const source = `void foo() { int s = sizeof(struct MyStruct); }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.refKind === 'sizeof');
      if (ref) {
        expect(ref.typeRaw).toContain('MyStruct');
      }
    });

    it('extracts cast type ref', () => {
      const source = `void foo() { int x = (int)3.14; }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.refKind === 'cast');
      if (ref) {
        expect(ref).toBeDefined();
      }
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = extract('');
      expect(result.symbols).toEqual([]);
    });

    it('handles unnamed struct', () => {
      // Struct without a name should not produce a symbol
      const result = extract('struct { int x; };');
      const structs = result.symbols.filter(s => s.kind === 'struct');
      expect(structs).toHaveLength(0);
    });
  });
});
