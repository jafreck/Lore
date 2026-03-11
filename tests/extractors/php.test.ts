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

  test('extracts class', () => {
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
  test('captures implements', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'implements', fromSymbol: 'Circle', toSymbol: 'Shape' }),
    );
  });
});

describe('PHP type refs', () => {
  test('produces type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThan(0);
  });
});
