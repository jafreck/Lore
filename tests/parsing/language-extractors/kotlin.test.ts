import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { KotlinExtractor } from '../../../src/parsing/extractors/kotlin.js';

const ext = new KotlinExtractor();
const fixture = (name: string) => parseAndExtractStrict('kotlin', path.join(import.meta.dirname, '../../fixtures/kotlin', name), ext);

describe('Kotlin function extraction', () => {
  const r = fixture('function.kt');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Kotlin class extraction', () => {
  const r = fixture('class.kt');
  test('extracts class and interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'class' }));
  });
  test('extracts extends relationship', () => {
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'Shape' }));
  });
});

describe('Kotlin object extraction', () => {
  const r = fixture('object.kt');
  test('extracts object declaration', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'MathUtils' }));
  });
});

describe('Kotlin import extraction', () => {
  const r = fixture('imports.kt');
  test('extracts imports', () => {
    expect(r.imports).toHaveLength(2);
  });
});

describe('Kotlin call-ref extraction', () => {
  const r = fixture('callref.kt');
  test('extracts call refs', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Kotlin type refs', () => {
  const r = fixture('typerefs.kt');
  test('extracts function with typed parameter', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'load', kind: 'function' }));
  });
});

describe('Kotlin cast type ref', () => {
  const r = fixture('typeref-cast.kt');
  test('extracts cast type ref', () => {
    const casts = r.typeRefs.filter(t => t.refKind === 'cast');
    expect(casts).toHaveLength(1);
  });
});
