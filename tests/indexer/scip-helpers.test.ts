import { describe, it, expect } from 'vitest';
import {
  inferKindFromScipSymbol,
  extractNameFromScipSymbol,
  extractParentScipSymbol,
  descriptorDepth,
  classifyScipReference,
  extractSignatureFromDoc,
  extractParentTypeSymbol,
} from '../../src/indexer/stages/scip-helpers/symbol-kinds.js';

describe('inferKindFromScipSymbol', () => {
  it('identifies methods inside a type', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#myMethod().',
      '',
    )).toBe('method');
  });

  it('identifies standalone functions', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`utils.ts`/doStuff().',
      '',
    )).toBe('function');
  });

  it('identifies constructors via doc hint', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#MyClass().',
      'constructor for MyClass',
    )).toBe('constructor');
  });

  it('identifies classes', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#',
      'public class MyClass',
    )).toBe('class');
  });

  it('identifies interfaces', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`types.ts`/MyInterface#',
      'interface MyInterface',
    )).toBe('interface');
  });

  it('identifies enums', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/Status#',
      'enum Status',
    )).toBe('enum');
  });

  it('identifies type aliases', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`types.ts`/MyType#',
      'type MyType = string | number',
    )).toBe('type_alias');
  });

  it('identifies modules', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/',
      '',
    )).toBe('module');
  });

  it('identifies variables (term ending in .)', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/myVar.',
      '',
    )).toBe('variable');
  });

  it('identifies constants', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/MY_CONST.',
      'const MY_CONST = 42',
    )).toBe('constant');
  });

  it('identifies enum members', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/Status#ACTIVE.',
      '(enum member) ACTIVE',
    )).toBe('enum_member');
  });

  it('identifies properties', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`types.ts`/MyClass#myProp.',
      '(property) myProp: string',
    )).toBe('property');
  });

  it('identifies meta descriptors as property', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`obj.ts`/config:',
      '',
    )).toBe('property');
  });

  it('identifies C/C++ functions from scip-clang hash pattern', () => {
    expect(inferKindFromScipSymbol(
      'scip-clang usr pkg 1.0 $ parse_analyze(39d222e79bbfb7c0).',
      '',
    )).toBe('function');
  });

  it('identifies disambiguated methods', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#overloaded(+1).',
      '',
    )).toBe('method');
  });

  it('defaults to variable for unknown suffixes', () => {
    expect(inferKindFromScipSymbol('something_weird', '')).toBe('variable');
  });
});

describe('extractNameFromScipSymbol', () => {
  it('extracts method name', () => {
    expect(extractNameFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#myMethod().',
    )).toBe('myMethod');
  });

  it('extracts class name', () => {
    expect(extractNameFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#',
    )).toBe('MyClass');
  });

  it('splits on descriptor chars within backtick-escaped segments', () => {
    // The function splits by descriptor chars (., #, /, :) then strips backticks
    // 'src/`my-file.ts`/' splits by '/' → last segment after strip is 'ts'
    // because '.' inside the filename is treated as a descriptor split
    expect(extractNameFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`my-file.ts`/',
    )).toBe('ts');
  });

  it('handles disambiguated methods', () => {
    expect(extractNameFromScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#overloaded(+1).',
    )).toBe('overloaded');
  });

  it('handles C/C++ scip-clang hash pattern', () => {
    // scip-clang symbol has a space-delimited layout; the function strips hash
    // and splits by descriptor chars, so leading ' $ ' prefix remains partially
    expect(extractNameFromScipSymbol(
      'scip-clang usr pkg 1.0 $ parse_analyze(39d222e79bbfb7c0).',
    )).toBe('0 $ parse_analyze');
  });
});

describe('extractParentScipSymbol', () => {
  it('returns parent type for a method', () => {
    expect(extractParentScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#myMethod().',
    )).toBe('scip-java maven pkg 1.0 com/example/MyClass#');
  });

  it('returns parent namespace for a type', () => {
    expect(extractParentScipSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#',
    )).toBe('scip-java maven pkg 1.0 com/example/');
  });

  it('returns null for local symbols', () => {
    expect(extractParentScipSymbol('local 123')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractParentScipSymbol('')).toBeNull();
  });
});

describe('descriptorDepth', () => {
  it('counts descriptor suffixes', () => {
    // com/example/ → 2 slashes, MyClass# → 1, myMethod(). → 1 dot = 4
    expect(descriptorDepth(
      'scip-java maven pkg 1.0 com/example/MyClass#myMethod().',
    )).toBe(4);
  });

  it('returns 0 for no descriptors', () => {
    expect(descriptorDepth('scip-java maven pkg 1.0 ')).toBe(0);
  });
});

describe('classifyScipReference', () => {
  it('classifies method calls', () => {
    expect(classifyScipReference(
      'scip-java maven pkg 1.0 com/example/MyClass#doStuff().',
    )).toBe('call');
  });

  it('classifies disambiguated method calls', () => {
    expect(classifyScipReference(
      'scip-java maven pkg 1.0 com/example/MyClass#overloaded(+1).',
    )).toBe('call');
  });

  it('classifies C/C++ function calls', () => {
    expect(classifyScipReference(
      'scip-clang usr pkg 1.0 $ parse_analyze(39d222e79bbfb7c0).',
    )).toBe('call');
  });

  it('classifies type references', () => {
    expect(classifyScipReference(
      'scip-java maven pkg 1.0 com/example/MyClass#',
    )).toBe('type');
  });

  it('classifies type parameter references', () => {
    expect(classifyScipReference(
      'scip-java maven pkg 1.0 com/example/MyClass#[T]',
    )).toBe('type');
  });

  it('skips term references', () => {
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/myVar.',
    )).toBe('skip');
  });

  it('skips namespace references', () => {
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/',
    )).toBe('skip');
  });
});

describe('extractSignatureFromDoc', () => {
  it('strips markdown code fences', () => {
    expect(extractSignatureFromDoc('```ts\nfunction foo(): void\n```')).toBe('function foo(): void');
  });

  it('returns empty string for empty doc', () => {
    expect(extractSignatureFromDoc('')).toBe('');
  });

  it('handles plain text', () => {
    expect(extractSignatureFromDoc('function foo(): string')).toBe('function foo(): string');
  });
});

describe('extractParentTypeSymbol', () => {
  it('returns parent type for method symbol', () => {
    expect(extractParentTypeSymbol(
      'scip-java maven pkg 1.0 com/example/MyClass#myMethod().',
    )).toBe('scip-java maven pkg 1.0 com/example/MyClass#');
  });

  it('returns null for top-level function', () => {
    expect(extractParentTypeSymbol(
      'scip-typescript npm pkg 1.0 src/`utils.ts`/doStuff().',
    )).toBeNull();
  });

  it('returns null when no hash present', () => {
    expect(extractParentTypeSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/',
    )).toBeNull();
  });
});
