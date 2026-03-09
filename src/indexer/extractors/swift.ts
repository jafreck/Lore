/**
 * @module indexer/extractors/swift
 *
 * Swift language extractor.  Extracts function declarations, class/struct/enum/
 * protocol declarations, and import declarations.
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
  createTypeRefEmitter,
  emptyResult,
  findEnclosingSymbolName,
  nodeSignature,
  walk,
} from './types.js';

const SWIFT_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'class_declaration',
  'struct_declaration',
] as const;

// ─── SwiftExtractor ───────────────────────────────────────────────────────────

export class SwiftExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
          result.symbols.push(extractFunction(node));
          extractSwiftFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          extractSwiftInheritance(node, result.relationships, result.typeRefs);
          extractSwiftClassFieldTypeRefs(node, result.typeRefs);
          break;
        case 'struct_declaration':
          result.symbols.push(extractNamedNode(node, 'struct'));
          extractSwiftInheritance(node, result.relationships, result.typeRefs);
          extractSwiftClassFieldTypeRefs(node, result.typeRefs);
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'protocol_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          break;
        case 'extension_declaration':
          result.symbols.push(extractExtension(node));
          break;
        case 'import_declaration':
          result.imports.push(extractImport(node));
          break;
        case 'call_expression': {
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'property_declaration':
        case 'pattern_binding_declaration': {
          extractSwiftVarTypeRef(node, result.typeRefs);
          break;
        }
        case 'as_expression': {
          extractSwiftCastTypeRef(node, result.typeRefs);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // Swift call_expression: first named child is typically the callee
  const fnNode = node.namedChildren[0];
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, SWIFT_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractFunction(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

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

function extractExtension(node: Parser.SyntaxNode): RawSymbol {
  // extension TypeName { ... }
  const nameNode = node.childForFieldName('name') ?? node.namedChildren[0];
  return {
    name: nameNode?.text ?? '',
    kind: 'extension',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  // `import Foundation` or `import class UIKit.UIViewController`
  const text = node.text
    .replace(/^import\s+/, '')
    .trim();

  // Strip optional kind qualifier (class/struct/enum/protocol/func etc.)
  const qualifiers = ['class', 'struct', 'enum', 'protocol', 'func', 'var', 'let', 'typealias'];
  let source = text;
  for (const q of qualifiers) {
    if (source.startsWith(q + ' ')) {
      source = source.slice(q.length + 1).trim();
      break;
    }
  }

  const parts = source.split('.');
  const importedNames = parts.length > 1 ? [parts[parts.length - 1] ?? ''] : [];
  return { source, importedNames };
}

// ─── Inheritance / type-ref extraction ─────────────────────────────────────────

function extractSwiftInheritance(
  node: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = node.childForFieldName('name')?.text ?? '';
  if (!name) return;
  const isClass = node.type === 'class_declaration';
  // Look for type_inheritance_clause
  const inheritanceClause = node.namedChildren.find(c => c.type === 'type_inheritance_clause' || c.type === 'inheritance_specifier');
  if (!inheritanceClause) return;
  let first = true;
  for (const child of inheritanceClause.namedChildren) {
    if (child.type === 'type_identifier' || child.type === 'user_type') {
      const baseName = child.text;
      const kind = (isClass && first) ? 'extends' : 'implements';
      relationships.push({ kind, fromSymbol: name, toSymbol: baseName, line: child.startPosition.row, character: child.startPosition.column });
      typeRefs.push({ enclosingSymbol: name, typeRaw: baseName, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
      first = false;
    }
  }
}

function extractSwiftTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier' || typeNode.type === 'user_type') return typeNode.text;
  if (typeNode.type === 'optional_type') {
    const inner = typeNode.namedChildren[0];
    return inner ? extractSwiftTypeName(inner) : null;
  }
  if (typeNode.type === 'array_type') {
    const element = typeNode.namedChildren[0];
    return element ? extractSwiftTypeName(element) : null;
  }
  return null;
}

const emitSwiftTypeRef = createTypeRefEmitter({
  extractTypeName: extractSwiftTypeName,
  genericNodeType: 'generic_type',
  argListNodeType: 'type_arguments',
});

function extractSwiftFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = funcNode.childForFieldName('name')?.text ?? '';
  // Parameters — walk all children looking for parameter nodes
  for (const child of funcNode.namedChildren) {
    if (child.type === 'function_parameter' || child.type === 'parameter') {
      const typeAnnotation = child.childForFieldName('type');
      if (typeAnnotation) emitSwiftTypeRef(refs, funcName, typeAnnotation, 'parameter');
    }
  }
  // Return type — only match function_result to avoid grabbing parameter types
  const returnClause = funcNode.namedChildren.find(c => c.type === 'function_result');
  if (returnClause) {
    const typeNode = returnClause.namedChildren[0];
    if (typeNode) emitSwiftTypeRef(refs, funcName, typeNode, 'return');
  }
}

function extractSwiftClassFieldTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ?? '';
  const body = classNode.childForFieldName('body') ?? classNode.namedChildren.find(c => c.type === 'class_body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'property_declaration') {
      const typeAnnotation = child.namedChildren.find(c => c.type === 'type_annotation');
      if (typeAnnotation) {
        const typeNode = typeAnnotation.namedChildren[0];
        if (typeNode) emitSwiftTypeRef(refs, className, typeNode, 'field');
      }
    }
  }
}

function extractSwiftVarTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const typeAnnotation = node.namedChildren.find(c => c.type === 'type_annotation');
  if (!typeAnnotation) return;
  const typeNode = typeAnnotation.namedChildren[0];
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, SWIFT_SYMBOL_NODE_TYPES);
  emitSwiftTypeRef(refs, enclosing, typeNode, 'variable');
}

function extractSwiftCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // expression as Type or expression as? Type
  const typeNode = node.namedChildren.find(c =>
    c.type === 'type_identifier' || c.type === 'user_type' || c.type === 'optional_type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, SWIFT_SYMBOL_NODE_TYPES);
  emitSwiftTypeRef(refs, enclosing, typeNode, 'cast');
}
