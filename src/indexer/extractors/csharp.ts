/**
 * @module indexer/extractors/csharp
 *
 * P2/P3 C# language extractor.  Extracts class declarations, interface
 * declarations, method declarations, and using directives.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawRelationship,
  type RawSymbol,
  type RawTypeRef,
  type TypeRefKind,
  type SymbolExtractor,
  emptyResult,
  extractGenericTypeArgs,
  findEnclosingSymbolName,
  nodeSignature,
  walk,
} from './types.js';

const CS_SYMBOL_NODE_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'class_declaration',
] as const;

// ─── CSharpExtractor ──────────────────────────────────────────────────────────

export class CSharpExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          extractCsBaseListRelationships(node, 'class', result.relationships, result.typeRefs);
          extractCsFieldTypeRefs(node, result.typeRefs);
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          extractCsBaseListRelationships(node, 'interface', result.relationships, result.typeRefs);
          break;
        case 'struct_declaration':
          result.symbols.push(extractNamedNode(node, 'struct'));
          extractCsBaseListRelationships(node, 'struct', result.relationships, result.typeRefs);
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'method_declaration':
          result.symbols.push(extractMethod(node));
          extractCsMethodTypeRefs(node, result.typeRefs);
          break;
        case 'constructor_declaration':
          result.symbols.push(extractMethod(node));
          extractCsMethodTypeRefs(node, result.typeRefs);
          break;
        case 'using_directive':
          result.imports.push(extractUsingDirective(node));
          break;
        case 'invocation_expression': {
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'object_creation_expression': {
          const ref = extractNewCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'variable_declaration': {
          extractCsVariableTypeRefs(node, result.typeRefs);
          break;
        }
        case 'cast_expression': {
          extractCsCastTypeRef(node, result.typeRefs);
          break;
        }
        case 'as_expression': {
          extractCsAsCastTypeRef(node, result.typeRefs);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractNamedNode(node: Parser.SyntaxNode, kind: string): RawSymbol {
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
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, CS_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractNewCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, CS_SYMBOL_NODE_TYPES),
    calleeRaw: `new ${typeNode.text}`,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractUsingDirective(node: Parser.SyntaxNode): RawImport {
  // `using System.Collections.Generic;` or `using alias = Namespace;`
  const text = node.text
    .replace(/^using\s+(static\s+)?/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();

  // If there is an alias (`alias = Namespace`), split on '='
  const eqIdx = text.indexOf('=');
  let source: string;
  let importedNames: string[];
  if (eqIdx !== -1) {
    source = text.slice(eqIdx + 1).trim();
    importedNames = [text.slice(0, eqIdx).trim()];
  } else {
    source = text;
    const parts = text.split('.');
    importedNames = [parts[parts.length - 1] ?? ''];
  }

  return { source, importedNames };
}

// ─── Relationship extraction ──────────────────────────────────────────────────

function extractCsBaseListRelationships(
  node: Parser.SyntaxNode,
  declKind: string,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = node.childForFieldName('name')?.text ?? '';
  if (!name) return;
  const baseList = node.namedChildren.find(c => c.type === 'base_list');
  if (!baseList) return;
  for (const child of baseList.namedChildren) {
    if (child.type === 'identifier' || child.type === 'generic_name' || child.type === 'qualified_name') {
      const baseName = child.text;
      // In C#, there is no syntactic distinction between a base class and an
      // implemented interface in the base list.  For interfaces and structs all
      // entries are always `implements`.  For classes we conservatively default
      // to `implements` since we can't distinguish class-from-interface without
      // semantic analysis and interface-only base lists are very common.
      const kind = declKind === 'interface' ? 'extends' : 'implements';
      relationships.push({ kind, fromSymbol: name, toSymbol: baseName, line: child.startPosition.row, character: child.startPosition.column });
      typeRefs.push({ enclosingSymbol: name, typeRaw: baseName, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
    }
  }
}

// ─── Type-ref extraction ──────────────────────────────────────────────────────

function extractCsTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'identifier' || typeNode.type === 'qualified_name' || typeNode.type === 'generic_name') return typeNode.text;
  if (typeNode.type === 'predefined_type') return typeNode.text;
  if (typeNode.type === 'nullable_type' || typeNode.type === 'array_type') {
    const inner = typeNode.namedChildren[0];
    return inner ? extractCsTypeName(inner) : null;
  }
  for (const child of typeNode.namedChildren) {
    const name = extractCsTypeName(child);
    if (name) return name;
  }
  return null;
}

function emitCsTypeRef(refs: RawTypeRef[], enclosing: string, typeNode: Parser.SyntaxNode, refKind: TypeRefKind): void {
  const typeName = extractCsTypeName(typeNode);
  if (!typeName) return;
  refs.push({ enclosingSymbol: enclosing, typeRaw: typeName, refKind, line: typeNode.startPosition.row, character: typeNode.startPosition.column });
  const genericArgs = extractGenericTypeArgs(typeNode, 'generic_name', 'type_argument_list');
  for (const arg of genericArgs) {
    refs.push({ enclosingSymbol: enclosing, typeRaw: arg, refKind: 'generic_arg', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
  }
}

function extractCsMethodTypeRefs(methodNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const methodName = methodNode.childForFieldName('name')?.text ?? '';
  // Return type
  const returnType = methodNode.childForFieldName('type');
  if (returnType) emitCsTypeRef(refs, methodName, returnType, 'return');
  // Parameters
  const params = methodNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'parameter') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) emitCsTypeRef(refs, methodName, typeNode, 'parameter');
      }
    }
  }
}

function extractCsFieldTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ?? '';
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const decl = child.namedChildren.find(c => c.type === 'variable_declaration');
      if (decl) {
        const typeNode = decl.childForFieldName('type');
        if (typeNode) emitCsTypeRef(refs, className, typeNode, 'field');
      }
    }
  }
}

function extractCsVariableTypeRefs(varDeclNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const typeNode = varDeclNode.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractCsTypeName(typeNode);
  if (!typeName) return;
  const enclosing = findEnclosingSymbolName(varDeclNode, CS_SYMBOL_NODE_TYPES);
  emitCsTypeRef(refs, enclosing, typeNode, 'variable');
}

function extractCsCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // (Type)expr
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, CS_SYMBOL_NODE_TYPES);
  emitCsTypeRef(refs, enclosing, typeNode, 'cast');
}

function extractCsAsCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // expr as Type
  const typeNode = node.namedChildren.find(c =>
    c.type === 'identifier' || c.type === 'generic_name' || c.type === 'qualified_name' || c.type === 'nullable_type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, CS_SYMBOL_NODE_TYPES);
  emitCsTypeRef(refs, enclosing, typeNode, 'cast');
}
