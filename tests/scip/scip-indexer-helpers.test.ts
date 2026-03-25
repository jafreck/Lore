/**
 * Tests for the SCIP indexer stage helper functions.
 *
 * Covers inferKindFromScipSymbol, classifyScipReference, inferLoreLanguage,
 * extractNameFromScipSymbol, and extractParentScipSymbol.
 */

import { describe, expect, it } from 'vitest';
import {
  _inferKindFromScipSymbol as inferKindFromScipSymbol,
  _inferLoreLanguage as inferLoreLanguage,
  _classifyScipReference as classifyScipReference,
  _extractNameFromScipSymbol as extractNameFromScipSymbol,
  _extractParentScipSymbol as extractParentScipSymbol,
} from '../../src/indexer/stages/scip-indexer.js';

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
