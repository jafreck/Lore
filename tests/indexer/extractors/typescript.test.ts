import { describe, it, expect } from 'vitest';
import { ParserPool } from '../../../src/indexer/parser.js';
import { TypeScriptExtractor } from '../../../src/indexer/extractors/typescript.js';

const pool = new ParserPool();
const extractor = new TypeScriptExtractor();

function extractFromSource(source: string) {
  const tree = pool.parse('typescript', source);
  if (!tree) {
    throw new Error('TypeScript grammar is unavailable');
  }
  return extractor.extract(tree, source, 'inline.ts');
}

describe('TypeScriptExtractor', () => {
  it('should extract an extends relationship for class inheritance', () => {
    const result = extractFromSource(`
      class Base {}
      class Child extends Base {}
    `);

    expect(result.relationships).toEqual([
      { kind: 'extends', fromSymbol: 'Child', toSymbol: 'Base', line: 2 },
    ]);
  });

  it('should return no relationships when classes do not extend another class', () => {
    const result = extractFromSource(`
      class Standalone {}
    `);

    expect(result.relationships).toEqual([]);
  });
});
