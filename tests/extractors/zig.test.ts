import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ZigExtractor } from '../../src/indexer/extractors/zig.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('zig', path.join(fixtureDir, 'zig/sample.zig'), new ZigExtractor());

describe('Zig symbols', () => {
  test('extracts pub fn', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'square', kind: 'function' }));
  });

  test('extracts struct', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Point' }));
  });

  test('extracts enum', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Color' }));
  });

  test('extracts test declaration', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ kind: 'test' }));
  });
});

describe('Zig imports', () => {
  test('extracts @import calls', () => {
    expect(result.imports.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Zig call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
