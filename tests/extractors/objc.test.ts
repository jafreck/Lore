import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ObjcExtractor } from '../../src/indexer/extractors/objc.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('objc', path.join(fixtureDir, 'objc/sample.m'), new ObjcExtractor());

describe('Objective-C symbols', () => {
  test('extracts protocol declaration', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Drawable', kind: 'interface' }));
  });

  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts category', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'NSString' }));
  });

  test('extracts methods', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'initWithRadius', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'processData', kind: 'function' }));
  });

  test('extracts class implementation', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ kind: 'impl' }));
  });
});

describe('Objective-C imports', () => {
  test('extracts #import directives', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });

  test('extracts @import module directive', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'UIKit' }));
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
    expect(result.typeRefs.length).toBeGreaterThan(0);
  });
});
