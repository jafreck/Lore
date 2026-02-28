import { describe, expect, it } from 'vitest';
import { ParserPool } from '../../src/indexer/parser.js';
import { TypeScriptExtractor } from '../../src/indexer/extractors/typescript.js';
import { computeSymbolMetrics } from '../../src/indexer/complexity.js';

describe('computeSymbolMetrics', () => {
  it('computes line_count, param_count, cyclomatic, and max_nesting', () => {
    const source = [
      'function hello(name: string, times: number): number {',
      '  if (times > 0) {',
      '    for (let i = 0; i < times; i++) {',
      '      return i;',
      '    }',
      '  }',
      '  return 0;',
      '}',
    ].join('\n');

    const tree = new ParserPool().parse('typescript', source);
    expect(tree).not.toBeNull();
    const extracted = new TypeScriptExtractor().extract(tree!, source, '/tmp/hello.ts');
    const symbol = extracted.symbols[0];
    expect(symbol).toBeDefined();

    const metrics = computeSymbolMetrics(symbol!, 'typescript');
    expect(metrics.line_count).toBe(8);
    expect(metrics.param_count).toBe(2);
    expect(metrics.cyclomatic).toBe(3);
    expect(metrics.max_nesting).toBe(2);
  });

  it('defaults to baseline complexity when no AST symbol node is available', () => {
    const metrics = computeSymbolMetrics(
      {
        name: 'fallback',
        kind: 'function',
        startLine: 4,
        endLine: 6,
        signature: 'function fallback()',
      },
      'typescript',
    );
    expect(metrics).toEqual({
      line_count: 3,
      param_count: 0,
      cyclomatic: 1,
      max_nesting: 0,
    });
  });

  it('defaults to baseline complexity for unsupported languages', () => {
    const source = 'function hello(name) { if (name) return name; return "hi"; }';
    const tree = new ParserPool().parse('javascript', source);
    expect(tree).not.toBeNull();
    const extracted = new TypeScriptExtractor().extract(tree!, source, '/tmp/hello.js');
    const symbol = extracted.symbols[0];
    expect(symbol).toBeDefined();

    const metrics = computeSymbolMetrics(symbol!, 'unsupported-language');
    expect(metrics).toEqual({
      line_count: 1,
      param_count: 0,
      cyclomatic: 1,
      max_nesting: 0,
    });
  });
});
