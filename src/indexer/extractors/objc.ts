/**
 * @module indexer/extractors/objc
 *
 * Objective-C language extractor.  Extracts class interfaces, class implementations,
 * protocol declarations, method declarations, and #import directives.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawRelationship,
  type RawSymbol,
  type RawTypeRef,
  type SymbolExtractor,
  emptyResult,
  findEnclosingSymbolName,
  nodeSignature,
  walk,
} from './types.js';

const OBJC_SYMBOL_NODE_TYPES = [
  'method_declaration',
  'class_method_declaration',
  'instance_method_declaration',
  'class_interface',
  'class_implementation',
  'protocol_declaration',
  'category_interface',
] as const;

// ─── ObjcExtractor ───────────────────────────────────────────────────────────

export class ObjcExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'class_interface':
          result.symbols.push(extractClassInterface(node));
          extractObjcClassInheritance(node, result.relationships, result.typeRefs);
          extractObjcIvarTypeRefs(node, result.typeRefs);
          break;
        case 'class_implementation':
          result.symbols.push(extractClassImpl(node));
          break;
        case 'protocol_declaration':
          result.symbols.push(extractProtocol(node));
          extractObjcProtocolInheritance(node, result.relationships, result.typeRefs);
          break;
        case 'method_declaration':
        case 'class_method_declaration':
        case 'instance_method_declaration':
          result.symbols.push(extractMethod(node));
          extractObjcMethodTypeRefs(node, result.typeRefs);
          break;
        case 'category_interface':
          result.symbols.push(extractCategory(node));
          break;
        case 'preproc_import':
          result.imports.push(extractPreprocessorImport(node));
          break;
        case 'module_import':
          result.imports.push(extractModuleImport(node));
          break;
        case 'message_expression': {
          const ref = extractMessageCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'declaration': {
          extractObjcVarTypeRef(node, result.typeRefs);
          break;
        }
        case 'cast_expression': {
          extractObjcCastTypeRef(node, result.typeRefs);
          break;
        }
      }
    }

    // Also extract #import directives via regex for preprocessor includes
    extractHashImports(source, result);

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractMessageCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // [receiver selector:arg] — extract selector as callee
  const selectorNode = node.childForFieldName('selector') ??
    node.namedChildren.find(c => c.type === 'selector' || c.type === 'keyword_selector');
  const receiverNode = node.childForFieldName('receiver') ?? node.namedChildren[0];
  const callee = selectorNode?.text ?? receiverNode?.text ?? '';
  // Find enclosing method
  let callerSymbol = '';
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (OBJC_SYMBOL_NODE_TYPES.includes(current.type as typeof OBJC_SYMBOL_NODE_TYPES[number])) {
      const sel = current.childForFieldName('selector') ??
        current.namedChildren.find(c => c.type === 'selector' || c.type === 'keyword_selector');
      callerSymbol = sel?.text ?? '';
      break;
    }
    current = current.parent;
  }
  return {
    callerSymbol,
    calleeRaw: callee,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractClassInterface(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'class',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractClassImpl(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'impl',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractProtocol(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'interface',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractMethod(node: Parser.SyntaxNode): RawSymbol {
  // tree-sitter-objc v3+ uses plain `identifier` nodes for method names
  // instead of `selector`/`keyword_selector`.
  const selectorNode = node.childForFieldName('selector') ??
    node.namedChildren.find(c =>
      c.type === 'selector' || c.type === 'keyword_selector' || c.type === 'identifier',
    );
  return {
    name: selectorNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCategory(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'category',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractPreprocessorImport(node: Parser.SyntaxNode): RawImport {
  const pathNode = node.childForFieldName('path') ??
    node.namedChildren.find(c => c.type === 'string_literal' || c.type === 'system_lib_string');
  const source = pathNode?.text.replace(/^["<]|[">]$/g, '') ?? '';
  return { source, importedNames: [] };
}

function extractModuleImport(node: Parser.SyntaxNode): RawImport {
  // @import Foundation;
  const text = node.text
    .replace(/^@import\s+/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();
  return { source: text, importedNames: [] };
}

/**
 * Fallback: scan source for `#import "..."` and `#import <...>` directives
 * that might not be captured as tree-sitter nodes.
 */
function extractHashImports(source: string, result: ExtractionResult): void {
  const re = /#import\s+["<]([^">]+)[">]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const src = match[1]!;
    // Avoid duplicates
    if (!result.imports.some(i => i.source === src)) {
      result.imports.push({ source: src, importedNames: [] });
    }
  }
}

// ─── Type-ref extraction ──────────────────────────────────────────────────────

function extractObjcMethodTypeRefs(methodNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const selectorNode = methodNode.childForFieldName('selector') ??
    methodNode.namedChildren.find(c => c.type === 'selector' || c.type === 'keyword_selector');
  const methodName = selectorNode?.text ?? '';
  // Return type
  const returnType = methodNode.childForFieldName('return_type');
  if (returnType) {
    const typeName = extractObjcTypeName(returnType);
    if (typeName) {
      refs.push({ enclosingSymbol: methodName, typeRaw: typeName, refKind: 'return', line: returnType.startPosition.row, character: returnType.startPosition.column });
    }
  }
  // Parameters
  for (const child of methodNode.namedChildren) {
    if (child.type === 'keyword_declarator') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) {
        const typeName = extractObjcTypeName(typeNode);
        if (typeName) {
          refs.push({ enclosingSymbol: methodName, typeRaw: typeName, refKind: 'parameter', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
        }
      }
    }
  }
}

function extractObjcTypeName(typeNode: Parser.SyntaxNode): string | null {
  // ObjC types come as type_identifier, pointer types like NSString*, etc.
  if (typeNode.type === 'type_identifier' || typeNode.type === 'id') return typeNode.text;
  // Look for type_identifier in children
  for (const child of typeNode.namedChildren) {
    if (child.type === 'type_identifier') return child.text;
  }
  return null;
}

// ─── Relationship extraction ──────────────────────────────────────────────────

function extractObjcClassInheritance(
  node: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = node.childForFieldName('name')?.text ??
    node.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
  if (!name) return;
  // Superclass
  const superclass = node.childForFieldName('superclass') ??
    node.namedChildren.find(c => c.type === 'superclass_reference');
  if (superclass) {
    const superName = superclass.namedChildren.find(c => c.type === 'identifier')?.text ?? superclass.text;
    relationships.push({ kind: 'extends', fromSymbol: name, toSymbol: superName, line: superclass.startPosition.row, character: superclass.startPosition.column });
    typeRefs.push({ enclosingSymbol: name, typeRaw: superName, refKind: 'bound', line: superclass.startPosition.row, character: superclass.startPosition.column });
  }
  // Protocol conformance
  const protocols = node.namedChildren.find(c => c.type === 'protocol_qualifiers');
  if (protocols) {
    for (const child of protocols.namedChildren) {
      if (child.type === 'identifier') {
        relationships.push({ kind: 'implements', fromSymbol: name, toSymbol: child.text, line: child.startPosition.row, character: child.startPosition.column });
        typeRefs.push({ enclosingSymbol: name, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
      }
    }
  }
}

function extractObjcProtocolInheritance(
  node: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = node.childForFieldName('name')?.text ??
    node.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
  if (!name) return;
  const protocols = node.namedChildren.find(c => c.type === 'protocol_qualifiers');
  if (protocols) {
    for (const child of protocols.namedChildren) {
      if (child.type === 'identifier') {
        relationships.push({ kind: 'extends', fromSymbol: name, toSymbol: child.text, line: child.startPosition.row, character: child.startPosition.column });
        typeRefs.push({ enclosingSymbol: name, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
      }
    }
  }
}

function extractObjcIvarTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ??
    classNode.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
  // Instance variables are inside the class body
  for (const child of classNode.namedChildren) {
    if (child.type === 'instance_variables' || child.type === 'field_declaration_list') {
      for (const field of child.namedChildren) {
        if (field.type === 'field_declaration' || field.type === 'declaration') {
          const typeNode = field.childForFieldName('type');
          if (typeNode) {
            const typeName = extractObjcTypeName(typeNode);
            if (typeName) {
              refs.push({ enclosingSymbol: className, typeRaw: typeName, refKind: 'field', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
            }
          }
        }
      }
    }
  }
}

function extractObjcVarTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractObjcTypeName(typeNode);
  if (!typeName) return;
  const enclosing = findEnclosingSymbolName(node, OBJC_SYMBOL_NODE_TYPES);
  refs.push({ enclosingSymbol: enclosing, typeRaw: typeName, refKind: 'variable', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
}

function extractObjcCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // (Type *)expr
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractObjcTypeName(typeNode);
  if (!typeName) return;
  const enclosing = findEnclosingSymbolName(node, OBJC_SYMBOL_NODE_TYPES);
  refs.push({ enclosingSymbol: enclosing, typeRaw: typeName, refKind: 'cast', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
}