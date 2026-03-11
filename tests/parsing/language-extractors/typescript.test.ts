import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { TypeScriptExtractor } from '../../../src/parsing/extractors/typescript.js';

const ext = new TypeScriptExtractor();
const fixture = (name: string) => parseAndExtractStrict('typescript', path.join(import.meta.dirname, '../../fixtures/typescript', name), ext);

describe('TS function extraction', () => {
  const r = fixture('function.ts');
  test('extracts exported function', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'greet', kind: 'function' });
  });
});

describe('TS arrow function extraction', () => {
  const r = fixture('arrow-function.ts');
  test('extracts arrow function from const declaration', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'multiply', kind: 'function' });
  });
});

describe('TS function expression extraction', () => {
  const r = fixture('function-expression.ts');
  test('extracts function expression from const', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'handler', kind: 'function' });
  });
});

describe('TS generator function extraction', () => {
  const r = fixture('generator-function.ts');
  test('extracts generator function declaration', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'gen', kind: 'function' });
  });
});

describe('TS class extraction', () => {
  const r = fixture('class.ts');
  test('extracts class with extends relationship', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
    expect(r.relationships).toContainEqual(expect.objectContaining({
      kind: 'extends', fromSymbol: 'Circle', toSymbol: 'Base',
    }));
  });
});

describe('TS interface extraction', () => {
  const r = fixture('interface.ts');
  test('extracts interfaces', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Describable', kind: 'interface' }));
  });
});

describe('TS type alias and enum extraction', () => {
  const r = fixture('type-and-enum.ts');
  test('extracts type alias and enum', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'type' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });
});

describe('TS declaration mode', () => {
  const r = fixture('declaration-mode.d.ts');
  test('marks symbols as exported', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', isExported: true }));
  });
  test('extracts doc comments', () => {
    const greetSym = r.symbols.find(s => s.name === 'greet');
    expect(greetSym?.docComment).toContain('Greet someone');
  });
});

describe('TS named import', () => {
  const r = fixture('import-named.ts');
  test('extracts source', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]).toMatchObject({ source: 'fs' });
  });
});

describe('TS default import', () => {
  const r = fixture('import-default.ts');
  test('extracts default import', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]).toMatchObject({ source: 'path' });
  });
});

describe('TS namespace import', () => {
  const r = fixture('import-namespace.ts');
  test('extracts namespace import', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]!.source).toBe('os');
  });
});

describe('TS call-ref extraction', () => {
  const r = fixture('callref.ts');
  test('extracts call ref with callerSymbol', () => {
    expect(r.callRefs).toHaveLength(1);
    expect(r.callRefs[0]).toMatchObject({ calleeRaw: 'bar', callerSymbol: 'foo' });
  });
});

describe('TS parameter type refs', () => {
  const r = fixture('typeref-parameter.ts');
  test('extracts parameter type ref', () => {
    const params = r.typeRefs.filter(t => t.refKind === 'parameter');
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ typeRaw: 'Foo', enclosingSymbol: 'greet' });
  });
});

describe('TS return type refs', () => {
  const r = fixture('typeref-return.ts');
  test('extracts return type ref', () => {
    const returns = r.typeRefs.filter(t => t.refKind === 'return');
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ typeRaw: 'Foo', enclosingSymbol: 'load' });
  });
});

describe('TS class field type refs', () => {
  const r = fixture('typeref-field.ts');
  test('extracts field type ref', () => {
    const fields = r.typeRefs.filter(t => t.refKind === 'field');
    expect(fields).toContainEqual(expect.objectContaining({ typeRaw: 'Point' }));
  });
});

describe('TS variable type refs', () => {
  const r = fixture('typeref-variable.ts');
  test('extracts variable type ref for array element type', () => {
    const vars = r.typeRefs.filter(t => t.refKind === 'variable');
    expect(vars).toContainEqual(expect.objectContaining({ typeRaw: 'Shape' }));
  });
});

describe('TS union type refs', () => {
  const r = fixture('typeref-union.ts');
  test('extracts constituent type from union', () => {
    const vars = r.typeRefs.filter(t => t.refKind === 'variable');
    expect(vars).toContainEqual(expect.objectContaining({ typeRaw: 'Shape' }));
  });
});

describe('TS interface extends type refs', () => {
  const r = fixture('typeref-interface-extends.ts');
  test('extracts bound type ref from extends clause', () => {
    const bounds = r.typeRefs.filter(t => t.refKind === 'bound');
    expect(bounds).toContainEqual(expect.objectContaining({ typeRaw: 'Shape' }));
  });
});

describe('TS as-expression cast', () => {
  const r = fixture('typeref-as-cast.ts');
  test('extracts cast type ref', () => {
    const casts = r.typeRefs.filter(t => t.refKind === 'cast');
    expect(casts).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});

describe('TS type assertion cast', () => {
  const r = fixture('typeref-assertion-cast.ts');
  test('parses file with angle-bracket assertion', () => {
    // <Foo>x type assertions produce the type node directly — verify extraction runs
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'f', kind: 'function' }));
  });
});
