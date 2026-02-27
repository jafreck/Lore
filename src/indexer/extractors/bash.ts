/**
 * @module indexer/extractors/bash
 *
 * Bash/Shell language extractor.  Extracts function definitions and `source`
 * / `.` commands as imports.
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

// ─── BashExtractor ────────────────────────────────────────────────────────────

export class BashExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'command': {
          const imp = tryExtractSource(node);
          if (imp) result.imports.push(imp);
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

/**
 * Detects `source file.sh` and `. file.sh` commands.
 */
function tryExtractSource(node: Parser.SyntaxNode): RawImport | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;

  const cmd = nameNode.text;
  if (cmd !== 'source' && cmd !== '.') return null;

  // The sourced file is the first argument after the command name
  const args = node.namedChildren.filter(c => c !== nameNode);
  const firstArg = args[0];
  if (!firstArg) return null;

  const source = firstArg.text.replace(/^['"]|['"]$/g, '');
  return { source, importedNames: [] };
}
