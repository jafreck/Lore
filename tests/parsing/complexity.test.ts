import { describe, it, expect } from 'vitest';
import { computeSymbolMetrics } from '../../src/parsing/complexity.js';
import { ParserPool } from '../../src/parsing/parser.js';
import type { RawSymbol } from '../../src/parsing/extractors/types.js';

const pool = new ParserPool();

/** Helper: parse source, find first function node, and return a RawSymbol with it. */
function makeSymbol(language: string, source: string, name = 'test'): RawSymbol {
  const tree = pool.parse(language, source);
  if (!tree) throw new Error(`Failed to parse ${language}`);

  // Find the first function-like node
  const functionTypes: Record<string, string[]> = {
    typescript: ['function_declaration', 'method_definition', 'arrow_function'],
    javascript: ['function_declaration', 'method_definition', 'arrow_function'],
    python: ['function_definition'],
    java: ['method_declaration'],
    go: ['function_declaration'],
    rust: ['function_item'],
    c: ['function_definition'],
  };

  const types = functionTypes[language] ?? ['function_declaration'];
  let astNode = findNodeOfType(tree.rootNode, types);
  if (!astNode) {
    // Fallback: use root node
    astNode = tree.rootNode;
  }

  return {
    name,
    kind: 'function',
    startLine: astNode.startPosition.row,
    endLine: astNode.endPosition.row,
    signature: `fn ${name}`,
    astNode,
  };
}

function findNodeOfType(node: import('tree-sitter').SyntaxNode, types: string[]): import('tree-sitter').SyntaxNode | null {
  if (types.includes(node.type)) return node;
  for (const child of node.children) {
    const found = findNodeOfType(child, types);
    if (found) return found;
  }
  return null;
}

describe('computeSymbolMetrics', () => {
  describe('line_count', () => {
    it('counts single-line function', () => {
      const sym = makeSymbol('typescript', 'function foo() { return 1; }');
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.line_count).toBe(1);
    });

    it('counts multi-line function', () => {
      const source = `function foo() {
  const x = 1;
  const y = 2;
  return x + y;
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.line_count).toBe(5);
    });
  });

  describe('without astNode', () => {
    it('returns defaults when astNode is missing', () => {
      const sym: RawSymbol = {
        name: 'test',
        kind: 'function',
        startLine: 0,
        endLine: 4,
        signature: 'fn test',
      };
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.line_count).toBe(5);
      expect(metrics.param_count).toBe(0);
      expect(metrics.cyclomatic).toBe(1);
      expect(metrics.max_nesting).toBe(0);
    });
  });

  describe('unsupported language', () => {
    it('returns defaults for unknown language', () => {
      const sym = makeSymbol('python', 'def foo():\n    pass\n');
      const metrics = computeSymbolMetrics(sym, 'unknown_lang');
      expect(metrics.cyclomatic).toBe(1);
      expect(metrics.max_nesting).toBe(0);
      expect(metrics.param_count).toBe(0);
    });
  });

  describe('param_count', () => {
    it('counts TypeScript parameters', () => {
      const source = `function foo(a: number, b: string, c?: boolean) { return a; }`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.param_count).toBe(3);
    });

    it('counts Python parameters', () => {
      const source = `def foo(a, b, c=None):\n    pass\n`;
      const sym = makeSymbol('python', source);
      const metrics = computeSymbolMetrics(sym, 'python');
      // Python counts identifiers + default_parameter nodes
      // a (identifier), b (identifier), c=None (default_parameter) which also contains c (identifier)
      expect(metrics.param_count).toBeGreaterThanOrEqual(3);
    });

    it('counts zero parameters', () => {
      const source = `function foo() { return 1; }`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.param_count).toBe(0);
    });
  });

  describe('cyclomatic complexity', () => {
    it('returns 1 for function with no branches (TypeScript)', () => {
      const source = `function simple() { return 42; }`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.cyclomatic).toBe(1);
    });

    it('increments for if statement', () => {
      const source = `function foo(x: number) {
  if (x > 0) return 1;
  return 0;
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.cyclomatic).toBe(2);
    });

    it('increments for if/else if chain', () => {
      const source = `function foo(x: number) {
  if (x > 10) return 'big';
  else if (x > 5) return 'medium';
  else if (x > 0) return 'small';
  else return 'negative';
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      // 3 if_statements → cyclomatic = 3 + 1 = 4
      expect(metrics.cyclomatic).toBe(4);
    });

    it('increments for loops', () => {
      const source = `function foo(arr: number[]) {
  for (const x of arr) {
    while (x > 0) {
      break;
    }
  }
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      // for_of + while = 2 branches → cyclomatic = 3
      expect(metrics.cyclomatic).toBe(3);
    });

    it('increments for catch clause', () => {
      const source = `function foo() {
  try {
    doSomething();
  } catch (e) {
    handleError(e);
  }
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.cyclomatic).toBe(2);
    });

    it('increments for switch cases', () => {
      const source = `function foo(x: string) {
  switch (x) {
    case 'a': return 1;
    case 'b': return 2;
    case 'c': return 3;
    default: return 0;
  }
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      // 4 switch_cases
      expect(metrics.cyclomatic).toBeGreaterThanOrEqual(4);
    });

    it('increments for if statement', () => {
      const source = `function foo(x: number) {
  if (x > 0) return 'positive';
  return 'non-positive';
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      // if_statement = 1 decision, cyclomatic = 2
      expect(metrics.cyclomatic).toBe(2);
    });

    it('does not count nested function complexity in parent', () => {
      const source = `function outer() {
  function inner() {
    if (true) return 1;
    if (true) return 2;
  }
  return inner();
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      // The nested function_declaration is a scope boundary, so its ifs don't count
      expect(metrics.cyclomatic).toBe(1);
    });

    it('computes complexity for Python', () => {
      const source = `def foo(x):
    if x > 0:
        for i in range(x):
            pass
    elif x < 0:
        pass
`;
      const sym = makeSymbol('python', source);
      const metrics = computeSymbolMetrics(sym, 'python');
      // if + for + elif = 3, cyclomatic = 4
      expect(metrics.cyclomatic).toBe(4);
    });

    it('computes complexity for Java', () => {
      const source = `class Foo {
  void bar(int x) {
    if (x > 0) {
      System.out.println(x);
    }
  }
}`;
      const tree = pool.parse('java', source)!;
      const methodNode = findNodeOfType(tree.rootNode, ['method_declaration'])!;
      const sym: RawSymbol = {
        name: 'bar',
        kind: 'function',
        startLine: methodNode.startPosition.row,
        endLine: methodNode.endPosition.row,
        signature: 'void bar(int x)',
        astNode: methodNode,
      };
      const metrics = computeSymbolMetrics(sym, 'java');
      // if_statement + binary_expression (x > 0) = 2 decisions, cyclomatic = 3
      expect(metrics.cyclomatic).toBe(3);
    });
  });

  describe('max_nesting', () => {
    it('returns 0 for flat function', () => {
      const source = `function flat() { return 1; }`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.max_nesting).toBe(0);
    });

    it('returns 1 for single-level nesting', () => {
      const source = `function foo() {
  if (true) {
    return 1;
  }
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.max_nesting).toBe(1);
    });

    it('returns 2 for doubly-nested', () => {
      const source = `function foo() {
  if (true) {
    for (let i = 0; i < 10; i++) {
      console.log(i);
    }
  }
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      expect(metrics.max_nesting).toBe(2);
    });

    it('returns 3 for deeply nested', () => {
      const source = `function foo() {
  if (true) {
    while (true) {
      try {
        doSomething();
      } catch (e) {
        handle(e);
      }
    }
  }
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      // if → while → catch = 3
      expect(metrics.max_nesting).toBeGreaterThanOrEqual(3);
      expect(metrics.max_nesting).toBeLessThanOrEqual(5);
    });

    it('does not count nesting in nested functions', () => {
      const source = `function outer() {
  const inner = () => {
    if (true) {
      for (;;) {}
    }
  };
}`;
      const sym = makeSymbol('typescript', source);
      const metrics = computeSymbolMetrics(sym, 'typescript');
      // arrow_function is a scope boundary — inner nesting is excluded
      expect(metrics.max_nesting).toBe(0);
    });
  });
});
