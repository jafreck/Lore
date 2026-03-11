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
  type RawTypeRef,
  type TypeRefKind,
  type SymbolExtractor,
  emptyResult,
  findEnclosingSymbolName,
  findFirst,
  nodeSignature,
  walk,
} from './types.js';

const C_SYMBOL_NODE_TYPES = [
  'function_definition',
  'struct_specifier',
  'enum_specifier',
  'preproc_function_def',
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

    // Main pass: symbols, imports, call-refs, type-refs.
    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          extractFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'struct_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractNamedSpecifier(node, 'struct'));
            extractStructFieldTypeRefs(node, result.typeRefs);
          }
          break;
        case 'enum_specifier':
          if (node.childForFieldName('name')) {
            result.symbols.push(extractNamedSpecifier(node, 'enum'));
          }
          break;
        case 'typedef_declaration':
        case 'type_definition':
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
        case 'declaration': {
          const funcDecl = extractFunctionDeclaration(node);
          if (funcDecl) {
            result.symbols.push(funcDecl);
            extractDeclarationTypeRefs(node, result.typeRefs);
          } else {
            extractVariableTypeRefs(node, result.typeRefs);
          }
          break;
        }
        case 'sizeof_expression': {
          extractSizeofTypeRef(node, result.typeRefs);
          break;
        }
        case 'cast_expression': {
          extractCastTypeRef(node, result.typeRefs);
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
    if (!inner) break;
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
  const lastChild = children[children.length - 1] ?? null;
  // For simple typedefs the last child is a type_identifier with the alias name.
  // For function-pointer typedefs (e.g. `typedef int (*Fn)(int)`) the last
  // child is a function_declarator — dig for the innermost type_identifier.
  const name = lastChild
    ? (lastChild.type === 'type_identifier'
        ? lastChild.text
        : findFirst(lastChild, 'type_identifier')?.text ?? lastChild.text)
    : '';
  return {
    name,
    kind: 'typedef',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

// ─── Function declaration extraction (prototypes in headers) ──────────────────

/**
 * Checks whether a `declaration` node contains a function declarator (i.e. a
 * function prototype / forward declaration) and, if so, extracts it as a
 * `RawSymbol`.  Returns `null` when the declaration is a plain variable.
 */
function extractFunctionDeclaration(node: Parser.SyntaxNode): RawSymbol | null {
  // A function declaration looks like:
  //   type_specifier function_declarator(params);
  // The function_declarator is nested inside the declarator field.
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;
  if (!hasFunctionDeclarator(declarator)) return null;

  const name = extractDeclaratorName(declarator);
  if (!name) return null;

  return {
    name,
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

/** Recursively checks if a node contains a `function_declarator` child. */
function hasFunctionDeclarator(node: Parser.SyntaxNode): boolean {
  if (node.type === 'function_declarator') return true;
  for (const child of node.namedChildren) {
    if (hasFunctionDeclarator(child)) return true;
  }
  return false;
}

/**
 * Extracts type-refs from a function declaration (prototype) — return type +
 * parameter types.
 */
function extractDeclarationTypeRefs(
  declNode: Parser.SyntaxNode,
  refs: RawTypeRef[],
): void {
  const declarator = declNode.childForFieldName('declarator');
  if (!declarator) return;
  const funcName = extractDeclaratorName(declarator);

  // Return type
  const typeNode = declNode.childForFieldName('type');
  if (typeNode) {
    const typeName = extractCTypeName(typeNode);
    if (typeName) {
      emitTypeRef(refs, funcName, typeName, 'return', typeNode.startPosition.row, typeNode.startPosition.column);
    }
  }

  // Parameter types
  const funcDecl = findFunctionDeclarator(declarator);
  if (funcDecl) {
    const params = funcDecl.childForFieldName('parameters');
    if (params) {
      for (const param of params.namedChildren) {
        if (param.type === 'parameter_declaration') {
          const paramType = param.childForFieldName('type');
          if (paramType) {
            const typeName = extractCTypeName(paramType);
            if (typeName) {
              emitTypeRef(refs, funcName, typeName, 'parameter', paramType.startPosition.row, paramType.startPosition.column);
            }
          }
        }
      }
    }
  }
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
      if (arg) { current = arg; continue; }
    }
    if (current.type === 'parenthesized_expression') {
      const inner: Parser.SyntaxNode | null = current.namedChildren[0] ?? null;
      if (inner) { current = inner; continue; }
    }
    if (current.type === 'subscript_expression') {
      const arg: Parser.SyntaxNode | null = current.childForFieldName('argument') ?? current.namedChildren[0] ?? null;
      if (arg) { current = arg; continue; }
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

// ─── Type-ref extraction ──────────────────────────────────────────────────────

/**
 * Extracts a type name from a C type node.  Returns the text of the first
 * `type_identifier`, `struct_specifier`, `enum_specifier`, or `sized_type_specifier`
 * found within the node.
 */
function extractCTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'struct_specifier' || typeNode.type === 'enum_specifier') {
    const nameNode = typeNode.childForFieldName('name');
    if (nameNode && !typeNode.childForFieldName('body')) return nameNode.text;
    return null; // definition context, not a reference
  }
  if (typeNode.type === 'sized_type_specifier') return typeNode.text;
  // Walk children
  for (const child of typeNode.namedChildren) {
    const name = extractCTypeName(child);
    if (name) return name;
  }
  return null;
}

function emitTypeRef(
  refs: RawTypeRef[],
  enclosingSymbol: string,
  typeRaw: string,
  refKind: TypeRefKind,
  line: number,
  character?: number,
): void {
  refs.push({ enclosingSymbol, typeRaw, refKind, line, character });
}

function extractFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = extractDeclaratorName(funcNode.childForFieldName('declarator') ?? funcNode);
  // Return type
  const typeNode = funcNode.childForFieldName('type');
  if (typeNode) {
    const typeName = extractCTypeName(typeNode);
    if (typeName) {
      emitTypeRef(refs, funcName, typeName, 'return', typeNode.startPosition.row, typeNode.startPosition.column);
    }
  }
  // Parameters
  const declarator = funcNode.childForFieldName('declarator');
  if (declarator) {
    const funcDeclarator = findFunctionDeclarator(declarator);
    if (funcDeclarator) {
      const params = funcDeclarator.childForFieldName('parameters');
      if (params) {
        for (const param of params.namedChildren) {
          if (param.type === 'parameter_declaration') {
            const paramType = param.childForFieldName('type');
            if (paramType) {
              const typeName = extractCTypeName(paramType);
              if (typeName) {
                emitTypeRef(refs, funcName, typeName, 'parameter', paramType.startPosition.row, paramType.startPosition.column);
              }
            }
          }
        }
      }
    }
  }
}

function findFunctionDeclarator(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'function_declarator') return node;
  for (const child of node.namedChildren) {
    const found = findFunctionDeclarator(child);
    if (found) return found;
  }
  return null;
}

function extractStructFieldTypeRefs(structNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const structName = structNode.childForFieldName('name')?.text ?? '';
  const body = structNode.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) {
        const typeName = extractCTypeName(typeNode);
        if (typeName) {
          emitTypeRef(refs, structName, typeName, 'field', typeNode.startPosition.row, typeNode.startPosition.column);
        }
      }
    }
  }
}

function extractVariableTypeRefs(declNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // Skip if inside a function_definition (those are handled by extractFunctionTypeRefs)
  const typeNode = declNode.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractCTypeName(typeNode);
  if (!typeName) return;
  const enclosing = findEnclosingSymbolName(declNode, C_SYMBOL_NODE_TYPES);
  emitTypeRef(refs, enclosing, typeName, 'variable', typeNode.startPosition.row, typeNode.startPosition.column);
}

function extractSizeofTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // sizeof(Type) — the type argument is typically a type_descriptor or parenthesized type
  const valueNode = node.childForFieldName('value') ?? node.childForFieldName('type');
  if (valueNode) {
    const typeName = extractCTypeName(valueNode);
    if (typeName) {
      const enclosing = findEnclosingSymbolName(node, C_SYMBOL_NODE_TYPES);
      emitTypeRef(refs, enclosing, typeName, 'sizeof', valueNode.startPosition.row, valueNode.startPosition.column);
    }
  }
}

function extractCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const typeNode = node.childForFieldName('type');
  if (typeNode) {
    const typeName = extractCTypeName(typeNode);
    if (typeName) {
      const enclosing = findEnclosingSymbolName(node, C_SYMBOL_NODE_TYPES);
      emitTypeRef(refs, enclosing, typeName, 'cast', typeNode.startPosition.row, typeNode.startPosition.column);
    }
  }
}
