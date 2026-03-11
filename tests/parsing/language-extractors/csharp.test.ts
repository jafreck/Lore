import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { CSharpExtractor } from '../../../src/parsing/extractors/csharp.js';

const ext = new CSharpExtractor();
const fixture = (name: string) => parseAndExtractStrict('csharp', path.join(import.meta.dirname, '../../fixtures/csharp', name), ext);

describe('C# class extraction', () => {
  const r = fixture('class.cs');
  test('extracts class and method', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Greeter', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Greet', kind: 'function' }));
  });
});

describe('C# interface extraction', () => {
  const r = fixture('interface.cs');
  test('extracts interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'IShape', kind: 'interface' }));
  });
});

describe('C# struct extraction', () => {
  const r = fixture('struct.cs');
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct' }));
  });
});

describe('C# enum extraction', () => {
  const r = fixture('enum.cs');
  test('extracts enum', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });
});

describe('C# constructor extraction', () => {
  const r = fixture('constructor.cs');
  test('extracts constructor', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Foo', kind: 'function' }));
  });
});

describe('C# using extraction', () => {
  const r = fixture('using.cs');
  test('extracts using directives', () => {
    expect(r.imports).toHaveLength(3);
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'System' }));
  });
  test('extracts aliased using', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'System.Console', importedNames: ['Project'] }));
  });
});

describe('C# call-ref extraction', () => {
  const r = fixture('callref.cs');
  test('extracts call ref', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'Console.WriteLine' }));
  });
});

describe('C# new expression call-ref', () => {
  const r = fixture('callref-new.cs');
  test('extracts new as call ref', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'new Greeter' }));
  });
});

describe('C# base list relationships', () => {
  const r = fixture('relationships.cs');
  test('extracts implements relationship', () => {
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'implements', fromSymbol: 'Circle', toSymbol: 'IShape' }));
  });
});

describe('C# method type refs', () => {
  const r = fixture('typeref-method.cs');
  test('extracts symbols from typed method', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Load', kind: 'function' }));
  });
});

describe('C# field type refs', () => {
  const r = fixture('typeref-field.cs');
  test('extracts field type ref', () => {
    const fields = r.typeRefs.filter(t => t.refKind === 'field');
    expect(fields).toContainEqual(expect.objectContaining({ typeRaw: 'string' }));
  });
});

describe('C# variable type refs', () => {
  const r = fixture('typeref-variable.cs');
  test('extracts variable type ref', () => {
    const vars = r.typeRefs.filter(t => t.refKind === 'variable');
    expect(vars).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});

describe('C# cast type refs', () => {
  const r = fixture('typeref-cast.cs');
  test('extracts cast type ref', () => {
    const casts = r.typeRefs.filter(t => t.refKind === 'cast');
    expect(casts).toContainEqual(expect.objectContaining({ typeRaw: 'int' }));
  });
});

describe('C# as-cast type refs', () => {
  const r = fixture('typeref-as-cast.cs');
  test('extracts as-cast type ref', () => {
    const casts = r.typeRefs.filter(t => t.refKind === 'cast');
    expect(casts).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});
