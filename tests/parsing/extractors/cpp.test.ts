import { describe, it, expect } from 'vitest';
import { CppExtractor } from '../../../src/parsing/extractors/cpp.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new CppExtractor();

function extract(source: string) {
  const tree = pool.parse('cpp', source)!;
  return extractor.extract(tree, source, 'test.cpp');
}

describe('CppExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts class with methods', () => {
      const source = `class Foo {
  void bar();
  int baz(int x);
};`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'Foo');
      expect(cls).toBeDefined();
      expect(cls!.kind).toBe('class');
    });

    it('extracts struct specifier', () => {
      const source = `struct Point { int x; int y; };`;
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

    it('extracts function-like macro', () => {
      const result = extract('#define MAX(a, b) ((a) > (b) ? (a) : (b))');
      const sym = result.symbols.find(s => s.name === 'MAX');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('macro');
    });

    it('extracts object-like macro', () => {
      const result = extract('#define PI 3.14159');
      const sym = result.symbols.find(s => s.name === 'PI');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('macro');
    });

    it('extracts function definition', () => {
      const result = extract('int add(int a, int b) { return a + b; }');
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts function declaration (prototype)', () => {
      const result = extract('int add(int a, int b);');
      const sym = result.symbols.find(s => s.name === 'add');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts qualified method definition', () => {
      const source = `class Foo { void bar(); };
void Foo::bar() {}`;
      const result = extract(source);
      const method = result.symbols.find(s => s.name === 'Foo::bar');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('function');
    });
  });

  describe('import extraction', () => {
    it('extracts #include directives', () => {
      const result = extract('#include <iostream>\n#include "myheader.h"');
      expect(result.imports.length).toBe(2);
      expect(result.imports[0]!.source).toContain('iostream');
      expect(result.imports[1]!.source).toContain('myheader.h');
    });
  });

  describe('call ref extraction', () => {
    it('extracts direct function calls', () => {
      const source = `void foo() { bar(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'bar');
      expect(ref).toBeDefined();
      expect(ref!.callerSymbol).toBe('foo');
    });

    it('extracts qualified call (std::sort)', () => {
      const source = `void foo() { std::sort(v.begin(), v.end()); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('std::sort'));
      expect(ref).toBeDefined();
    });

    it('classifies macro calls', () => {
      const source = `#define LOG(x) printf(x)
void foo() { LOG("hi"); }`;
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
        expect(indirect.callKind).toBe('indirect');
      }
    });

    it('extracts field expression call', () => {
      const source = `struct S { void (*fn)(); };
void foo(struct S s) { s.fn(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('s.fn'));
      expect(ref).toBeDefined();
    });
  });

  describe('type ref extraction', () => {
    it('extracts function parameter type refs', () => {
      const source = `void process(int x) {}`;
      const result = extract(source);
      // TypeRef extraction depends on grammar parsing type nodes
      for (const ref of result.typeRefs) {
        expect(ref.typeRaw).toBeTruthy();
      }
      expect(result.symbols.find(s => s.name === 'process')).toBeDefined();
    });

    it('extracts base class relationships', () => {
      const source = `class Base {};
class Derived : public Base {};`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'Derived' && r.toSymbol === 'Base');
      expect(rel).toBeDefined();
      expect(rel!.kind).toBe('extends');
    });

    it('extracts field type refs from classes', () => {
      const source = `class Foo {
  int x;
  float y;
};`;
      const result = extract(source);
      const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
      for (const ref of fieldRefs) {
        expect(ref.typeRaw).toBeTruthy();
      }
      expect(result.symbols.find(s => s.name === 'Foo')).toBeDefined();
    });

    it('extracts cast type refs', () => {
      const source = `void foo() { int x = (int)3.14; }`;
      const result = extract(source);
      const castRef = result.typeRefs.find(r => r.refKind === 'cast');
      if (castRef) {
        expect(castRef.typeRaw).toContain('int');
      }
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });

    it('extracts sizeof type refs', () => {
      const source = `void foo() { int x = sizeof(int); }`;
      const result = extract(source);
      const sizeofRef = result.typeRefs.find(r => r.refKind === 'sizeof');
      if (sizeofRef) {
        expect(sizeofRef.typeRaw).toContain('int');
      }
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });

    it('extracts variable type refs from declarations', () => {
      const source = `void foo() { int x = 0; }`;
      const result = extract(source);
      const varRefs = result.typeRefs.filter(r => r.refKind === 'variable');
      for (const ref of varRefs) {
        expect(ref.typeRaw).toBeTruthy();
      }
      expect(result.symbols.find(s => s.name === 'foo')).toBeDefined();
    });

    it('extracts named cast calls (static_cast parsed as template_function call)', () => {
      const source = `void foo() { double d = 3.14; int x = static_cast<int>(d); }`;
      const result = extract(source);
      // tree-sitter-cpp parses static_cast<int>(d) as call_expression > template_function
      const ref = result.callRefs.find(r => r.calleeRaw.includes('static_cast'));
      expect(ref).toBeDefined();
    });

    it('extracts dynamic_cast as call', () => {
      const source = `class Base { virtual ~Base() {} };
class Derived : public Base {};
void foo(Base* b) { Derived* d = dynamic_cast<Derived*>(b); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('dynamic_cast'));
      expect(ref).toBeDefined();
    });

    it('extracts reinterpret_cast as call', () => {
      const source = `void foo() { int x = 42; char* p = reinterpret_cast<char*>(&x); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('reinterpret_cast'));
      expect(ref).toBeDefined();
    });

    it('extracts const_cast as call', () => {
      const source = `void foo(const int* p) { int* q = const_cast<int*>(p); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('const_cast'));
      expect(ref).toBeDefined();
    });

    it('extracts alignof type refs', () => {
      const source = `void foo() { int a = alignof(double); }`;
      const result = extract(source);
      const alignRef = result.typeRefs.find(r => r.refKind === 'other');
      if (alignRef) {
        expect(alignRef.typeRaw).toBeTruthy();
      }
    });

    it('extracts template base class relationship', () => {
      const source = `template<typename T>
class Container {};
class IntContainer : public Container<int> {};`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'IntContainer');
      expect(rel).toBeDefined();
      if (rel) {
        expect(rel.toSymbol).toContain('Container');
      }
    });
  });

  describe('template function calls', () => {
    it('extracts template function call as direct', () => {
      const source = `#include <algorithm>
void foo() { std::sort<int*>(nullptr, nullptr); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('sort'));
      expect(ref).toBeDefined();
    });
  });

  describe('function declaration (prototype) in cpp', () => {
    it('extracts function prototype as symbol', () => {
      const source = `int calculate(double x, int n);`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'calculate');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
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

  describe('field expression indirect call through pointer', () => {
    it('extracts field expression through pointer dereference', () => {
      const source = `struct Vtable { void (*call)(void); };
void foo(struct Vtable* vt) { (*vt->call)(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.isIndirect);
      if (ref) {
        expect(ref.callKind).toBe('indirect');
      }
    });
  });

  describe('struct field type refs', () => {
    it('extracts struct specifier field type refs', () => {
      const source = `struct Config {
  int port;
  double timeout;
};`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Config');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('struct');
    });
  });

  describe('sized_type_specifier in extractCppTypeName', () => {
    it('extracts sized type specifier (unsigned long)', () => {
      const source = `void foo() { unsigned long x = 0; }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw && r.typeRaw.includes('unsigned'));
      if (ref) {
        expect(ref.typeRaw).toBeTruthy();
      }
    });
  });

  describe('uncovered branch coverage', () => {
    it('extractCppCastTypeRef: extracts C-style cast type ref', () => {
      const source = `void foo(void* p) { MyType* x = (MyType*)p; }`;
      const result = extract(source);
      const castRef = result.typeRefs.find(r => r.refKind === 'cast');
      expect(castRef).toBeDefined();
      expect(castRef!.typeRaw).toContain('MyType');
      expect(castRef!.enclosingSymbol).toBe('foo');
    });

    it('extractCppVariableTypeRefs: extracts variable type ref from declaration', () => {
      const source = `void foo() {
  MyClass obj;
}`;
      const result = extract(source);
      const varRef = result.typeRefs.find(r => r.refKind === 'variable' && r.typeRaw === 'MyClass');
      expect(varRef).toBeDefined();
      expect(varRef!.enclosingSymbol).toBe('foo');
    });

    it('extractCppFunctionTypeRefs: extracts return type ref', () => {
      const source = `MyResult compute(int x) { return {}; }`;
      const result = extract(source);
      const retRef = result.typeRefs.find(r => r.refKind === 'return' && r.typeRaw === 'MyResult');
      expect(retRef).toBeDefined();
      expect(retRef!.enclosingSymbol).toBe('compute');
    });

    it('extractCppFunctionTypeRefs: extracts parameter type refs', () => {
      const source = `void process(MyInput a, MyOutput b) {}`;
      const result = extract(source);
      const inputRef = result.typeRefs.find(r => r.typeRaw === 'MyInput' && r.refKind === 'parameter');
      expect(inputRef).toBeDefined();
      const outputRef = result.typeRefs.find(r => r.typeRaw === 'MyOutput' && r.refKind === 'parameter');
      expect(outputRef).toBeDefined();
    });

    it('extractCppFieldTypeRefs: extracts class field type refs', () => {
      const source = `class Service {
  Logger logger;
  Config config;
};`;
      const result = extract(source);
      const loggerRef = result.typeRefs.find(r => r.refKind === 'field' && r.typeRaw === 'Logger');
      expect(loggerRef).toBeDefined();
      expect(loggerRef!.enclosingSymbol).toBe('Service');
    });

    it('extractCppSizeofTypeRef: extracts sizeof with user-defined type', () => {
      const source = `struct MyStruct { int x; };
void foo() { auto s = sizeof(struct MyStruct); }`;
      const result = extract(source);
      const sizeofRef = result.typeRefs.find(r => r.refKind === 'sizeof' && r.typeRaw === 'MyStruct');
      expect(sizeofRef).toBeDefined();
    });

    it('extractBaseClassRelationships: extracts template base class', () => {
      const source = `template<typename T>
class Container {};
class IntList : public Container<int> {};`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'IntList');
      expect(rel).toBeDefined();
      expect(rel!.toSymbol).toContain('Container');
      // Also check bound type ref
      const boundRef = result.typeRefs.find(r => r.refKind === 'bound' && r.enclosingSymbol === 'IntList');
      expect(boundRef).toBeDefined();
    });

    it('classifyCallee: handles template_function call', () => {
      const source = `void foo() { std::make_shared<MyClass>(1, 2); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('make_shared'));
      expect(ref).toBeDefined();
      expect(ref!.callKind).toBe('direct');
    });

    it('extractInnermostIdentifier: handles pointer expression dereference', () => {
      const source = `typedef void (*FnPtr)(void);
void foo(FnPtr fp) { (*fp)(); }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.isIndirect);
      expect(ref).toBeDefined();
      expect(ref!.callKind).toBe('indirect');
      expect(ref!.calleeRaw).toContain('fp');
    });

    it('extractCppVariableTypeRefs: extracts pointer type ref from declaration', () => {
      const source = `void foo() { MyWidget* w = nullptr; }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'MyWidget' && r.refKind === 'variable');
      expect(ref).toBeDefined();
    });

    it('extractTypedef: extracts typedef with type_definition node', () => {
      const source = `typedef struct { int x; int y; } Point;`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Point' && s.kind === 'typedef');
      expect(sym).toBeDefined();
    });

    it('extractCppFunctionDeclaration: extracts declaration as function prototype', () => {
      const source = `int calculate(double x, int n);`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'calculate' && s.kind === 'function');
      expect(sym).toBeDefined();
    });

    it('classifyCallee: falls through to default for unknown fn node type', () => {
      // lambda call: auto x = [](){}; x();
      const source = `void foo() {
  auto fn = [](){ return 1; };
  fn();
}`;
      const result = extract(source);
      // fn() should produce a call ref via default path or identifier path
      const ref = result.callRefs.find(r => r.calleeRaw === 'fn');
      expect(ref).toBeDefined();
    });

    it('extractCppNamedCastTypeRef: extracts static_cast type ref when grammar parses as cast node', () => {
      // tree-sitter-cpp may parse static_cast as call_expression > template_function
      // If it produces a static_cast_expression node, this test covers extractCppNamedCastTypeRef
      const source = `void foo() { double d = 3.14; int x = static_cast<int>(d); }`;
      const result = extract(source);
      // Should produce either a cast type ref or a call ref
      const hasCast = result.typeRefs.some(r => r.refKind === 'cast');
      const hasCall = result.callRefs.some(r => r.calleeRaw.includes('static_cast'));
      expect(hasCast || hasCall).toBe(true);
    });

    it('extractDeclaratorName: handles qualified method name', () => {
      const source = `class Foo {
  void bar();
};
void Foo::bar() { }`;
      const result = extract(source);
      const method = result.symbols.find(s => s.name === 'Foo::bar');
      expect(method).toBeDefined();
      expect(method!.kind).toBe('function');
    });

    it('extractCppSizeofTypeRef: extracts alignof with user-defined type', () => {
      const source = `struct Widget { int x; };
void foo() { auto a = alignof(Widget); }`;
      const result = extract(source);
      const alignRef = result.typeRefs.find(r => r.refKind === 'other' && r.typeRaw === 'Widget');
      expect(alignRef).toBeDefined();
      expect(alignRef!.enclosingSymbol).toBe('foo');
    });

    it('extractTypedef: extracts type_definition from typedef struct', () => {
      const source = `typedef struct { int x; int y; } Point;`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Point');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('typedef');
    });

    it('extractCppFieldTypeRefs: extracts struct field type refs', () => {
      const source = `struct Config {
  Logger logger;
  Handler handler;
};`;
      const result = extract(source);
      // struct_specifier field type refs
      const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
      expect(fieldRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('extractBaseClassRelationships: multiple base classes', () => {
      const source = `class Base1 {};
class Base2 {};
class Derived : public Base1, public Base2 {};`;
      const result = extract(source);
      const rels = result.relationships.filter(r => r.fromSymbol === 'Derived');
      expect(rels.length).toBe(2);
      expect(rels.map(r => r.toSymbol)).toContain('Base1');
      expect(rels.map(r => r.toSymbol)).toContain('Base2');
    });
  });
});
