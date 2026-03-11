import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ElixirExtractor } from '../../src/indexer/extractors/elixir.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('elixir', path.join(fixtureDir, 'elixir/sample.ex'), new ElixirExtractor());

describe('Elixir symbols', () => {
  test('extracts module', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Sample', kind: 'module' }));
  });

  test('extracts struct', () => {
    expect(result.symbols.some(s => s.kind === 'struct')).toBe(true);
  });

  test('extracts public function', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts private function', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'format', kind: 'function' }));
  });

  test('extracts protocol', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Stringify', kind: 'interface' }));
  });

  test('extracts protocol implementation', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Stringify', kind: 'impl' }));
  });
});

describe('Elixir imports', () => {
  test('extracts alias/import/use directives', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('Elixir call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
