import { describe, it, expect } from 'vitest';
import { ParserPool } from '../../../src/indexer/parser.js';
import {
  TypeScriptExtractor,
  TYPESCRIPT_COMPLEXITY_NODE_TYPES,
} from '../../../src/indexer/extractors/typescript.js';

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

  it('should include the original AST node on extracted symbols', () => {
    const result = extractFromSource('export function hello(name: string) { return name; }');
    expect(result.symbols[0]?.astNode?.type).toBe('function_declaration');
  });
});

describe('TYPESCRIPT_COMPLEXITY_NODE_TYPES', () => {
  it('should include parameter, decision, and nesting node types used for complexity metrics', () => {
    expect(TYPESCRIPT_COMPLEXITY_NODE_TYPES.parameterListTypes).toContain('formal_parameters');
    expect(TYPESCRIPT_COMPLEXITY_NODE_TYPES.parameterTypes).toContain('required_parameter');
    expect(TYPESCRIPT_COMPLEXITY_NODE_TYPES.decisionTypes).toContain('if_statement');
    expect(TYPESCRIPT_COMPLEXITY_NODE_TYPES.nestingTypes).toContain('switch_statement');
  });
});
