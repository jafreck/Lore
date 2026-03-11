import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { CSharpExtractor } from '../../src/indexer/extractors/csharp.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('csharp', path.join(fixtureDir, 'csharp/sample.cs'), new CSharpExtractor());

describe('C# symbols', () => {
  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Greeter', kind: 'class' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Program', kind: 'class' }));
  });

  test('extracts interface', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'ICalculator', kind: 'interface' }));
  });

  test('extracts methods (reported as function kind)', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Main', kind: 'function' }));
  });
});

describe('C# imports', () => {
  test('extracts using directives', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'System' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'System.Collections.Generic' }));
  });
});

describe('C# call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('C# type refs', () => {
  test('produces type refs', () => {
    expect(result.typeRefs.length).toBeGreaterThan(0);
  });

  test('all type refs have line numbers', () => {
    for (const ref of result.typeRefs) {
      expect(typeof ref.line).toBe('number');
    }
  });
});
