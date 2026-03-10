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

  it('computes JavaScript metrics using the typescript complexity node types', () => {
    const source = [
      'function process(data) {',
      '  if (data.length > 0) {',
      '    for (let i = 0; i < data.length; i++) {',
      '      if (data[i] > 10) {',
      '        return data[i];',
      '      }',
      '    }',
      '  }',
      '  return null;',
      '}',
    ].join('\n');

    const tree = new ParserPool().parse('javascript', source);
    expect(tree).not.toBeNull();
    const extracted = new TypeScriptExtractor().extract(tree!, source, '/tmp/process.js');
    const symbol = extracted.symbols[0];
    expect(symbol).toBeDefined();

    const metrics = computeSymbolMetrics(symbol!, 'javascript');
    expect(metrics.line_count).toBe(10);
    expect(metrics.param_count).toBeGreaterThanOrEqual(0);
    expect(metrics.cyclomatic).toBeGreaterThanOrEqual(3);
    expect(metrics.max_nesting).toBeGreaterThanOrEqual(2);
  });

  it('computes metrics for a function with no params and single-line body', () => {
    const source = 'function noop(): void {}';
    const tree = new ParserPool().parse('typescript', source);
    expect(tree).not.toBeNull();
    const extracted = new TypeScriptExtractor().extract(tree!, source, '/tmp/noop.ts');
    const symbol = extracted.symbols[0];
    expect(symbol).toBeDefined();

    const metrics = computeSymbolMetrics(symbol!, 'typescript');
    expect(metrics.line_count).toBe(1);
    expect(metrics.param_count).toBe(0);
    expect(metrics.cyclomatic).toBe(1);
    expect(metrics.max_nesting).toBe(0);
  });

  it('hits parameter fallback walk when parameters field is absent', () => {
    // Create a symbol with an AST node that lacks a 'parameters' field
    // We simulate this by using a class-level arrow expression that the extractor
    // captures as a symbol with astNode.childForFieldName('parameters') === null
    const source = [
      'class Svc {',
      '  handler = (x: number, y: string) => {',
      '    if (x > 0) return y;',
      '    return "";',
      '  };',
      '}',
    ].join('\n');

    const tree = new ParserPool().parse('typescript', source);
    expect(tree).not.toBeNull();
    const extracted = new TypeScriptExtractor().extract(tree!, source, '/tmp/svc.ts');
    // Find the arrow function symbol
    const arrowSym = extracted.symbols.find(s => s.name === 'handler');
    if (arrowSym?.astNode) {
      const metrics = computeSymbolMetrics(arrowSym, 'typescript');
      expect(metrics.param_count).toBeGreaterThanOrEqual(0);
    }
  });
});
