/**
 * Tests for the SCIP indexer stage helper functions.
 *
 * Covers the four data-fidelity fixes:
 *   1. estimateSymbolEndLine — span fallback when enclosing_range absent
 *   2. inferTypeRefKind — type ref classification from source context
 *   3. extractImportPathFromSource — actual import path extraction
 *   4. inferKindFromScipSymbol — relationship-type disambiguation aid
 *
 * Also covers classifyScipReference and inferLoreLanguage.
 */

import { describe, expect, it } from 'vitest';
import {
  _estimateSymbolEndLine as estimateSymbolEndLine,
  _inferTypeRefKind as inferTypeRefKind,
  _extractImportPathFromSource as extractImportPathFromSource,
  _inferKindFromScipSymbol as inferKindFromScipSymbol,
  _inferLoreLanguage as inferLoreLanguage,
  _classifyScipReference as classifyScipReference,
  _extractNameFromScipSymbol as extractNameFromScipSymbol,
  _extractParentScipSymbol as extractParentScipSymbol,
} from '../../src/indexer/stages/scip-indexer.js';

// ─── estimateSymbolEndLine ──────────────────────────────────────────────────

describe('estimateSymbolEndLine', () => {
  describe('brace-counted blocks (C-family, Rust, Go, Java)', () => {
    it('finds the closing brace of a single function', () => {
      const lines = [
        'function foo() {',   // 0
        '  const x = 1;',     // 1
        '  return x;',        // 2
        '}',                   // 3
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(3);
    });

    it('handles nested braces', () => {
      const lines = [
        'function outer() {',  // 0
        '  if (true) {',       // 1
        '    doThing();',      // 2
        '  }',                 // 3
        '  return 1;',         // 4
        '}',                   // 5
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(5);
    });

    it('handles opening brace on next line', () => {
      const lines = [
        'void foo()',  // 0
        '{',           // 1
        '  int x;',    // 2
        '}',           // 3
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(3);
    });

    it('handles Go function', () => {
      const lines = [
        'func main() {',         // 0
        '\tfmt.Println("hi")',   // 1
        '}',                      // 2
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(2);
    });

    it('handles Rust function', () => {
      const lines = [
        'fn process(x: i32) -> bool {',  // 0
        '    let y = x + 1;',            // 1
        '    y > 0',                      // 2
        '}',                              // 3
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(3);
    });

    it('handles Java class', () => {
      const lines = [
        'public class Foo {',             // 0
        '    private int x;',             // 1
        '    public void bar() {',        // 2
        '        System.out.println();',  // 3
        '    }',                          // 4
        '}',                              // 5
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(5);
    });
  });

  describe('indentation-based blocks (Python)', () => {
    it('finds the end of a Python function', () => {
      const lines = [
        'def foo():',        // 0
        '    x = 1',         // 1
        '    return x',      // 2
        '',                  // 3
        'def bar():',        // 4
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(3);
    });

    it('handles nested Python blocks', () => {
      const lines = [
        'def foo():',           // 0
        '    if True:',         // 1
        '        x = 1',        // 2
        '    return x',         // 3
        'class Bar:',           // 4
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(3);
    });

    it('handles Python class with methods', () => {
      const lines = [
        'class MyClass:',       // 0
        '    def __init__(self):',  // 1
        '        self.x = 1',   // 2
        '    def method(self):', // 3
        '        return self.x', // 4
        '',                      // 5
        'other = 1',            // 6
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(5);
    });

    it('skips blank lines and comments in Python', () => {
      const lines = [
        'def foo():',       // 0
        '    x = 1',        // 1
        '',                  // 2
        '    # comment',    // 3
        '    return x',     // 4
        'y = 2',            // 5
      ];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(4);
    });
  });

  describe('fallback to next definition', () => {
    it('falls back to next def line minus 1 when no braces or indent', () => {
      const lines = [
        'const x = 1',     // 0
        'const y = 2',     // 1
        'const z = 3',     // 2
      ];
      expect(estimateSymbolEndLine(lines, 0, 2)).toBe(1);
    });

    it('caps at defLine + 20 when no next def', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(20);
    });
  });

  describe('edge cases', () => {
    it('returns defLine when beyond source length', () => {
      expect(estimateSymbolEndLine([], 5, null)).toBe(5);
    });

    it('handles single-line file', () => {
      const lines = ['const x = 1;'];
      expect(estimateSymbolEndLine(lines, 0, null)).toBe(0);
    });
  });
});

// ─── inferTypeRefKind ───────────────────────────────────────────────────────

describe('inferTypeRefKind', () => {
  describe('return types', () => {
    it('detects arrow return type (->)', () => {
      const lines = ['fn process(x: i32) -> bool'];
      //                                     ^ refChar=22
      expect(inferTypeRefKind(lines, 0, 22)).toBe('return');
    });

    it('detects fat arrow return type (=>)', () => {
      const lines = ['const fn = (x: number): number => string'];
      //                 closing paren colon pattern before number
      //                                          ^ refChar=34
      expect(inferTypeRefKind(lines, 0, 34)).toBe('return');
    });

    it('detects TypeScript return type after closing paren and colon', () => {
      const lines = ['function foo(x: number): string {'];
      //                                     ^ refChar=25
      expect(inferTypeRefKind(lines, 0, 25)).toBe('return');
    });
  });

  describe('parameters', () => {
    it('detects parameter with colon annotation', () => {
      const lines = ['function foo(x: number, y: string) {'];
      //                             ^ refChar=16
      expect(inferTypeRefKind(lines, 0, 16)).toBe('parameter');
    });

    it('detects second parameter', () => {
      const lines = ['function foo(x: number, y: string) {'];
      //                                        ^ refChar=27
      expect(inferTypeRefKind(lines, 0, 27)).toBe('parameter');
    });

    it('detects Go-style parameter (no colon)', () => {
      const lines = ['func process(x int, y string)'];
      //                              ^ refChar=15
      expect(inferTypeRefKind(lines, 0, 15)).toBe('parameter');
    });
  });

  describe('generic arguments', () => {
    it('detects type inside angle brackets', () => {
      const lines = ['const list: Array<string> = [];'];
      //                                ^ refChar=18
      expect(inferTypeRefKind(lines, 0, 18)).toBe('generic_arg');
    });

    it('detects type inside nested generics', () => {
      const lines = ['Map<string, List<number>>'];
      //                          ^ refChar=12 – inside <
      expect(inferTypeRefKind(lines, 0, 12)).toBe('generic_arg');
    });
  });

  describe('fields', () => {
    it('detects public field', () => {
      const lines = ['  public name: string;'];
      //                        ^ refChar=15
      expect(inferTypeRefKind(lines, 0, 15)).toBe('field');
    });

    it('detects private field', () => {
      const lines = ['  private count: number;'];
      //                          ^ refChar=17
      expect(inferTypeRefKind(lines, 0, 17)).toBe('field');
    });

    it('detects readonly field', () => {
      const lines = ['  readonly id: string;'];
      //                            ^ refChar=15
      expect(inferTypeRefKind(lines, 0, 15)).toBe('field');
    });
  });

  describe('variables', () => {
    it('detects let variable', () => {
      const lines = ['  let x: number = 5;'];
      //                      ^ refChar=9
      expect(inferTypeRefKind(lines, 0, 9)).toBe('variable');
    });

    it('detects const variable', () => {
      const lines = ['  const x: string = "hi";'];
      //                        ^ refChar=11
      expect(inferTypeRefKind(lines, 0, 11)).toBe('variable');
    });
  });

  describe('bounds', () => {
    it('detects type bound after where', () => {
      const lines = ['fn foo<T>() where T: Clone {'];
      //                                    ^ refChar=21
      expect(inferTypeRefKind(lines, 0, 21)).toBe('bound');
    });

    it('detects generic constraint with extends', () => {
      const lines = ['function foo<T extends Comparable>(x: T) {'];
      //                                     ^ refChar=23
      expect(inferTypeRefKind(lines, 0, 23)).toBe('bound');
    });
  });

  describe('fallback', () => {
    it('returns other for unrecognized context', () => {
      const lines = ['  doSomething(MyType.value);'];
      //                            ^ refChar=14
      expect(inferTypeRefKind(lines, 0, 14)).toBe('other');
    });

    it('returns other when line is beyond source', () => {
      expect(inferTypeRefKind([], 5, 0)).toBe('other');
    });
  });
});

// ─── extractImportPathFromSource ────────────────────────────────────────────

describe('extractImportPathFromSource', () => {
  describe('JavaScript / TypeScript', () => {
    it('extracts from "import ... from" with single quotes', () => {
      expect(extractImportPathFromSource("import { foo } from './utils';")).toBe('./utils');
    });

    it('extracts from "import ... from" with double quotes', () => {
      expect(extractImportPathFromSource('import { foo } from "./utils";')).toBe('./utils');
    });

    it('extracts from require()', () => {
      expect(extractImportPathFromSource("const x = require('./utils');")).toBe('./utils');
    });

    it('extracts from bare import', () => {
      expect(extractImportPathFromSource("import './side-effect';")).toBe('./side-effect');
    });

    it('extracts scoped package', () => {
      expect(extractImportPathFromSource("import { fromBinary } from '@bufbuild/protobuf';")).toBe('@bufbuild/protobuf');
    });
  });

  describe('Python', () => {
    it('extracts from "from X import Y"', () => {
      expect(extractImportPathFromSource('from os.path import join')).toBe('os.path');
    });

    it('extracts from "import X"', () => {
      expect(extractImportPathFromSource('import json')).toBe('json');
    });

    it('extracts dotted module', () => {
      expect(extractImportPathFromSource('import foo.bar.baz')).toBe('foo.bar.baz');
    });
  });

  describe('Go', () => {
    it('extracts from quoted import', () => {
      expect(extractImportPathFromSource('\t"fmt"')).toBe('fmt');
    });

    it('extracts from aliased import', () => {
      expect(extractImportPathFromSource('\tpb "google.golang.org/protobuf"')).toBe('google.golang.org/protobuf');
    });
  });

  describe('C / C++', () => {
    it('extracts from #include with double quotes', () => {
      expect(extractImportPathFromSource('#include "my_header.h"')).toBe('my_header.h');
    });

    it('extracts from #include with angle brackets', () => {
      expect(extractImportPathFromSource('#include <stdio.h>')).toBe('stdio.h');
    });

    it('handles extra spaces', () => {
      expect(extractImportPathFromSource('#  include <vector>')).toBe('vector');
    });
  });

  describe('JavaScript / TypeScript — dynamic import()', () => {
    it('extracts from dynamic import() with single quotes', () => {
      expect(extractImportPathFromSource("const m = await import('./config');")).toBe('./config');
    });

    it('extracts from dynamic import() with double quotes', () => {
      expect(extractImportPathFromSource('const m = await import("./utils");')).toBe('./utils');
    });

    it('extracts from bare import() without await', () => {
      expect(extractImportPathFromSource("import('./lazy-module');")).toBe('./lazy-module');
    });
  });

  describe('Rust', () => {
    it('extracts and converts :: to /', () => {
      expect(extractImportPathFromSource('use std::collections::HashMap;')).toBe('std/collections/HashMap');
    });

    it('handles simple crate use', () => {
      expect(extractImportPathFromSource('use crate::module;')).toBe('crate/module');
    });
  });

  describe('Java / Kotlin / Scala', () => {
    it('extracts Java import', () => {
      expect(extractImportPathFromSource('import java.util.HashMap;')).toBe('java.util.HashMap');
    });

    it('extracts wildcard import', () => {
      expect(extractImportPathFromSource('import java.util.*;')).toBe('java.util.*');
    });

    it('extracts static import', () => {
      expect(extractImportPathFromSource('import static org.junit.Assert.assertEquals;')).toBe('org.junit.Assert.assertEquals');
    });
  });

  describe('C#', () => {
    it('extracts using statement', () => {
      expect(extractImportPathFromSource('using System.Collections.Generic;')).toBe('System.Collections.Generic');
    });

    it('extracts using static', () => {
      expect(extractImportPathFromSource('using static System.Math;')).toBe('System.Math');
    });
  });

  describe('Ruby', () => {
    it('extracts require', () => {
      expect(extractImportPathFromSource("require 'json'")).toBe('json');
    });

    it('extracts require_relative', () => {
      expect(extractImportPathFromSource("require_relative './helper'")).toBe('./helper');
    });
  });

  describe('PHP', () => {
    it('extracts use statement', () => {
      expect(extractImportPathFromSource('use App\\Models\\User;')).toBe('App\\Models\\User');
    });
  });

  describe('edge cases', () => {
    it('returns null for plain code', () => {
      expect(extractImportPathFromSource('const x = 42;')).toBeNull();
    });

    it('returns null for empty line', () => {
      expect(extractImportPathFromSource('')).toBeNull();
    });

    it('returns null for comment', () => {
      expect(extractImportPathFromSource('// import something')).toBeNull();
    });
  });
});

// ─── inferKindFromScipSymbol (used for relationship disambiguation) ─────────

describe('inferKindFromScipSymbol', () => {
  describe('functions and methods', () => {
    it('classifies top-level function', () => {
      expect(inferKindFromScipSymbol('scip-go gomod pkg 1.0 doThing().', '')).toBe('function');
    });

    it('classifies method (has type # before ().)', () => {
      expect(inferKindFromScipSymbol('scip-go gomod pkg 1.0 MyType#doThing().', '')).toBe('method');
    });

    it('classifies constructor from doc hint', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 MyClass#constructor().', 'constructor')).toBe('constructor');
    });

    it('classifies function with disambiguator', () => {
      expect(inferKindFromScipSymbol('scip-java jdk 17 pkg/Foo#bar(+1).', '')).toBe('method');
    });
  });

  describe('types', () => {
    it('classifies class', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 MyClass#', '')).toBe('class');
    });

    it('classifies interface from doc hint', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 MyInterface#', 'interface MyInterface')).toBe('interface');
    });

    it('classifies Rust trait', () => {
      expect(inferKindFromScipSymbol('rust-analyzer cargo pkg 1.0 MyTrait#', 'trait MyTrait')).toBe('interface');
    });

    it('classifies enum', () => {
      expect(inferKindFromScipSymbol('scip-java jdk 17 Color#', 'enum Color')).toBe('enum');
    });

    it('classifies type alias', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 Id#', 'type Id = string')).toBe('type_alias');
    });
  });

  describe('terms', () => {
    it('classifies variable', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 myVar.', '')).toBe('variable');
    });

    it('classifies constant from doc hint', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 MAX_SIZE.', 'const MAX_SIZE')).toBe('constant');
    });

    it('classifies property from doc hint', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 MyClass#name.', '(property) name')).toBe('property');
    });

    it('classifies enum member from doc hint', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 Color#Red.', '(enum member) Red')).toBe('enum_member');
    });
  });

  describe('other', () => {
    it('classifies namespace/module', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 src/', '')).toBe('module');
    });

    it('classifies meta property', () => {
      expect(inferKindFromScipSymbol('scip-typescript npm pkg 1.0 MyClass#name:', '')).toBe('property');
    });
  });
});

// ─── classifyScipReference ──────────────────────────────────────────────────

describe('classifyScipReference', () => {
  it('classifies function call', () => {
    expect(classifyScipReference('scip-go gomod pkg 1.0 doThing().')).toBe('call');
  });

  it('classifies method call with disambiguator', () => {
    expect(classifyScipReference('scip-java jdk 17 Foo#bar(+1).')).toBe('call');
  });

  it('classifies type reference', () => {
    expect(classifyScipReference('scip-typescript npm pkg 1.0 MyClass#')).toBe('type');
  });

  it('classifies type parameter reference', () => {
    expect(classifyScipReference('scip-typescript npm pkg 1.0 [T]')).toBe('type');
  });

  it('skips variable/term reference', () => {
    expect(classifyScipReference('scip-typescript npm pkg 1.0 myVar.')).toBe('skip');
  });

  it('skips namespace reference', () => {
    expect(classifyScipReference('scip-typescript npm pkg 1.0 src/')).toBe('skip');
  });

  it('skips parameter reference', () => {
    expect(classifyScipReference('scip-typescript npm pkg 1.0 (x)')).toBe('skip');
  });

  it('skips meta property reference', () => {
    expect(classifyScipReference('scip-typescript npm pkg 1.0 key:')).toBe('skip');
  });
});

// ─── inferLoreLanguage ──────────────────────────────────────────────────────

describe('inferLoreLanguage', () => {
  describe('from explicit language string', () => {
    it('maps "TypeScript" (case-insensitive)', () => {
      expect(inferLoreLanguage('TypeScript', 'foo.ts')).toBe('typescript');
    });

    it('maps "C++" variant', () => {
      expect(inferLoreLanguage('C++', 'foo.cpp')).toBe('cpp');
    });

    it('maps "C#" variant', () => {
      expect(inferLoreLanguage('C#', 'foo.cs')).toBe('csharp');
    });

    it('maps "Dart"', () => {
      expect(inferLoreLanguage('Dart', 'foo.dart')).toBe('dart');
    });

    it('maps "Go"', () => {
      expect(inferLoreLanguage('Go', 'foo.go')).toBe('go');
    });
  });

  describe('from file extension (empty language)', () => {
    it('infers .go', () => {
      expect(inferLoreLanguage('', 'main.go')).toBe('go');
    });

    it('returns null for .dart (no walker support)', () => {
      expect(inferLoreLanguage('', 'lib/widget.dart')).toBeNull();
    });

    it('infers .rs', () => {
      expect(inferLoreLanguage('', 'src/main.rs')).toBe('rust');
    });

    it('infers .py', () => {
      expect(inferLoreLanguage('', 'app.py')).toBe('python');
    });

    it('returns null for unknown extension', () => {
      expect(inferLoreLanguage('', 'Makefile')).toBeNull();
    });
  });
});

// ─── extractNameFromScipSymbol ──────────────────────────────────────────────

describe('extractNameFromScipSymbol', () => {
  it('extracts method name', () => {
    expect(extractNameFromScipSymbol('scip-typescript npm pkg 1.0 src/`file.ts`/MyClass#myMethod().')).toBe('myMethod');
  });

  it('extracts class name', () => {
    expect(extractNameFromScipSymbol('scip-typescript npm pkg 1.0 src/`file.ts`/MyClass#')).toBe('MyClass');
  });

  it('extracts variable name', () => {
    expect(extractNameFromScipSymbol('scip-typescript npm pkg 1.0 src/`file.ts`/myVar.')).toBe('myVar');
  });

  it('strips backtick escaping', () => {
    expect(extractNameFromScipSymbol('scip-typescript npm pkg 1.0 src/`special-name`.')).toBe('special-name');
  });
});

// ─── extractParentScipSymbol ────────────────────────────────────────────────

describe('extractParentScipSymbol', () => {
  it('returns class for a method', () => {
    expect(extractParentScipSymbol('scip-typescript npm pkg 1.0 src/`file.ts`/MyClass#myMethod().')).toBe(
      'scip-typescript npm pkg 1.0 src/`file.ts`/MyClass#',
    );
  });

  it('returns namespace for a class', () => {
    expect(extractParentScipSymbol('scip-typescript npm pkg 1.0 src/`file.ts`/MyClass#')).toBe(
      'scip-typescript npm pkg 1.0 src/`file.ts`/',
    );
  });

  it('returns namespace for a top-level term', () => {
    expect(extractParentScipSymbol('scip-typescript npm pkg 1.0 src/`file.ts`/myVar.')).toBe(
      'scip-typescript npm pkg 1.0 src/`file.ts`/',
    );
  });

  it('returns null for local symbols', () => {
    expect(extractParentScipSymbol('local 42')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractParentScipSymbol('')).toBeNull();
  });

  it('returns null for single descriptor (top-level namespace)', () => {
    expect(extractParentScipSymbol('scip-typescript npm pkg 1.0 src/')).toBeNull();
  });

  it('handles Java nested class with method', () => {
    expect(extractParentScipSymbol('scip-java maven com.fasterxml 2.17 com/fasterxml/jackson/BeanSerializer#serialize().')).toBe(
      'scip-java maven com.fasterxml 2.17 com/fasterxml/jackson/BeanSerializer#',
    );
  });

  it('handles Go package-level function', () => {
    expect(extractParentScipSymbol('scip-go gomod github.com/esbuild/esbuild v0.19 internal/bundler/bundler.go/parseFile().')).toBe(
      'scip-go gomod github.com/esbuild/esbuild v0.19 internal/bundler/bundler.go/',
    );
  });

  it('handles disambiguated method', () => {
    expect(extractParentScipSymbol('scip-java maven pkg 1.0 com/Foo#bar(+1).')).toBe(
      'scip-java maven pkg 1.0 com/Foo#',
    );
  });

  it('handles meta descriptor (property ending with :)', () => {
    expect(extractParentScipSymbol('scip-typescript npm pkg 1.0 src/`file.ts`/MyClass#myProp:')).toBe(
      'scip-typescript npm pkg 1.0 src/`file.ts`/MyClass#',
    );
  });
});
