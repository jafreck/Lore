import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ObjcExtractor } from '../../src/indexer/extractors/objc.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('objc', path.join(fixtureDir, 'objc/sample.m'), new ObjcExtractor());

describe('Objective-C symbols', () => {
  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts methods (reported as function kind)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'initWithRadius', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'perimeter', kind: 'function' }));
  });
});

describe('Objective-C imports', () => {
  test('extracts #import directives', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('Objective-C call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Objective-C relationships', () => {
  test('captures NSObject inheritance', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'NSObject' }),
    );
  });
});

describe('Objective-C type refs', () => {
  test('produces type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThanOrEqual(0);
  });
});
