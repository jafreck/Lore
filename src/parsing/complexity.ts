import type Parser from 'tree-sitter';
import { walk, type ComplexityNodeTypes, type RawSymbol } from './extractors/types.js';
import { TYPESCRIPT_COMPLEXITY_NODE_TYPES } from './extractors/typescript.js';

export interface SymbolMetrics {
  line_count: number;
  param_count: number;
  cyclomatic: number;
  max_nesting: number;
}

const COMPLEXITY_NODE_TYPES_BY_LANGUAGE: Record<string, ComplexityNodeTypes> = {
  typescript: TYPESCRIPT_COMPLEXITY_NODE_TYPES,
  javascript: TYPESCRIPT_COMPLEXITY_NODE_TYPES,
};

/**
 * Node types that introduce a new scope boundary.
 * When computing complexity for a symbol, we skip the bodies of
 * these node types to avoid counting nested function complexity
 * in the parent scope.
 */
const SCOPE_BOUNDARY_TYPES = new Set([
  // TypeScript / JavaScript
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
  'arrow_function',
  'method_definition',
  'class_declaration',
  'class_expression',
  // Python
  'function_definition',
  'class_definition',
  // General
  'lambda_expression',
  'lambda',
]);

export function computeSymbolMetrics(symbol: RawSymbol, language: string): SymbolMetrics {
  const line_count = Math.max(1, symbol.endLine - symbol.startLine + 1);
  const astNode = symbol.astNode;
  if (!astNode) {
    return {
      line_count,
      param_count: 0,
      cyclomatic: 1,
      max_nesting: 0,
    };
  }

  const nodeTypes = COMPLEXITY_NODE_TYPES_BY_LANGUAGE[language];
  if (!nodeTypes) {
    return {
      line_count,
      param_count: 0,
      cyclomatic: 1,
      max_nesting: 0,
    };
  }

  const decisionCount = countByType(astNode, new Set(nodeTypes.decisionTypes), SCOPE_BOUNDARY_TYPES);
  return {
    line_count,
    param_count: countParameters(astNode, nodeTypes),
    cyclomatic: decisionCount + 1,
    max_nesting: computeMaxNesting(astNode, new Set(nodeTypes.nestingTypes)),
  };
}

function countParameters(node: Parser.SyntaxNode, nodeTypes: ComplexityNodeTypes): number {
  const explicitParams = node.childForFieldName('parameters');
  if (explicitParams) {
    return countByType(explicitParams, new Set(nodeTypes.parameterTypes));
  }

  for (const candidate of walk(node)) {
    if (nodeTypes.parameterListTypes.includes(candidate.type)) {
      return countByType(candidate, new Set(nodeTypes.parameterTypes));
    }
  }
  return 0;
}

function countByType(
  node: Parser.SyntaxNode,
  targetTypes: Set<string>,
  scopeBoundaryTypes?: Set<string>,
): number {
  let count = 0;
  for (const current of walkSkippingNestedScopes(node, scopeBoundaryTypes)) {
    if (targetTypes.has(current.type)) count += 1;
  }
  return count;
}

/**
 * Depth-first walk that skips the subtrees of nested scope boundaries.
 * The root node is always traversed even if it matches a scope boundary type.
 */
function* walkSkippingNestedScopes(
  root: Parser.SyntaxNode,
  scopeBoundaryTypes?: Set<string>,
): Generator<Parser.SyntaxNode> {
  function* visit(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
    yield node;
    for (const child of node.children) {
      if (scopeBoundaryTypes && child !== root && scopeBoundaryTypes.has(child.type)) {
        continue;
      }
      yield* visit(child);
    }
  }
  yield* visit(root);
}

function computeMaxNesting(node: Parser.SyntaxNode, nestingTypes: Set<string>): number {
  const visit = (current: Parser.SyntaxNode, depth: number): number => {
    const nextDepth = nestingTypes.has(current.type) ? depth + 1 : depth;
    let maxDepth = nextDepth;
    for (const child of current.namedChildren) {
      if (child !== node && SCOPE_BOUNDARY_TYPES.has(child.type)) {
        continue;
      }
      maxDepth = Math.max(maxDepth, visit(child, nextDepth));
    }
    return maxDepth;
  };

  return Math.max(0, visit(node, 0));
}
