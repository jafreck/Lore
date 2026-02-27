/**
 * @module indexer/extractors/php
 *
 * PHP language extractor.  Extracts function definitions, class/interface/trait
 * declarations, method declarations, and use/namespace_use declarations.
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

// ─── PhpExtractor ─────────────────────────────────────────────────────────────

export class PhpExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
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
          break;
        case 'namespace_use_declaration':
          result.imports.push(...extractUseDeclaration(node));
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
