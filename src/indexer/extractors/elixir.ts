/**
 * @module indexer/extractors/elixir
 *
 * Elixir language extractor.  Extracts def/defp functions, defmodule declarations,
 * defmacro/defmacrop macros, and alias/import/use directives.
 */

import type Parser from 'tree-sitter';
import {
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawSymbol,
  type SymbolExtractor,
  emptyResult,
  nodeSignature,
  walk,
} from './types.js';

// ─── ElixirExtractor ──────────────────────────────────────────────────────────

export class ElixirExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      if (node.type !== 'call') continue;

      const target = node.childForFieldName('target');
      if (!target) continue;

      const targetText = target.text;

      switch (targetText) {
        case 'def':
        case 'defp':
          result.symbols.push(extractDef(node, 'function'));
          break;
        case 'defmodule':
          result.symbols.push(extractDef(node, 'module'));
          break;
        case 'defmacro':
        case 'defmacrop':
          result.symbols.push(extractDef(node, 'macro'));
          break;
        case 'defstruct':
          result.symbols.push(extractDef(node, 'struct'));
          break;
        case 'defprotocol':
          result.symbols.push(extractDef(node, 'interface'));
          break;
        case 'defimpl':
          result.symbols.push(extractDef(node, 'impl'));
          break;
        case 'alias':
        case 'import':
        case 'use':
        case 'require':
          result.imports.push(extractElixirImport(node, targetText));
          break;
        case 'defguard':
        case 'defguardp':
        case 'defdelegate':
        case 'defexception':
        case 'defoverridable':
          break;
        default: {
          // Regular function call (not a definition keyword)
          const ref = extractCallRef(node, target);
          if (ref) result.callRefs.push(ref);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDef(node: Parser.SyntaxNode, kind: string): RawSymbol {
  // In Elixir's tree-sitter grammar, `def foo(bar)` is a call node
  // where the first argument is another call node or identifier.
  // In tree-sitter-elixir v0.3.x, `arguments` is a child node type,
  // not a named field — use both approaches for compatibility.
  const argsNode = node.childForFieldName('arguments') ??
    node.namedChildren.find(c => c.type === 'arguments');
  let name = '';

  if (argsNode && argsNode.namedChildren.length > 0) {
    const firstArg = argsNode.namedChildren[0]!;
    if (firstArg.type === 'call') {
      const callTarget = firstArg.childForFieldName('target');
      name = callTarget?.text ?? firstArg.text;
    } else if (firstArg.type === 'identifier' || firstArg.type === 'alias') {
      name = firstArg.text;
    } else {
      // Fallback: take first child text
      name = firstArg.text.split(/[\s(]/)[0] ?? '';
    }
  }

  return {
    name,
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode, target: Parser.SyntaxNode): RawCallRef | null {
  const calleeRaw = target.text;
  // Walk up to find enclosing def/defp
  let callerSymbol = '';
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'call') {
      const t = current.childForFieldName('target');
      if (t && (t.text === 'def' || t.text === 'defp')) {
        const args = current.childForFieldName('arguments');
        if (args?.namedChildren[0]) {
          const first = args.namedChildren[0];
          const ct = first.childForFieldName('target');
          callerSymbol = ct?.text ?? first.text.split(/[\s(]/)[0] ?? '';
        }
        break;
      }
    }
    current = current.parent;
  }
  return {
    callerSymbol,
    calleeRaw,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractElixirImport(node: Parser.SyntaxNode, directive: string): RawImport {
  const argsNode = node.childForFieldName('arguments');
  let source = '';

  if (argsNode && argsNode.namedChildren.length > 0) {
    source = argsNode.namedChildren[0]?.text ?? '';
  }

  return { source, importedNames: [directive] };
}
