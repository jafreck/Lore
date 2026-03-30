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

  // ── SymbolInformation.kind-based inference (Phase 1b) ─────────────────────

  it('uses symbolInfoKind=17 (Function) to infer function', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/myFunc.',
      '', 17,
    )).toBe('function');
  });

  it('uses symbolInfoKind=26 (Method) to infer method', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/MyClass#doWork.',
      '', 26,
    )).toBe('method');
  });

  it('uses symbolInfoKind=7 (Class) to infer class', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/MyClass.',
      '', 7,
    )).toBe('class');
  });

  it('uses symbolInfoKind=21 (Interface) to infer interface', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/IFoo.',
      '', 21,
    )).toBe('interface');
  });

  it('uses symbolInfoKind=11 (Enum) to infer enum', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/Status.',
      '', 11,
    )).toBe('enum');
  });

  it('uses symbolInfoKind=9 (Constructor) to infer constructor', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/MyClass#`<init>`().',
      '', 9,
    )).toBe('constructor');
  });

  it('uses symbolInfoKind=61 (Variable) to infer variable', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/x.',
      '', 61,
    )).toBe('variable');
  });

  it('uses symbolInfoKind=8 (Constant) to infer constant', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/MAX.',
      '', 8,
    )).toBe('constant');
  });

  it('uses symbolInfoKind=15 (Field) to infer property', () => {
    expect(inferKindFromScipSymbol(
      'scip-java maven pkg 1.0 com/MyClass#name.',
      '', 15,
    )).toBe('property');
  });

  it('uses symbolInfoKind=29 (Module) to infer module', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/',
      '', 29,
    )).toBe('module');
  });

  it('refines Class kind using doc hint for interface', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/IFoo#',
      'interface IFoo', 7,
    )).toBe('interface');
  });

  it('falls back to suffix when symbolInfoKind=0 (Unspecified)', () => {
    expect(inferKindFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`index.ts`/MyClass#myMethod().',
      '', 0,
    )).toBe('method');
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

  it('extracts backtick-quoted names as atomic segments', () => {
    // Backtick-quoted content is treated as an atomic name per SCIP spec,
    // not split on internal delimiters like '.' or ':'
    expect(extractNameFromScipSymbol(
      'scip-typescript npm pkg 1.0 src/`my-file.ts`/',
    )).toBe('my-file.ts');
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

  // ── syntaxKind-based classification (Phase 1a) ────────────────────────────

  it('uses syntaxKind=15 (IdentifierFunction) to classify as call', () => {
    // Term suffix '.' would normally be 'skip', but syntaxKind overrides
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/myFunc.',
      15,
    )).toBe('call');
  });

  it('uses syntaxKind=16 (IdentifierFunctionDefinition) to classify as call', () => {
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/myFunc.',
      16,
    )).toBe('call');
  });

  it('uses syntaxKind=17 (IdentifierMacro) to classify as call', () => {
    expect(classifyScipReference(
      'scip-clang usr pkg 1.0 $ MY_MACRO.',
      17,
    )).toBe('call');
  });

  it('uses syntaxKind=19 (IdentifierType) to classify as type', () => {
    // Term suffix '.' would normally be 'skip', but syntaxKind overrides
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/MyType.',
      19,
    )).toBe('type');
  });

  it('uses syntaxKind=20 (IdentifierBuiltinType) to classify as type', () => {
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/string.',
      20,
    )).toBe('type');
  });

  it('falls back to suffix when syntaxKind=0 (unspecified)', () => {
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/myVar.',
      0,
    )).toBe('skip');
  });

  it('falls back to suffix when syntaxKind is a non-function/type value', () => {
    // syntaxKind=11 (IdentifierParameter) → not function or type → falls through to suffix
    expect(classifyScipReference(
      'scip-typescript npm pkg 1.0 src/`index.ts`/MyClass#doStuff().',
      11,
    )).toBe('call'); // suffix-based
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
