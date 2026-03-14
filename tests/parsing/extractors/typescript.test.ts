import { describe, it, expect } from 'vitest';
import { ParserPool } from '../../../src/parsing/parser.js';
import {
  TypeScriptExtractor,
  TYPESCRIPT_COMPLEXITY_NODE_TYPES,
} from '../../../src/parsing/extractors/typescript.js';

const pool = new ParserPool();
const extractor = new TypeScriptExtractor();

function extractFromSource(source: string, filePath = 'inline.ts') {
  const tree = pool.parse('typescript', source);
  if (!tree) {
    throw new Error('TypeScript grammar is unavailable');
  }
  return extractor.extract(tree, source, filePath);
}

describe('TypeScriptExtractor', () => {
  it('should extract an extends relationship for class inheritance', () => {
    const result = extractFromSource(`
      class Base {}
      class Child extends Base {}
    `);

    expect(result.relationships).toEqual([
      { kind: 'extends', fromSymbol: 'Child', toSymbol: 'Base', line: 2, character: 26 },
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

  it('should mark exported declarations and capture leading JSDoc comments', () => {
    const result = extractFromSource(`
      /** Public API docs */
      export declare function depPublic(input: string): string;
      declare function depPrivate(): void;
    `, 'inline.d.ts');

    const publicSymbol = result.symbols.find((symbol) => symbol.name === 'depPublic');
    const privateSymbol = result.symbols.find((symbol) => symbol.name === 'depPrivate');
    expect(publicSymbol?.isExported).toBe(true);
    expect(publicSymbol?.docComment).toContain('Public API docs');
    expect(privateSymbol?.isExported).toBeUndefined();
  });

  it('should mark exported symbols but not attach doc comments for non-declaration files', () => {
    const result = extractFromSource(`
      /** Runtime docs should not be captured in non-declaration mode */
      export function runtimePublic(input: string): string {
        return input;
      }
    `, 'inline.ts');

    const runtimeSymbol = result.symbols.find((symbol) => symbol.name === 'runtimePublic');
    expect(runtimeSymbol?.isExported).toBe(true);
    expect(runtimeSymbol?.docComment).toBeUndefined();
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
