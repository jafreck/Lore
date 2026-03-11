import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { RustExtractor } from '../../src/indexer/extractors/rust.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('rust', path.join(fixtureDir, 'rust/sample.rs'), new RustExtractor());

describe('Rust symbols', () => {
  test('extracts structs', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'struct' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Rectangle', kind: 'struct' }));
  });

  test('extracts enum', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });

  test('extracts trait', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'trait' }));
  });

  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });
});

describe('Rust imports', () => {
  test('extracts use imports', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'std::fmt' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'std::collections::HashMap' }));
  });
});

describe('Rust call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Rust relationships', () => {
  test('captures trait implementation', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'implements', toSymbol: 'Shape' }),
    );
  });
});

describe('Rust type refs', () => {
  test('extracts return type refs', () => {
    const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
    expect(returnRefs.length).toBeGreaterThan(0);
    expect(returnRefs).toContainEqual(
      expect.objectContaining({ typeRaw: 'String', enclosingSymbol: 'greet' }),
    );
  });

  test('extracts field type refs from structs', () => {
    // Rust struct fields use primitive types (f64) which are not type_identifier nodes
    const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
    expect(fieldRefs.length).toBe(0);
  });
});
