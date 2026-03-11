import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { RubyExtractor } from '../../src/indexer/extractors/ruby.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('ruby', path.join(fixtureDir, 'ruby/sample.rb'), new RubyExtractor());

describe('Ruby symbols', () => {
  test('extracts module', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Geometry', kind: 'module' }));
  });

  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts methods (reported as function kind)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'perimeter', kind: 'function' }));
  });

  test('extracts top-level functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('Ruby imports', () => {
  test('extracts require statements', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'json' }));
  });

  test('extracts require_relative', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'shape' }));
  });
});

describe('Ruby call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
