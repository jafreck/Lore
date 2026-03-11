/**
 * @module indexer/extractors/lua
 *
 * Lua language extractor.  Extracts function declarations (global, local, and
 * method definitions) and `require()` calls as imports.
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

const LUA_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'local_function_declaration',
] as const;

// ─── LuaExtractor ────────────────────────────────────────────────────────────

export class LuaExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
        case 'local_function_declaration':
          result.symbols.push(extractFunction(node));
          break;
        case 'function_call': {
          const imp = tryExtractRequire(node);
          if (imp) result.imports.push(imp);
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
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('name');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, LUA_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

/**
 * Detects `require("module")` and `require "module"` calls.
 */
function tryExtractRequire(node: Parser.SyntaxNode): RawImport | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.text !== 'require') return null;

  const argsNode = node.childForFieldName('arguments');
  if (!argsNode) return null;

  const firstArg = argsNode.namedChildren[0];
  if (!firstArg) return null;

  const source = firstArg.text.replace(/^['"]|['"]$/g, '');
  return { source, importedNames: [] };
}
