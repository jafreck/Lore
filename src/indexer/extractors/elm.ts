/**
 * @module indexer/extractors/elm
 *
 * Elm language extractor.  Extracts function declarations, type declarations,
 * type alias declarations, and import clauses.
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

// ─── ElmExtractor ─────────────────────────────────────────────────────────────

export class ElmExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'value_declaration':
          result.symbols.push(extractValueDecl(node));
          break;
        case 'type_declaration':
          result.symbols.push(extractTypeDecl(node, 'type'));
          break;
        case 'type_alias_declaration':
          result.symbols.push(extractTypeDecl(node, 'type'));
          break;
        case 'port_annotation':
          result.symbols.push(extractPort(node));
          break;
        case 'import_clause':
          result.imports.push(extractImport(node));
          break;
        case 'function_call_expr': {
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

function extractValueDecl(node: Parser.SyntaxNode): RawSymbol {
  // The function name is the first named child
  const patternNode = node.childForFieldName('pattern') ?? node.namedChildren[0];
  // For function_declaration_left, the name is the first child
  const name = patternNode?.type === 'function_declaration_left'
    ? (patternNode.namedChildren[0]?.text ?? patternNode.text)
    : (patternNode?.text ?? '');

  return {
    name: name.split(/\s/)[0] ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractTypeDecl(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'upper_case_identifier');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractPort(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.namedChildren.find(c => c.type === 'lower_case_identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'port',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: node.text.split('\n')[0]?.trim() ?? '',
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.namedChildren[0];
  if (!fnNode) return null;
  // Find enclosing value_declaration
  let callerSymbol = '';
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'value_declaration') {
      const pat = current.childForFieldName('pattern') ?? current.namedChildren[0];
      if (pat?.type === 'function_declaration_left') {
        callerSymbol = pat.namedChildren[0]?.text ?? '';
      } else {
        callerSymbol = pat?.text.split(/\s/)[0] ?? '';
      }
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

function extractImport(node: Parser.SyntaxNode): RawImport {
  // `import Html exposing (div, text)`
  const moduleNode = node.childForFieldName('moduleName') ??
    node.namedChildren.find(c => c.type === 'upper_case_qid');
  const source = moduleNode?.text ?? '';

  const importedNames: string[] = [];
  const exposingList = node.namedChildren.find(c => c.type === 'exposing_list');
  if (exposingList) {
    for (const child of exposingList.namedChildren) {
      if (child.type === 'exposed_value' || child.type === 'exposed_type') {
        importedNames.push(child.text);
      }
    }
  }

  return { source, importedNames };
}
