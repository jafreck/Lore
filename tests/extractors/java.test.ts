import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { JavaExtractor } from '../../src/indexer/extractors/java.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('java', path.join(fixtureDir, 'java/sample.java'), new JavaExtractor());

describe('Java symbols', () => {
  test('extracts classes', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Sample', kind: 'class' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts interface', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });

  test('extracts methods (reported as function kind)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
  });
});

describe('Java imports', () => {
  test('extracts imports', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'java.util.List' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'java.util.ArrayList' }));
  });
});

describe('Java call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Java relationships', () => {
  test('captures implements relationship', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'implements', fromSymbol: 'Circle', toSymbol: 'Shape' }),
    );
  });

  test('captures extends relationship', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'Animal' }),
    );
  });

  test('captures interface extends interface', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Describable', toSymbol: 'Shape' }),
    );
  });
});

describe('Java type refs', () => {
  test('extracts field type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'field').length).toBeGreaterThan(0);
  });

  test('extracts parameter type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'parameter').length).toBeGreaterThan(0);
  });

  test('extracts return type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'return').length).toBeGreaterThan(0);
  });

  test('extracts variable type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'variable').length).toBeGreaterThan(0);
  });

  test('has at least 10 type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThanOrEqual(10);
  });
});
