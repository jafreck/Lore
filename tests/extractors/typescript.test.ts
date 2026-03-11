import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { TypeScriptExtractor } from '../../src/indexer/extractors/typescript.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('typescript', path.join(fixtureDir, 'typescript/sample.ts'), new TypeScriptExtractor());

describe('TypeScript symbols', () => {
  test('extracts interface', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });

  test('extracts interface with extends', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Describable', kind: 'interface' }));
  });

  test('extracts type alias', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'type' }));
  });

  test('extracts enum', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }));
  });

  test('extracts exported functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'BaseShape', kind: 'class' }));
  });

  test('extracts arrow function exports', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'multiply' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'formatPath' }));
  });

  test('extracts function from const with cast/assertion', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'convert', kind: 'function' }));
  });
});

describe('TypeScript imports', () => {
  test('extracts named import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'fs' }));
  });

  test('extracts default import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'path' }));
  });

  test('extracts namespace import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'os' }));
  });
});

describe('TypeScript call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('TypeScript relationships', () => {
  test('captures extends relationship', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'BaseShape' }),
    );
  });

  test('captures extends relationship only (TS uses extends for all heritage)', () => {
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'BaseShape' }),
    );
  });
});

describe('TypeScript type refs', () => {
  test('extracts bound type refs', () => {
    const boundRefs = result.typeRefs.filter(r => r.refKind === 'bound');
    expect(boundRefs.length).toBeGreaterThan(0);
  });

  test('extracts variable type refs', () => {
    const varRefs = result.typeRefs.filter(r => r.refKind === 'variable');
    expect(varRefs.length).toBeGreaterThan(0);
  });

  test('has at least 5 type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThanOrEqual(5);
  });

  test('all type refs have line numbers', () => {
    for (const ref of result.typeRefs) {
      expect(typeof ref.line).toBe('number');
    }
  });
});
