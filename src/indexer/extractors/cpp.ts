/**
 * @module indexer/extractors/cpp
 *
 * C++ language extractor.  Extracts:
 * - Function definitions, class/struct declarations
 * - Preprocessor macro definitions (`preproc_function_def`, `preproc_def`)
 * - `#include` directives
 * - Call-expression references with function-pointer / indirect-call awareness
 */

import type Parser from 'tree-sitter';
import {
  type CallKind,
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawSymbol,
  type SymbolExtractor,
  emptyResult,
  findEnclosingSymbolName,
  findFirst,
  nodeSignature,
  walk,
} from './types.js';

const CPP_SYMBOL_NODE_TYPES = [
  'function_definition',
] as const;

/**
 * AST node types on the "function" child of a `call_expression` that indicate
 * the call goes through a level of indirection (pointer deref, field access,
 * subscript, etc.) rather than naming a function directly.
 */
const INDIRECT_CALL_NODE_TYPES = new Set([
  'pointer_expression',
  'parenthesized_expression',
  'subscript_expression',
]);

// ─── CppExtractor ─────────────────────────────────────────────────────────────

export class CppExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();
    /** Track macro names so we can tag call-refs that invoke them. */
    const macroNames = new Set<string>();

    // First pass: collect macro names so the call-ref pass can classify them.
    for (const node of walk(tree.rootNode)) {
      if (node.type === 'preproc_function_def' || node.type === 'preproc_def') {
        const sym = extractMacro(node);
        if (sym) {
          macroNames.add(sym.name);
        }
      }
    }

    // Main pass: symbols, imports, call-refs.
    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'class_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractSpecifier(node, 'class'));
          }
          break;
        case 'struct_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractSpecifier(node, 'struct'));
          }
          break;
        case 'preproc_function_def':
        case 'preproc_def': {
          const sym = extractMacro(node);
          if (sym) result.symbols.push(sym);
          break;
        }
        case 'preproc_include':
          result.imports.push(extractInclude(node));
          break;
        case 'call_expression': {
          const ref = extractCallRef(node, macroNames);
          if (ref) result.callRefs.push(ref);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFunction(node: Parser.SyntaxNode): RawSymbol {
  const declarator = node.childForFieldName('declarator');
  const name = declarator ? extractDeclaratorName(declarator) : '';
  return {
    name,
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractDeclaratorName(declarator: Parser.SyntaxNode): string {
  let node: Parser.SyntaxNode | null = declarator;
  while (node && node.type !== 'function_declarator') {
    const inner: Parser.SyntaxNode | null =
      node.childForFieldName('declarator') ??
      node.namedChildren[0] ??
      null;
    if (!inner || inner === node) break;
    node = inner;
  }
  if (node?.type === 'function_declarator') {
    const inner = node.childForFieldName('declarator');
    if (inner) {
      // Prefer qualified identifier (e.g. Foo::bar) over plain identifier
      return (
        findFirst(inner, 'qualified_identifier')?.text ??
        findFirst(inner, 'identifier')?.text ??
        ''
      );
    }
  }
  return findFirst(declarator, 'identifier')?.text ?? '';
}

function extractSpecifier(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

// ─── Macro extraction ─────────────────────────────────────────────────────────

/**
 * Extracts a `RawSymbol` with `kind: 'macro'` from `preproc_function_def`
 * (function-like macros) and `preproc_def` (object-like macros).
 */
function extractMacro(node: Parser.SyntaxNode): RawSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  return {
    name: nameNode.text,
    kind: 'macro',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: node.text.split('\n')[0]?.trim() ?? '',
  };
}

// ─── Call-ref extraction with indirection awareness ───────────────────────────

/**
 * Classifies and extracts a `RawCallRef` from a `call_expression` node.
 *
 * Classification logic:
 *  1. If the callee name matches a known macro → `callKind: 'macro'`.
 *  2. If the function child is an `identifier` or `qualified_identifier`
 *     (possibly behind a `field_expression`) → `callKind: 'direct'`.
 *  3. If the function child is a `pointer_expression`, `parenthesized_expression`,
 *     or `subscript_expression` → `callKind: 'indirect'`, `isIndirect: true`,
 *     with `calleeRaw` set to the innermost dereferenced identifier.
 */
function extractCallRef(
  node: Parser.SyntaxNode,
  macroNames: Set<string>,
): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;

  const callerSymbol = findEnclosingSymbolName(node, CPP_SYMBOL_NODE_TYPES);
  const line = node.startPosition.row;
  const character = node.startPosition.column;

  // Resolve the innermost callee name and determine indirection.
  const { calleeName, isIndirect, callKind } = classifyCallee(fnNode, macroNames);

  return {
    callerSymbol,
    calleeRaw: calleeName,
    line,
    character,
    callKind,
    isIndirect,
  };
}

/**
 * Walks the function-position subtree of a `call_expression` to extract the
 * callee name and classify the call kind.
 */
function classifyCallee(
  fnNode: Parser.SyntaxNode,
  macroNames: Set<string>,
): { calleeName: string; isIndirect: boolean; callKind: CallKind } {
  // Direct identifier:  foo(...)
  if (fnNode.type === 'identifier') {
    const name = fnNode.text;
    if (macroNames.has(name)) {
      return { calleeName: name, isIndirect: false, callKind: 'macro' };
    }
    return { calleeName: name, isIndirect: false, callKind: 'direct' };
  }

  // Qualified identifier:  std::sort(...)  /  Foo::bar(...)
  if (fnNode.type === 'qualified_identifier') {
    const name = fnNode.text;
    return { calleeName: name, isIndirect: false, callKind: 'direct' };
  }

  // Field expression:  obj.method(...)  /  ptr->method(...)
  if (fnNode.type === 'field_expression') {
    const fieldName = fnNode.childForFieldName('field')?.text ?? fnNode.text;
    return { calleeName: fnNode.text, isIndirect: false, callKind: 'direct' };
  }

  // Indirect calls through pointer deref, parens, or subscript:
  //   (*callback)(...)   /   (fnTable[i])(...)   /   (get_fn())(...)
  if (INDIRECT_CALL_NODE_TYPES.has(fnNode.type)) {
    const innerName = extractInnermostIdentifier(fnNode);
    return {
      calleeName: innerName ?? fnNode.text,
      isIndirect: true,
      callKind: 'indirect',
    };
  }

  // template_function:  std::invoke<>(...), etc.
  if (fnNode.type === 'template_function') {
    const nameChild = fnNode.childForFieldName('name');
    const name = nameChild?.text ?? fnNode.text;
    return { calleeName: name, isIndirect: false, callKind: 'direct' };
  }

  // Fallback: use the raw text and mark direct.
  return { calleeName: fnNode.text, isIndirect: false, callKind: 'direct' };
}

/**
 * Walks into pointer/parenthesised/subscript wrappers to find the innermost
 * identifier being dereferenced.
 *
 * Examples:
 *  - `(*callback)` → `callback`
 *  - `(fnTable[i])` → `fnTable`
 *  - `(*obj->fn_ptr)` → `obj->fn_ptr`
 */
function extractInnermostIdentifier(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === 'identifier') return current.text;
    if (current.type === 'qualified_identifier') return current.text;
    if (current.type === 'field_expression') {
      // Keep the full field expression (e.g. obj->fn_ptr)
      return current.text;
    }

    // pointer_expression: skip the `*` operator and look at the argument
    if (current.type === 'pointer_expression') {
      const arg: Parser.SyntaxNode | null = current.childForFieldName('argument') ?? current.namedChildren[current.namedChildren.length - 1] ?? null;
      if (arg && arg !== current) { current = arg; continue; }
    }
    // parenthesized_expression: unwrap the parens
    if (current.type === 'parenthesized_expression') {
      const inner: Parser.SyntaxNode | null = current.namedChildren[0] ?? null;
      if (inner && inner !== current) { current = inner; continue; }
    }
    // subscript_expression: take the argument (the array base)
    if (current.type === 'subscript_expression') {
      const arg: Parser.SyntaxNode | null = current.childForFieldName('argument') ?? current.namedChildren[0] ?? null;
      if (arg && arg !== current) { current = arg; continue; }
    }
    break;
  }
  return null;
}

function extractInclude(node: Parser.SyntaxNode): RawImport {
  const pathNode =
    node.childForFieldName('path') ?? node.namedChildren[0] ?? null;
  const raw = pathNode?.text ?? '';
  const source = raw.replace(/^["<]|[">]$/g, '');
  return { source, importedNames: [] };
}
