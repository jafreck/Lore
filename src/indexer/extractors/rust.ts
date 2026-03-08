/**
 * @module indexer/extractors/rust
 *
 * P0 Rust language extractor.  Extracts fn items, struct/enum/trait/impl
 * declarations, and use declarations.
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

const RUST_SYMBOL_NODE_TYPES = [
  'function_item',
  'impl_item',
] as const;

// ─── RustExtractor ────────────────────────────────────────────────────────────

export class RustExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_item':
          result.symbols.push(extractItem(node, 'function'));
          break;
        case 'struct_item':
          result.symbols.push(extractItem(node, 'struct'));
          break;
        case 'enum_item':
          result.symbols.push(extractItem(node, 'enum'));
          break;
        case 'trait_item':
          result.symbols.push(extractItem(node, 'trait'));
          break;
        case 'impl_item':
          result.symbols.push(extractImpl(node));
          break;
        case 'use_declaration':
          result.imports.push(extractUse(node));
          break;
        case 'call_expression': {
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'macro_invocation': {
          const ref = extractMacroCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractItem(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractImpl(node: Parser.SyntaxNode): RawSymbol {
  // impl Trait for Type  — use the `type` field as the name
  const typeNode = node.childForFieldName('type');
  const traitNode = node.childForFieldName('trait');
  const name = traitNode
    ? `${traitNode.text} for ${typeNode?.text ?? ''}`
    : (typeNode?.text ?? '');
  return {
    name,
    kind: 'impl',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractUse(node: Parser.SyntaxNode): RawImport {
  const argNode = node.childForFieldName('argument');
  const source = argNode?.text ?? node.text;

  // Collect leaf identifiers as imported names (best-effort)
  const importedNames: string[] = [];
  if (argNode) {
    collectLeafIdentifiers(argNode, importedNames);
  }

  return { source, importedNames };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, RUST_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractMacroCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const macroNode = node.childForFieldName('macro');
  if (!macroNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, RUST_SYMBOL_NODE_TYPES),
    calleeRaw: macroNode.text + '!',
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function collectLeafIdentifiers(
  node: Parser.SyntaxNode,
  out: string[],
): void {
  if (node.type === 'identifier' && node.namedChildCount === 0) {
    out.push(node.text);
    return;
  }
  for (const child of node.namedChildren) {
    collectLeafIdentifiers(child, out);
  }
}
