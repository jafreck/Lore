/**
 * @module indexer/extractors/ruby
 *
 * Ruby language extractor.  Extracts method definitions (def / singleton_method),
 * class and module declarations, and require/require_relative imports.
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

// ─── RubyExtractor ───────────────────────────────────────────────────────────

export class RubyExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'method':
          result.symbols.push(extractMethod(node));
          break;
        case 'singleton_method':
          result.symbols.push(extractSingletonMethod(node));
          break;
        case 'class':
          result.symbols.push(extractClass(node));
          break;
        case 'module':
          result.symbols.push(extractModule(node));
          break;
        case 'call': {
          const imp = tryExtractRequire(node);
          if (imp) result.imports.push(imp);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function extractSingletonMethod(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name');
  const objectNode = node.childForFieldName('object');
  const prefix = objectNode ? `${objectNode.text}.` : 'self.';
  return {
    name: `${prefix}${nameNode?.text ?? ''}`,
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractClass(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind: 'class',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractModule(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind: 'module',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

/**
 * Detects `require 'foo'` and `require_relative 'bar'` calls.
 */
function tryExtractRequire(node: Parser.SyntaxNode): RawImport | null {
  const methodNode = node.childForFieldName('method');
  if (!methodNode) return null;

  const methodName = methodNode.text;
  if (methodName !== 'require' && methodName !== 'require_relative') return null;

  const argsNode = node.childForFieldName('arguments');
  if (!argsNode) return null;

  // First argument is the require path (string literal)
  const firstArg = argsNode.namedChildren[0];
  if (!firstArg) return null;

  const source = firstArg.text.replace(/^['"]|['"]$/g, '');
  return { source, importedNames: [] };
}
