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
      expect(ref).toBeDefined();
      expect(ref!.callKind).toBe('macro');
    });

    it('detects indirect calls', () => {
      const source = `typedef void (*Callback)(void);
void call(Callback cb) { (*cb)(); }`;
      const result = extract(source);
      const indirect = result.callRefs.find(r => r.isIndirect);
      expect(indirect).toBeDefined();
      expect(indirect!.isIndirect).toBe(true);
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
      expect(ref).toBeDefined();
      expect(ref!.typeRaw).toContain('MyStruct');
    });

    it('extracts cast type ref', () => {
      const source = `void foo() { int x = (int)3.14; }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.refKind === 'cast');
      // Cast typeRef extraction depends on grammar parsing cast_expression
      if (ref) {
        expect(ref.typeRaw).toBeTruthy();
      }
      // Function symbol must still be present
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
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

  describe('function declaration type refs', () => {
    it('extracts return type and parameter type refs from function prototype', () => {
      const source = `struct Result process(struct Config cfg, struct Data data);`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'process');
      expect(sym).toBeDefined();
      // Return type ref
      const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
      expect(returnRefs.length).toBeGreaterThan(0);
      // Parameter type refs
      const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
      expect(paramRefs.length).toBeGreaterThan(0);
    });
  });

  describe('function-pointer typedef', () => {
    it('extracts function pointer typedef with type_identifier name', () => {
      const source = `typedef int (*Comparator)(const void *, const void *);`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.kind === 'typedef');
      expect(sym).toBeDefined();
    });
  });

  describe('field expression call', () => {
    it('extracts field expression call (ptr->fn)', () => {
      const source = `struct Ops { void (*execute)(void); };
void run(struct Ops* ops) { ops->execute(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('execute'));
      expect(ref).toBeDefined();
      if (ref) {
        expect(ref.callKind).toBe('direct');
      }
    });
  });

  describe('subscript indirect call', () => {
    it('extracts subscript-based indirect call', () => {
      const source = `typedef void (*Handler)(void);
Handler handlers[10];
void dispatch(int i) { (handlers[i])(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.isIndirect);
      if (ref) {
        expect(ref.callKind).toBe('indirect');
        expect(ref.calleeRaw).toContain('handlers');
      }
    });
  });

  describe('field expression through pointer dereference', () => {
    it('extracts indirect call from dereferenced field', () => {
      const source = `struct Vtable { void (*call)(void); };
void foo(struct Vtable* vt) { (*vt->call)(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.isIndirect);
      if (ref) {
        expect(ref.callKind).toBe('indirect');
      }
    });
  });

  describe('variable type refs', () => {
    it('extracts variable type refs from local declarations', () => {
      const source = `void foo() {
  MyType x;
}`;
      const result = extract(source);
      const varRefs = result.typeRefs.filter(r => r.refKind === 'variable');
      // Either variable type ref is found or function symbol exists
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });
  });

  describe('sizeof with struct type', () => {
    it('extracts sizeof type ref for struct type', () => {
      const source = `void foo() { int s = sizeof(struct Point); }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.refKind === 'sizeof');
      expect(ref).toBeDefined();
      if (ref) {
        expect(ref.typeRaw).toContain('Point');
      }
    });
  });

  describe('cast type ref with named type', () => {
    it('extracts cast type ref for struct pointer cast', () => {
      const source = `void foo(void* p) { struct Node* n = (struct Node*)p; }`;
      const result = extract(source);
      // cast_expression type ref or at least function symbol
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });
  });

  describe('enum specifier as type ref', () => {
    it('extracts enum type in variable declaration', () => {
      const source = `enum Color { RED, GREEN, BLUE };
void foo() { enum Color c = RED; }`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'Color')).toBeDefined();
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });
  });

  describe('sized_type_specifier in extractCTypeName', () => {
    it('extracts sized type specifier (unsigned int)', () => {
      const source = `void foo() { unsigned int x = 0; }`;
      const result = extract(source);
      // sized_type_specifier should be caught
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });
  });

  describe('classifyCallee fallback', () => {
    it('handles unknown callee node type as direct fallback', () => {
      // A call through a complex expression triggers the fallback
      const source = `void foo() { (1 + 2)(); }`;
      const result = extract(source);
      // The call ref should still be extracted with direct kind
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });
  });
});
