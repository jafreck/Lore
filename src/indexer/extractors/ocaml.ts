/**
 * @module indexer/extractors/ocaml
 *
 * OCaml language extractor.  Extracts let bindings, type definitions, module
 * definitions, and open statements.
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

// ─── OcamlExtractor ──────────────────────────────────────────────────────────

export class OcamlExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'let_binding':
          result.symbols.push(extractLetBinding(node));
          break;
        case 'value_definition': {
          // Contains one or more let_bindings — handled via children
          break;
        }
        case 'type_definition':
          result.symbols.push(extractTypeDefinition(node));
          break;
        case 'module_definition':
          result.symbols.push(extractModuleDefinition(node));
          break;
        case 'module_type_definition':
          result.symbols.push(extractModuleTypeDefinition(node));
          break;
        case 'open_statement':
          result.imports.push(extractOpen(node));
          break;
        case 'application_expression': {
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

function extractLetBinding(node: Parser.SyntaxNode): RawSymbol {
  // `let foo x y = ...` — the pattern/name is the first child
  const patternNode = node.childForFieldName('pattern') ?? node.namedChildren[0];
  const name = patternNode?.text ?? '';

  // Determine if it's a function (has parameter list) or a value
  const hasParams = node.namedChildren.some(
    c => c.type === 'parameter' || c.type === 'fun_expression',
  );

  return {
    name,
    kind: hasParams ? 'function' : 'val',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractTypeDefinition(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'type_constructor');
  return {
    name: nameNode?.text ?? '',
    kind: 'type',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractModuleDefinition(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'module_name');
  return {
    name: nameNode?.text ?? '',
    kind: 'module',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractModuleTypeDefinition(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'module_type_name');
  return {
    name: nameNode?.text ?? '',
    kind: 'module_type',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // OCaml application: (fn arg1 arg2) — first child is the callee
  const fnNode = node.namedChildren[0];
  if (!fnNode) return null;
  // Find enclosing let binding
  let callerSymbol = '';
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'let_binding') {
      const pat = current.childForFieldName('pattern') ?? current.namedChildren[0];
      callerSymbol = pat?.text ?? '';
      break;
    }
    current = current.parent;
  }
  return {
    callerSymbol,
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractOpen(node: Parser.SyntaxNode): RawImport {
  // `open Foo.Bar`
  const moduleNode = node.namedChildren.find(
    c => c.type === 'module_path' || c.type === 'module_name' || c.type === 'extended_module_path',
  ) ?? node.namedChildren[0];
  const source = moduleNode?.text ?? '';
  return { source, importedNames: [] };
}
