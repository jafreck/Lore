/**
 * @module indexer/extractors/swift
 *
 * Swift language extractor.  Extracts function declarations, class/struct/enum/
 * protocol declarations, and import declarations.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawImport,
  type RawSymbol,
  type SymbolExtractor,
  emptyResult,
  nodeSignature,
  walk,
} from './types.js';

// ─── SwiftExtractor ───────────────────────────────────────────────────────────

export class SwiftExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
          result.symbols.push(extractFunction(node));
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          break;
        case 'struct_declaration':
          result.symbols.push(extractNamedNode(node, 'struct'));
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
