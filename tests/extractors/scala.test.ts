import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ScalaExtractor } from '../../src/indexer/extractors/scala.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('scala', path.join(fixtureDir, 'scala/sample.scala'), new ScalaExtractor());

describe('Scala symbols', () => {
  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts trait', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'trait' }));
  });

  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts object (singleton)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'MathUtils' }));
  });
});

describe('Scala imports', () => {
  test('extracts imports', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('Scala call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Scala relationships', () => {
  test('relationships array exists', () => {
    expect(Array.isArray(result.relationships)).toBe(true);
  });
});
