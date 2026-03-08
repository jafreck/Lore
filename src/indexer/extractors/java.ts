/**
 * @module indexer/extractors/java
 *
 * P2/P3 Java language extractor.  Extracts class declarations, interface
 * declarations, method declarations, and import declarations.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawSymbol,
  type SymbolExtractor,
  emptyResult,
  findEnclosingSymbolName,
  nodeSignature,
  walk,
} from './types.js';

const JAVA_SYMBOL_NODE_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'class_declaration',
] as const;

// ─── JavaExtractor ────────────────────────────────────────────────────────────

export class JavaExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'method_declaration':
          result.symbols.push(extractMethod(node));
          break;
        case 'import_declaration':
          result.imports.push(extractImport(node));
          break;
        case 'method_invocation': {
          const ref = extractMethodCallRef(node);
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

function extractMethodCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const objectNode = node.childForFieldName('object');
  const calleeRaw = objectNode ? `${objectNode.text}.${nameNode.text}` : nameNode.text;
  return {
    callerSymbol: findEnclosingSymbolName(node, JAVA_SYMBOL_NODE_TYPES),
    calleeRaw,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractNewCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, JAVA_SYMBOL_NODE_TYPES),
    calleeRaw: `new ${typeNode.text}`,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  // import a.b.C;  or  import static a.b.C.method;
  // The raw text is like "import a.b.C;" — strip keyword and semicolon.
  const text = node.text
    .replace(/^import\s+(static\s+)?/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();

  // Extract the simple name as the last segment (or '*' for wildcard)
  const parts = text.split('.');
  const lastName = parts[parts.length - 1] ?? '';
  const importedNames = lastName === '*' ? [] : [lastName];

  return { source: text, importedNames };
}
