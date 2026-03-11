import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { SwiftExtractor } from '../../src/indexer/extractors/swift.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('swift', path.join(fixtureDir, 'swift/sample.swift'), new SwiftExtractor());

describe('Swift symbols', () => {
  test('extracts protocol (reported as interface kind)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });

  test('extracts struct (reported as class kind by Swift extractor)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Rectangle', kind: 'class' }));
  });

  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts extension methods', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'describe' }));
  });
});

describe('Swift imports', () => {
  test('extracts imports', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'Foundation' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'Darwin' }));
  });
});

describe('Swift call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Swift relationships', () => {
  test('captures protocol conformance', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ fromSymbol: 'Circle', toSymbol: 'Shape' }),
    );
  });
});

describe('Swift type refs', () => {
  test('produces type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThan(0);
  });

  test('all type refs have line numbers', () => {
    for (const ref of result.typeRefs) {
      expect(typeof ref.line).toBe('number');
    }
  });
});
