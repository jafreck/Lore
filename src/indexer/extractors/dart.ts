/**
 * @module indexer/extractors/dart
 *
 * Dart language extractor.  Extracts function declarations, class/mixin/enum/
 * extension declarations, method declarations, and import directives.
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

// ─── DartExtractor ────────────────────────────────────────────────────────────

export class DartExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_signature':
        case 'function_declaration':
          result.symbols.push(extractFunction(node));
          break;
        case 'method_signature':
          result.symbols.push(extractFunction(node));
          break;
        case 'class_definition':
          result.symbols.push(extractNamedNode(node, 'class'));
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
