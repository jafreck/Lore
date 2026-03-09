/**
 * @module indexer/extractors/go
 *
 * P2/P3 Go language extractor.  Extracts function declarations, method
 * declarations, type declarations (struct/interface), and import declarations.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawRelationship,
  type RawRoute,
  type RawSymbol,
  type RawTypeRef,
  type TypeRefKind,
  type SymbolExtractor,
  emptyResult,
  extractGenericTypeArgs,
  findEnclosingSymbolName,
  findFirst,
  nodeSignature,
  walk,
} from './types.js';

const GO_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'method_declaration',
] as const;

// ─── GoExtractor ──────────────────────────────────────────────────────────────

export class GoExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
          result.symbols.push(extractFunction(node, 'function'));
          extractGoFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'method_declaration':
          result.symbols.push(extractMethod(node));
          extractGoMethodTypeRefs(node, result.typeRefs);
          break;
        case 'type_declaration':
          result.symbols.push(...extractTypeDecl(node));
          extractGoTypeDeclRefs(node, result.typeRefs, result.relationships);
          break;
        case 'import_declaration':
          result.imports.push(...extractImportDecl(node));
          break;
        case 'call_expression': {
          const route = maybeExtractGinRoute(node);
          if (route) result.routes.push(route);
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'short_var_declaration':
        case 'var_declaration': {
          extractGoVarTypeRefs(node, result.typeRefs);
          break;
        }
        case 'type_assertion_expression': {
          extractGoTypeAssertionRef(node, result.typeRefs);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFunction(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractMethod(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name');
  const receiverNode = node.childForFieldName('receiver');
  // Build a qualified name: (ReceiverType).MethodName
  let name = nameNode?.text ?? '';
  if (receiverNode) {
    const receiverType =
      findFirst(receiverNode, 'type_identifier')?.text ??
      findFirst(receiverNode, 'pointer_type')?.text;
    if (receiverType) name = `${receiverType}.${name}`;
  }
  return {
    name,
    kind: 'method',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

/**
 * A `type_declaration` may contain one or more `type_spec` children.
 * Each spec has a `name` field and a `type` field (struct_type, interface_type, etc.).
 */
function extractTypeDecl(node: Parser.SyntaxNode): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'type_spec') continue;
    const nameNode = child.childForFieldName('name');
    const typeNode = child.childForFieldName('type');
    let kind = 'type';
    if (typeNode?.type === 'struct_type') kind = 'struct';
    else if (typeNode?.type === 'interface_type') kind = 'interface';
    symbols.push({
      name: nameNode?.text ?? '',
      kind,
      startLine: child.startPosition.row,
      endLine: child.endPosition.row,
      signature: nodeSignature(child),
    });
  }
  return symbols;
}

/**
 * Handles both single imports and grouped imports:
 *   import "fmt"
 *   import ( "fmt"; alias "os" )
 */
function extractImportDecl(node: Parser.SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (const child of node.namedChildren) {
    if (child.type === 'import_spec') {
      imports.push(extractImportSpec(child));
    } else if (child.type === 'import_spec_list') {
      for (const spec of child.namedChildren) {
        if (spec.type === 'import_spec') {
          imports.push(extractImportSpec(spec));
        }
      }
    }
  }

  return imports;
}

function extractImportSpec(spec: Parser.SyntaxNode): RawImport {
  const pathNode = spec.childForFieldName('path');
  // Strip surrounding quotes from the path string literal
  const raw = pathNode?.text ?? '';
  const source = raw.replace(/^"|"$/g, '');
  const aliasNode = spec.childForFieldName('name');
  const importedNames = aliasNode ? [aliasNode.text] : [];
  return { source, importedNames };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, GO_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

const GO_GIN_METHODS: Record<string, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH',
  OPTIONS: 'OPTIONS',
  HEAD: 'HEAD',
  Any: 'ALL',
};

function maybeExtractGinRoute(node: Parser.SyntaxNode): RawRoute | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode || fnNode.type !== 'selector_expression') return null;
  const methodNode = fnNode.childForFieldName('field');
  const method = methodNode ? GO_GIN_METHODS[methodNode.text] : undefined;
  if (!method) return null;

  const argsNode = node.childForFieldName('arguments');
  const pathNode = argsNode?.namedChildren[0];
  const handlerNode = argsNode?.namedChildren[1];
  if (!pathNode || !handlerNode) return null;
  if (
    pathNode.type !== 'interpreted_string_literal' &&
    pathNode.type !== 'raw_string_literal'
  ) {
    return null;
  }

  return {
    method,
    path: pathNode.text.replace(/^`|`$|^"|"$/g, ''),
    handler: handlerNode.text,
    framework: 'gin',
    line: node.startPosition.row,
  };
}

// ─── Type-ref extraction ──────────────────────────────────────────────────────

function extractGoTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'qualified_type') return typeNode.text;
  if (typeNode.type === 'pointer_type') {
    const inner = typeNode.namedChildren[0];
    return inner ? extractGoTypeName(inner) : null;
  }
  if (typeNode.type === 'slice_type' || typeNode.type === 'array_type') {
    const element = typeNode.childForFieldName('element') ?? typeNode.namedChildren[0];
    return element ? extractGoTypeName(element) : null;
  }
  if (typeNode.type === 'map_type') {
    // For map_type, we return null here; key/value are extracted separately in emitGoTypeRef
    return null;
  }
  return null;
}

function emitGoTypeRef(refs: RawTypeRef[], enclosing: string, typeNode: Parser.SyntaxNode, refKind: TypeRefKind): void {
  // Handle map_type specially — emit refs for both key and value types
  if (typeNode.type === 'map_type') {
    const keyNode = typeNode.childForFieldName('key');
    const valueNode = typeNode.childForFieldName('value');
    if (keyNode) emitGoTypeRef(refs, enclosing, keyNode, refKind);
    if (valueNode) emitGoTypeRef(refs, enclosing, valueNode, refKind);
    return;
  }
  const typeName = extractGoTypeName(typeNode);
  if (!typeName) return;
  refs.push({ enclosingSymbol: enclosing, typeRaw: typeName, refKind, line: typeNode.startPosition.row, character: typeNode.startPosition.column });
  // Decompose generic args one level (Go 1.18+ type parameters)
  const genericArgs = extractGenericTypeArgs(typeNode, 'generic_type', 'type_arguments');
  for (const arg of genericArgs) {
    refs.push({ enclosingSymbol: enclosing, typeRaw: arg, refKind: 'generic_arg', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
  }
}

function extractGoFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = funcNode.childForFieldName('name')?.text ?? '';
  const params = funcNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'parameter_declaration') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) emitGoTypeRef(refs, funcName, typeNode, 'parameter');
      }
    }
  }
  const result = funcNode.childForFieldName('result');
  if (result) {
    if (result.type === 'parameter_list') {
      for (const param of result.namedChildren) {
        if (param.type === 'parameter_declaration') {
          const typeNode = param.childForFieldName('type');
          if (typeNode) emitGoTypeRef(refs, funcName, typeNode, 'return');
        }
      }
    } else {
      emitGoTypeRef(refs, funcName, result, 'return');
    }
  }
}

function extractGoMethodTypeRefs(methodNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const nameNode = methodNode.childForFieldName('name');
  const receiverNode = methodNode.childForFieldName('receiver');
  let funcName = nameNode?.text ?? '';
  if (receiverNode) {
    const receiverType = findFirst(receiverNode, 'type_identifier')?.text ?? findFirst(receiverNode, 'pointer_type')?.text;
    if (receiverType) funcName = `${receiverType}.${funcName}`;
  }
  const params = methodNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'parameter_declaration') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) emitGoTypeRef(refs, funcName, typeNode, 'parameter');
      }
    }
  }
  const result = methodNode.childForFieldName('result');
  if (result) {
    if (result.type === 'parameter_list') {
      for (const param of result.namedChildren) {
        if (param.type === 'parameter_declaration') {
          const typeNode = param.childForFieldName('type');
          if (typeNode) emitGoTypeRef(refs, funcName, typeNode, 'return');
        }
      }
    } else {
      emitGoTypeRef(refs, funcName, result, 'return');
    }
  }
}

function extractGoTypeDeclRefs(
  typeDeclNode: Parser.SyntaxNode,
  refs: RawTypeRef[],
  relationships: RawRelationship[],
): void {
  for (const spec of typeDeclNode.namedChildren) {
    if (spec.type !== 'type_spec') continue;
    const name = spec.childForFieldName('name')?.text ?? '';
    const typeNode = spec.childForFieldName('type');
    if (!typeNode) continue;
    // Interface embedding + method signatures
    if (typeNode.type === 'interface_type') {
      for (const child of typeNode.namedChildren) {
        // Embedded interfaces appear as type identifiers directly in the interface body
        if (child.type === 'type_identifier' || child.type === 'qualified_type') {
          relationships.push({ kind: 'extends', fromSymbol: name, toSymbol: child.text, line: child.startPosition.row, character: child.startPosition.column });
          refs.push({ enclosingSymbol: name, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
        }
        // Interface method signatures: extract parameter and return type refs
        if (child.type === 'method_spec') {
          const methodName = child.childForFieldName('name')?.text;
          const enclosing = methodName ? `${name}.${methodName}` : name;
          const params = child.childForFieldName('parameters');
          if (params) {
            for (const param of params.namedChildren) {
              if (param.type === 'parameter_declaration') {
                const paramType = param.childForFieldName('type');
                if (paramType) emitGoTypeRef(refs, enclosing, paramType, 'parameter');
              }
            }
          }
          const result = child.childForFieldName('result');
          if (result) {
            if (result.type === 'parameter_list') {
              for (const param of result.namedChildren) {
                if (param.type === 'parameter_declaration') {
                  const paramType = param.childForFieldName('type');
                  if (paramType) emitGoTypeRef(refs, enclosing, paramType, 'return');
                }
              }
            } else {
              emitGoTypeRef(refs, enclosing, result, 'return');
            }
          }
        }
      }
    }
    // Struct fields
    if (typeNode.type === 'struct_type') {
      for (const child of typeNode.namedChildren) {
        if (child.type === 'field_declaration_list') {
          for (const field of child.namedChildren) {
            if (field.type === 'field_declaration') {
              const fieldType = field.childForFieldName('type');
              if (fieldType) emitGoTypeRef(refs, name, fieldType, 'field');
            }
          }
        }
      }
    }
  }
}

function extractGoVarTypeRefs(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const enclosing = findEnclosingSymbolName(node, GO_SYMBOL_NODE_TYPES);
  if (node.type === 'var_declaration') {
    // var x Type = ... or var ( x Type; y Type )
    for (const child of node.namedChildren) {
      if (child.type === 'var_spec') {
        const typeNode = child.childForFieldName('type');
        if (typeNode) emitGoTypeRef(refs, enclosing, typeNode, 'variable');
      }
    }
  }
  // short_var_declaration has no explicit type annotation — skip
}

function extractGoTypeAssertionRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // x.(Type) — type assertion
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, GO_SYMBOL_NODE_TYPES);
  emitGoTypeRef(refs, enclosing, typeNode, 'cast');
}