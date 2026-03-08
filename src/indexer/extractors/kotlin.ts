/**
 * @module indexer/extractors/kotlin
 *
 * Kotlin language extractor.  Extracts function declarations, class/interface/
 * object declarations, and import directives.
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
  findEnclosingSymbolName,
  nodeSignature,
  walk,
} from './types.js';

const KOTLIN_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'class_declaration',
] as const;

// ─── KotlinExtractor ─────────────────────────────────────────────────────────

export class KotlinExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
          result.symbols.push(extractFunction(node));
          extractKotlinFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          extractKotlinInheritance(node, result.relationships, result.typeRefs);
          break;
        case 'object_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          break;
        case 'enum_class_body':
          // Handled via parent class_declaration
          break;
        case 'import_header':
          result.imports.push(extractImport(node));
          break;
        case 'call_expression': {
          const ref = extractCallRef(node);
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
  // Kotlin uses `simple_identifier` for function names
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'simple_identifier');
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
    node.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'simple_identifier');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // Kotlin call_expression: first named child is the callee
  const fnNode = node.namedChildren[0];
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, KOTLIN_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  // `import com.example.Foo` or `import com.example.*`
  const identNode = node.namedChildren.find(c => c.type === 'identifier');
  const source = identNode?.text ??
    node.text.replace(/^import\s+/, '').trim();

  const parts = source.split('.');
  const lastName = parts[parts.length - 1] ?? '';
  const importedNames = lastName === '*' ? [] : [lastName];

  return { source, importedNames };
}

// ─── Inheritance / type-ref extraction ─────────────────────────────────────────

function extractKotlinInheritance(
  classNode: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = classNode.childForFieldName('name')?.text ??
    classNode.namedChildren.find(c => c.type === 'type_identifier' || c.type === 'simple_identifier')?.text ?? '';
  if (!name) return;
  const delegation = classNode.namedChildren.find(c => c.type === 'delegation_specifier' || c.type === 'delegation_specifiers');
  if (!delegation) return;
  const specs = delegation.type === 'delegation_specifiers' ? delegation.namedChildren : [delegation];
  let first = true;
  for (const spec of specs) {
    const typeNode = spec.namedChildren.find(c => c.type === 'user_type' || c.type === 'type_identifier' || c.type === 'simple_identifier');
    if (typeNode) {
      const baseName = typeNode.text;
      const kind = first ? 'extends' : 'implements';
      relationships.push({ kind, fromSymbol: name, toSymbol: baseName, line: typeNode.startPosition.row });
      typeRefs.push({ enclosingSymbol: name, typeRaw: baseName, refKind: 'bound', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
      first = false;
    }
  }
}

function extractKotlinTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'user_type' || typeNode.type === 'type_identifier' || typeNode.type === 'simple_identifier') return typeNode.text;
  if (typeNode.type === 'nullable_type') {
    const inner = typeNode.namedChildren[0];
    return inner ? extractKotlinTypeName(inner) : null;
  }
  return null;
}

function extractKotlinFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = funcNode.childForFieldName('name')?.text ??
    funcNode.namedChildren.find(c => c.type === 'simple_identifier')?.text ?? '';
  // Parameters
  const params = funcNode.namedChildren.find(c => c.type === 'function_value_parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'parameter') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) {
          const typeName = extractKotlinTypeName(typeNode);
          if (typeName) {
            refs.push({ enclosingSymbol: funcName, typeRaw: typeName, refKind: 'parameter', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
          }
        }
      }
    }
  }
  // Return type
  const returnType = funcNode.namedChildren.find(c => c.type === 'user_type' && c !== funcNode.childForFieldName('name'));
  if (returnType) {
    const typeName = extractKotlinTypeName(returnType);
    if (typeName) {
      refs.push({ enclosingSymbol: funcName, typeRaw: typeName, refKind: 'return', line: returnType.startPosition.row, character: returnType.startPosition.column });
    }
  }
}
