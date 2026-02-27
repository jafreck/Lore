/**
 * @module indexer/extractors/zig
 *
 * Zig language extractor.  Extracts function declarations (fn), struct/enum/union
 * declarations, and @import() calls.
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

// ─── ZigExtractor ─────────────────────────────────────────────────────────────

export class ZigExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'FnProto':
          result.symbols.push(extractFn(node));
          break;
        case 'TestDecl':
          result.symbols.push(extractTest(node));
          break;
        case 'ContainerDecl':
          // struct/enum/union — try to find enclosing VarDecl for the name
          break;
        case 'VarDecl': {
          const sym = extractVarDecl(node);
          if (sym) result.symbols.push(sym);
          break;
        }
        case 'BUILTIN': {
          if (node.text === '@import') {
            const imp = tryExtractImport(node);
            if (imp) result.imports.push(imp);
          }
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractFn(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.namedChildren.find(c => c.type === 'IDENTIFIER');
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractTest(node: Parser.SyntaxNode): RawSymbol {
  // test "name" { ... }
  const nameNode = node.namedChildren.find(c => c.type === 'STRINGLITERALSINGLE');
  return {
    name: nameNode?.text.replace(/^"|"$/g, '') ?? 'test',
    kind: 'test',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

/**
 * `const Foo = struct { ... }` or `pub const bar = ...`
 * We extract top-level const/var declarations that have container bodies or
 * are otherwise significant.
 */
function extractVarDecl(node: Parser.SyntaxNode): RawSymbol | null {
  const nameNode = node.namedChildren.find(c => c.type === 'IDENTIFIER');
  if (!nameNode) return null;

  // Check if this is a type definition (assigned a struct/enum/union)
  const hasContainer = node.namedChildren.some(
    c => c.type === 'ContainerDecl' || c.type === 'ErrorSetDecl',
  );

  const kind = hasContainer ? 'type' : 'const';
  return {
    name: nameNode.text,
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function tryExtractImport(node: Parser.SyntaxNode): RawImport | null {
  // @import("std") — the parent is typically a BuiltinCallExpr
  const parent = node.parent;
  if (!parent) return null;

  const argNode = parent.namedChildren.find(c => c.type === 'STRINGLITERALSINGLE');
  if (!argNode) return null;

  const source = argNode.text.replace(/^"|"$/g, '');
  return { source, importedNames: [] };
}
