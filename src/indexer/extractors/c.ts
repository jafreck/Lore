/**
 * @module indexer/extractors/c
 *
 * C language extractor.  Extracts:
 * - Function definitions, struct/enum/typedef declarations
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

const C_SYMBOL_NODE_TYPES = [
  'function_definition',
] as const;

/**
 * AST node types on the "function" child of a `call_expression` that indicate
 * the call goes through a level of indirection (pointer deref, field access,
 * subscript, etc.).
 */
const INDIRECT_CALL_NODE_TYPES = new Set([
  'pointer_expression',
  'parenthesized_expression',
  'subscript_expression',
]);

// ─── CExtractor ───────────────────────────────────────────────────────────────

export class CExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();
    /** Track macro names so the call-ref pass can classify invocations. */
    const macroNames = new Set<string>();

    // First pass: collect macro names.
    for (const node of walk(tree.rootNode)) {
      if (node.type === 'preproc_function_def' || node.type === 'preproc_def') {
        const sym = extractMacro(node);
        if (sym) macroNames.add(sym.name);
      }
    }

    // Main pass: symbols, imports, call-refs.
    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'struct_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractNamedSpecifier(node, 'struct'));
          }
          break;
        case 'enum_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractNamedSpecifier(node, 'enum'));
          }
          break;
        case 'typedef_declaration':
          result.symbols.push(extractTypedef(node));
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

/**
 * Walks down pointer/array declarators to find the function_declarator, then
 * extracts the innermost identifier.
 */
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
      return findFirst(inner, 'identifier')?.text ?? '';
    }
  }
  return findFirst(declarator, 'identifier')?.text ?? '';
}

function extractNamedSpecifier(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractTypedef(node: Parser.SyntaxNode): RawSymbol {
  const children = node.namedChildren;
  const nameNode = children[children.length - 1] ?? null;
  return {
    name: nameNode?.text ?? '',
    kind: 'typedef',
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

function extractCallRef(
  node: Parser.SyntaxNode,
  macroNames: Set<string>,
): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;

  const callerSymbol = findEnclosingSymbolName(node, C_SYMBOL_NODE_TYPES);
  const line = node.startPosition.row;
  const character = node.startPosition.column;

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

  // Field expression:  obj.method(...) / ptr->method(...)
  if (fnNode.type === 'field_expression') {
    return { calleeName: fnNode.text, isIndirect: false, callKind: 'direct' };
  }

  // Indirect calls through pointer deref, parens, or subscript:
  //   (*callback)(...)  /  (fnTable[i])(...)
  if (INDIRECT_CALL_NODE_TYPES.has(fnNode.type)) {
    const innerName = extractInnermostIdentifier(fnNode);
    return {
      calleeName: innerName ?? fnNode.text,
      isIndirect: true,
      callKind: 'indirect',
    };
  }

  // Fallback
  return { calleeName: fnNode.text, isIndirect: false, callKind: 'direct' };
}

/**
 * Walks into pointer/parenthesised/subscript wrappers to find the innermost
 * identifier being dereferenced.
 */
function extractInnermostIdentifier(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === 'identifier') return current.text;
    if (current.type === 'field_expression') return current.text;

    if (current.type === 'pointer_expression') {
      const arg: Parser.SyntaxNode | null = current.childForFieldName('argument') ?? current.namedChildren[current.namedChildren.length - 1] ?? null;
      if (arg && arg !== current) { current = arg; continue; }
    }
    if (current.type === 'parenthesized_expression') {
      const inner: Parser.SyntaxNode | null = current.namedChildren[0] ?? null;
      if (inner && inner !== current) { current = inner; continue; }
    }
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
    node.childForFieldName('path') ??
    node.namedChildren[0] ??
    null;
  const raw = pathNode?.text ?? '';
  const source = raw.replace(/^["<]|[">]$/g, '');
  return { source, importedNames: [] };
}
