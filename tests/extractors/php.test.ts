import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { PhpExtractor } from '../../src/indexer/extractors/php.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('php', path.join(fixtureDir, 'php/sample.php'), new PhpExtractor());

describe('PHP symbols', () => {
  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });

  test('extracts interface', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });

  test('extracts classes', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Animal', kind: 'class' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });

  test('extracts trait', () => {
    expect(result.symbols.some(s => s.name === 'Greetable')).toBe(true);
  });
});

describe('PHP imports', () => {
  test('extracts use statements', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('PHP call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('PHP relationships', () => {
  test('captures extends', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'Animal' }),
    );
  });

  test('captures implements', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'implements', fromSymbol: 'Circle', toSymbol: 'Shape' }),
    );
  });
});

describe('PHP type refs', () => {
  test('extracts parameter type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'parameter').length).toBeGreaterThan(0);
  });

  test('extracts return type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'return').length).toBeGreaterThan(0);
  });

  test('extracts field type refs', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'field').length).toBeGreaterThan(0);
  });

  test('extracts bound type refs from inheritance', () => {
    expect(result.typeRefs.filter(r => r.refKind === 'bound').length).toBeGreaterThan(0);
  });

  test('has at least 14 type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThanOrEqual(14);
  });
});
