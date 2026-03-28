import type Parser from 'tree-sitter';
import { walk, type ComplexityNodeTypes, type RawSymbol } from './extractors/types.js';
import { TYPESCRIPT_COMPLEXITY_NODE_TYPES } from './extractors/typescript.js';

export interface SymbolMetrics {
  line_count: number;
  param_count: number;
  cyclomatic: number;
  max_nesting: number;
}

// ─── Python ───────────────────────────────────────────────────────────────────
const PYTHON_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['parameters'],
  parameterTypes: ['identifier', 'default_parameter', 'typed_parameter', 'typed_default_parameter', 'list_splat_pattern', 'dictionary_splat_pattern'],
  decisionTypes: [
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
    'boolean_operator',         // `and` / `or`
    'list_comprehension',
    'set_comprehension',
    'dictionary_comprehension',
    'generator_expression',
  ],
  nestingTypes: [
    'if_statement',
    'for_statement',
    'while_statement',
    'try_statement',
    'except_clause',
    'with_statement',
    'conditional_expression',
  ],
};

// ─── Java ─────────────────────────────────────────────────────────────────────
const JAVA_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['formal_parameters'],
  parameterTypes: ['formal_parameter', 'spread_parameter'],
  decisionTypes: [
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'switch_expression',
    'ternary_expression',
    'binary_expression',        // counted when operator is && or || (over-approximation; tree-sitter Java uses this node)
  ],
  nestingTypes: [
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'switch_expression',
    'switch_statement',
    'catch_clause',
    'ternary_expression',
  ],
};

// ─── Go ───────────────────────────────────────────────────────────────────────
const GO_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['parameter_list'],
  parameterTypes: ['parameter_declaration', 'variadic_parameter_declaration'],
  decisionTypes: [
    'if_statement',
    'for_statement',
    'expression_case',          // case in switch
    'default_case',
    'communication_case',       // case in select
    'select_statement',
  ],
  nestingTypes: [
    'if_statement',
    'for_statement',
    'select_statement',
    'expression_switch_statement',
    'type_switch_statement',
  ],
};

// ─── Rust ─────────────────────────────────────────────────────────────────────
const RUST_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['parameters'],
  parameterTypes: ['parameter', 'self_parameter'],
  decisionTypes: [
    'if_expression',
    'if_let_expression',
    'for_expression',
    'while_expression',
    'while_let_expression',
    'loop_expression',
    'match_arm',
    'closure_expression',
    'binary_expression',        // && / ||
  ],
  nestingTypes: [
    'if_expression',
    'if_let_expression',
    'for_expression',
    'while_expression',
    'while_let_expression',
    'loop_expression',
    'match_expression',
    'closure_expression',
  ],
};

// ─── C ────────────────────────────────────────────────────────────────────────
const C_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['parameter_list'],
  parameterTypes: ['parameter_declaration'],
  decisionTypes: [
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'case_statement',
    'conditional_expression',
    'binary_expression',        // && / ||
  ],
  nestingTypes: [
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'conditional_expression',
  ],
};

// ─── C++ ──────────────────────────────────────────────────────────────────────
const CPP_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  ...C_COMPLEXITY_NODE_TYPES,
  decisionTypes: [
    ...C_COMPLEXITY_NODE_TYPES.decisionTypes,
    'catch_clause',
  ],
  nestingTypes: [
    ...C_COMPLEXITY_NODE_TYPES.nestingTypes,
    'catch_clause',
    'try_statement',
  ],
};

// ─── C# ───────────────────────────────────────────────────────────────────────
const CSHARP_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['parameter_list'],
  parameterTypes: ['parameter'],
  decisionTypes: [
    'if_statement',
    'for_statement',
    'for_each_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'case_switch_label',
    'case_pattern_switch_label',
    'conditional_expression',
    'binary_expression',        // && / ||
  ],
  nestingTypes: [
    'if_statement',
    'for_statement',
    'for_each_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'switch_expression',
    'catch_clause',
    'conditional_expression',
  ],
};

// ─── Ruby ─────────────────────────────────────────────────────────────────────
const RUBY_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['method_parameters', 'block_parameters', 'lambda_parameters'],
  parameterTypes: ['identifier', 'optional_parameter', 'splat_parameter', 'hash_splat_parameter', 'block_parameter', 'keyword_parameter'],
  decisionTypes: [
    'if',
    'elsif',
    'unless',
    'for',
    'while',
    'until',
    'when',
    'rescue',
    'conditional',              // ternary
    'binary',                   // && / || / and / or
  ],
  nestingTypes: [
    'if',
    'unless',
    'for',
    'while',
    'until',
    'case',
    'rescue',
    'begin',
  ],
};

// ─── PHP ──────────────────────────────────────────────────────────────────────
const PHP_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['formal_parameters'],
  parameterTypes: ['simple_parameter', 'variadic_parameter', 'property_promotion_parameter'],
  decisionTypes: [
    'if_statement',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'case_statement',
    'conditional_expression',
    'binary_expression',        // && / ||
  ],
  nestingTypes: [
    'if_statement',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'catch_clause',
    'conditional_expression',
  ],
};

const COMPLEXITY_NODE_TYPES_BY_LANGUAGE: Record<string, ComplexityNodeTypes> = {
  typescript: TYPESCRIPT_COMPLEXITY_NODE_TYPES,
  javascript: TYPESCRIPT_COMPLEXITY_NODE_TYPES,
  python: PYTHON_COMPLEXITY_NODE_TYPES,
  java: JAVA_COMPLEXITY_NODE_TYPES,
  go: GO_COMPLEXITY_NODE_TYPES,
  rust: RUST_COMPLEXITY_NODE_TYPES,
  c: C_COMPLEXITY_NODE_TYPES,
  cpp: CPP_COMPLEXITY_NODE_TYPES,
  csharp: CSHARP_COMPLEXITY_NODE_TYPES,
  ruby: RUBY_COMPLEXITY_NODE_TYPES,
  php: PHP_COMPLEXITY_NODE_TYPES,
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
  // Java / C# / PHP
  'method_declaration',
  'constructor_declaration',
  // Go
  'function_declaration',   // already listed above, but explicit for clarity
  'method_declaration',
  'func_literal',
  // Rust
  'function_item',
  'impl_item',
  'trait_item',
  // Ruby
  'method',
  'singleton_method',
  // General
  'lambda_expression',
  'lambda',
  'closure_expression',
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
