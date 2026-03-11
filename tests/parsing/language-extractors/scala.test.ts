import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { ScalaExtractor } from '../../../src/parsing/extractors/scala.js';

const ext = new ScalaExtractor();
const fixture = (name: string) => parseAndExtractStrict('scala', path.join(import.meta.dirname, '../../fixtures/scala', name), ext);

describe('Scala function extraction', () => {
  const r = fixture('function.scala');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Scala class extraction', () => {
  const r = fixture('class.scala');
  test('extracts class and trait', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'trait' }));
  });
});

describe('Scala object extraction', () => {
  const r = fixture('object.scala');
  test('extracts object', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'MathUtils' }));
  });
});

describe('Scala import extraction', () => {
  const r = fixture('imports.scala');
  test('extracts imports', () => {
    expect(r.imports).toHaveLength(2);
  });
});

describe('Scala type refs', () => {
  const r = fixture('typerefs.scala');
  test('extracts function with typed parameter', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'load', kind: 'function' }));
  });
});
