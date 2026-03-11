import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { JavaExtractor } from '../../../src/parsing/extractors/java.js';

const ext = new JavaExtractor();
const fixture = (name: string) => parseAndExtractStrict('java', path.join(import.meta.dirname, '../../fixtures/java', name), ext);

describe('Java class extraction', () => {
  const r = fixture('class.java');
  test('extracts class and methods', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Sample', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('Java interface extraction', () => {
  const r = fixture('interface.java');
  test('extracts interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });
});

describe('Java interface extends', () => {
  const r = fixture('interface-extends.java');
  test('extracts extends relationship', () => {
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'extends', fromSymbol: 'Describable', toSymbol: 'Shape' }));
  });
});

describe('Java class implements', () => {
  const r = fixture('class-implements.java');
  test('extracts implements relationship', () => {
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'implements', fromSymbol: 'Circle', toSymbol: 'Shape' }));
  });
});

describe('Java enum extraction', () => {
  const r = fixture('enum.java');
  test('extracts enum', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });
});

describe('Java import extraction', () => {
  const r = fixture('imports.java');
  test('extracts imports', () => {
    expect(r.imports).toHaveLength(2);
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'java.util.List' }));
  });
});

describe('Java call-ref extraction', () => {
  const r = fixture('callref.java');
  test('extracts call ref', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'System.out.println' }));
  });
});

describe('Java type refs', () => {
  const r = fixture('typerefs.java');
  test('extracts parameter and return type refs', () => {
    expect(r.typeRefs.filter(t => t.refKind === 'parameter')).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
    expect(r.typeRefs.filter(t => t.refKind === 'return')).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});

describe('Java cast type ref', () => {
  const r = fixture('typeref-cast.java');
  test('parses file with cast', () => {
    // Java primitive casts (double) don't produce type_identifier nodes
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Foo', kind: 'class' }));
  });
});
