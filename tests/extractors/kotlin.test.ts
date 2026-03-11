import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { KotlinExtractor } from '../../src/indexer/extractors/kotlin.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('kotlin', path.join(fixtureDir, 'kotlin/sample.kt'), new KotlinExtractor());

describe('Kotlin symbols', () => {
  test('extracts top-level functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });

  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts interface (reported as class kind)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'class' }));
  });

  test('extracts object declaration', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'MathUtils' }));
  });
});

describe('Kotlin relationships', () => {
  test('captures inheritance', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'Shape' }),
    );
  });
});

describe('Kotlin type refs', () => {
  test('extracts return type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'return').length).toBeGreaterThan(0);
  });

  test('extracts bound type refs from inheritance', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'bound').length).toBeGreaterThan(0);
  });

  test('extracts cast type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'cast').length).toBeGreaterThan(0);
  });

  test('has at least 9 type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThanOrEqual(9);
  });
});

describe('Kotlin imports', () => {
  test('extracts imports', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('Kotlin call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
