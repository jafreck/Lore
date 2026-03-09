/**
 * @module indexer/extractors/dart
 *
 * Dart language extractor.  Extracts function declarations, class/mixin/enum/
 * extension declarations, method declarations, and import directives.
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

const DART_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'function_signature',
  'method_signature',
  'class_definition',
] as const;

// ─── DartExtractor ────────────────────────────────────────────────────────────

export class DartExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_signature':
        case 'function_declaration':
          result.symbols.push(extractFunction(node));
          extractDartFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'method_signature':
          result.symbols.push(extractFunction(node));
          extractDartFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'class_definition':
          result.symbols.push(extractNamedNode(node, 'class'));
          extractDartInheritance(node, result.relationships, result.typeRefs);
          extractDartClassFieldTypeRefs(node, result.typeRefs);
          break;
        case 'mixin_declaration':
          result.symbols.push(extractNamedNode(node, 'mixin'));
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'extension_declaration':
          result.symbols.push(extractNamedNode(node, 'extension'));
          break;
        case 'import_or_export':
          result.imports.push(extractImport(node));
          break;
        // Dart uses several node types for calls depending on the grammar version
        case 'function_expression_invocation':
        case 'method_invocation': {
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'initialized_variable_definition': {
          extractDartVarTypeRef(node, result.typeRefs);
          break;
        }
        case 'as_expression': {
          extractDartCastTypeRef(node, result.typeRefs);
          break;
        }
      }
    }

    // Fallback: scan all nodes for unvisited call-like patterns
    for (const node of walk(tree.rootNode)) {
      if (
        node.type === 'identifier'
        && node.parent?.type === 'selector'
        && node.parent.parent?.type === 'assignable_expression'
      ) {
        // method call via cascade or chain
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFunction(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractNamedNode(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function') ?? node.childForFieldName('name');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, DART_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  // `import 'package:foo/bar.dart';` or `export 'package:foo/bar.dart';`
  const text = node.text
    .replace(/^(import|export)\s+/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();

  // Strip quotes
  const source = text.replace(/^['"]|['"]$/g, '').split(/\s/)[0] ?? '';

  // Check for `show` / `hide` clauses
  const importedNames: string[] = [];
  const showMatch = text.match(/show\s+([\w,\s]+)/);
  if (showMatch) {
    importedNames.push(...showMatch[1]!.split(',').map(s => s.trim()).filter(Boolean));
  }

  return { source, importedNames };
}

// ─── Inheritance / type-ref extraction ─────────────────────────────────────────

function extractDartInheritance(
  classNode: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = classNode.childForFieldName('name')?.text ??
    classNode.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
  if (!name) return;
  for (const child of classNode.namedChildren) {
    if (child.type === 'superclass') {
      const typeNode = child.namedChildren[0];
      if (typeNode) {
        relationships.push({ kind: 'extends', fromSymbol: name, toSymbol: typeNode.text, line: typeNode.startPosition.row, character: typeNode.startPosition.column });
        typeRefs.push({ enclosingSymbol: name, typeRaw: typeNode.text, refKind: 'bound', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
      }
    }
    if (child.type === 'interfaces' || child.type === 'mixins') {
      for (const iface of child.namedChildren) {
        if (iface.type === 'type_identifier' || iface.type === 'identifier') {
          relationships.push({ kind: 'implements', fromSymbol: name, toSymbol: iface.text, line: iface.startPosition.row, character: iface.startPosition.column });
          typeRefs.push({ enclosingSymbol: name, typeRaw: iface.text, refKind: 'bound', line: iface.startPosition.row, character: iface.startPosition.column });
        }
      }
    }
  }
}

function extractDartTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier') return typeNode.text;
  return null;
}

const emitDartTypeRef = createTypeRefEmitter({
  extractTypeName: extractDartTypeName,
  genericNodeType: 'type_identifier',
  argListNodeType: 'type_arguments',
});

function extractDartFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = funcNode.childForFieldName('name')?.text ??
    funcNode.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
  // Return type  
  const returnType = funcNode.childForFieldName('type') ?? funcNode.namedChildren.find(c => c.type === 'type_identifier');
  if (returnType && returnType.type === 'type_identifier') {
    emitDartTypeRef(refs, funcName, returnType, 'return');
  }
  // Parameters
  const params = funcNode.namedChildren.find(c => c.type === 'formal_parameter_list');
  if (params) {
    for (const param of params.namedChildren) {
      const typeNode = param.namedChildren.find(c => c.type === 'type_identifier');
      if (typeNode) {
        emitDartTypeRef(refs, funcName, typeNode, 'parameter');
      }
    }
  }
}

function extractDartClassFieldTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ??
    classNode.namedChildren.find(c => c.type === 'identifier')?.text ?? '';
  const body = classNode.childForFieldName('body') ?? classNode.namedChildren.find(c => c.type === 'class_body');
  if (!body) return;
  // Only walk direct children of the class body — avoid recursing into nested classes
  for (const child of body.namedChildren) {
    if (child.type === 'class_definition') continue; // skip nested classes
    if (child.type === 'initialized_variable_definition' || child.type === 'declaration') {
      const typeNode = child.namedChildren.find(c => c.type === 'type_identifier');
      if (typeNode) {
        emitDartTypeRef(refs, className, typeNode, 'field');
      }
    }
  }
}

function extractDartVarTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const typeNode = node.namedChildren.find(c => c.type === 'type_identifier');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, DART_SYMBOL_NODE_TYPES);
  emitDartTypeRef(refs, enclosing, typeNode, 'variable');
}

function extractDartCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // expr as Type
  const typeNode = node.namedChildren.find(c => c.type === 'type_identifier');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, DART_SYMBOL_NODE_TYPES);
  emitDartTypeRef(refs, enclosing, typeNode, 'cast');
}
