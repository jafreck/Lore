/**
 * @module indexer/extractors/php
 *
 * PHP language extractor.  Extracts function definitions, class/interface/trait
 * declarations, method declarations, and use/namespace_use declarations.
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

const PHP_SYMBOL_NODE_TYPES = [
  'function_definition',
  'method_declaration',
] as const;

// ─── PhpExtractor ─────────────────────────────────────────────────────────────

export class PhpExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          extractPhpFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          extractPhpClassRelationships(node, result.relationships, result.typeRefs);
          extractPhpClassFieldTypeRefs(node, result.typeRefs);
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          break;
        case 'trait_declaration':
          result.symbols.push(extractNamedNode(node, 'trait'));
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'method_declaration':
          result.symbols.push(extractFunction(node));
          extractPhpFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'namespace_use_declaration':
          result.imports.push(...extractUseDeclaration(node));
          break;
        case 'function_call_expression':
        case 'member_call_expression':
        case 'scoped_call_expression': {
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'object_creation_expression': {
          const ref = extractNewCallRef(node);
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

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function') ?? node.childForFieldName('name');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, PHP_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractNewCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // new ClassName(...)
  const nameNode = node.namedChildren.find(c => c.type === 'name' || c.type === 'qualified_name');
  if (!nameNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, PHP_SYMBOL_NODE_TYPES),
    calleeRaw: `new ${nameNode.text}`,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

/**
 * Handles `use App\Models\User;` and grouped `use App\Models\{User, Post};`.
 */
function extractUseDeclaration(node: Parser.SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (const child of node.namedChildren) {
    if (child.type === 'namespace_use_clause') {
      const nameNode = child.childForFieldName('name') ?? child.namedChildren[0];
      if (nameNode) {
        const source = nameNode.text;
        const parts = source.split('\\');
        const importedNames = [parts[parts.length - 1] ?? ''];
        imports.push({ source, importedNames });
      }
    } else if (child.type === 'namespace_use_group') {
      for (const clause of child.namedChildren) {
        if (clause.type === 'namespace_use_clause') {
          const nameNode = clause.childForFieldName('name') ?? clause.namedChildren[0];
          if (nameNode) {
            const source = nameNode.text;
            const parts = source.split('\\');
            imports.push({ source, importedNames: [parts[parts.length - 1] ?? ''] });
          }
        }
      }
    }
  }

  if (imports.length === 0) {
    // Fallback: extract from raw text
    const text = node.text
      .replace(/^use\s+/, '')
      .replace(/\s*;?\s*$/, '')
      .trim();
    imports.push({ source: text, importedNames: [] });
  }

  return imports;
}

// ─── Type-ref extraction ──────────────────────────────────────────────────────

function extractPhpFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = funcNode.childForFieldName('name')?.text ?? '';
  // Parameters
  const params = funcNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'simple_parameter') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) {
          const typeName = extractPhpTypeName(typeNode);
          if (typeName) {
            refs.push({ enclosingSymbol: funcName, typeRaw: typeName, refKind: 'parameter', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
          }
        }
      }
    }
  }
  // Return type
  const returnType = funcNode.childForFieldName('return_type');
  if (returnType) {
    const typeName = extractPhpTypeName(returnType);
    if (typeName) {
      refs.push({ enclosingSymbol: funcName, typeRaw: typeName, refKind: 'return', line: returnType.startPosition.row, character: returnType.startPosition.column });
    }
  }
}

function extractPhpTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'named_type' || typeNode.type === 'qualified_name' || typeNode.type === 'name') return typeNode.text;
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.namedChildren[0];
    return inner ? extractPhpTypeName(inner) : null;
  }
  if (typeNode.type === 'union_type' || typeNode.type === 'intersection_type') return null; // skip compound types
  // Look in children
  for (const child of typeNode.namedChildren) {
    const name = extractPhpTypeName(child);
    if (name) return name;
  }
  return null;
}

// ─── Relationship extraction ──────────────────────────────────────────────────

function extractPhpClassRelationships(
  classNode: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = classNode.childForFieldName('name')?.text ?? '';
  if (!name) return;
  // extends
  const baseClause = classNode.namedChildren.find(c => c.type === 'base_clause');
  if (baseClause) {
    for (const child of baseClause.namedChildren) {
      if (child.type === 'name' || child.type === 'qualified_name') {
        relationships.push({ kind: 'extends', fromSymbol: name, toSymbol: child.text, line: child.startPosition.row, character: child.startPosition.column });
        typeRefs.push({ enclosingSymbol: name, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
      }
    }
  }
  // implements
  const classInterfaceClause = classNode.namedChildren.find(c => c.type === 'class_interface_clause');
  if (classInterfaceClause) {
    for (const child of classInterfaceClause.namedChildren) {
      if (child.type === 'name' || child.type === 'qualified_name') {
        relationships.push({ kind: 'implements', fromSymbol: name, toSymbol: child.text, line: child.startPosition.row, character: child.startPosition.column });
        typeRefs.push({ enclosingSymbol: name, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
      }
    }
  }
}

function extractPhpClassFieldTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ?? '';
  const body = classNode.childForFieldName('body') ?? classNode.namedChildren.find(c => c.type === 'declaration_list');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'property_declaration') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) {
        const typeName = extractPhpTypeName(typeNode);
        if (typeName) {
          refs.push({ enclosingSymbol: className, typeRaw: typeName, refKind: 'field', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
        }
      }
    }
  }
}
