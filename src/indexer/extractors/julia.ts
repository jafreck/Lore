/**
 * @module indexer/extractors/julia
 *
 * Julia language extractor.  Extracts function definitions, struct/abstract type
 * definitions, module definitions, and import/using statements.
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

// ─── JuliaExtractor ──────────────────────────────────────────────────────────

export class JuliaExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'short_function_definition':
          result.symbols.push(extractShortFunction(node));
          break;
        case 'struct_definition':
          result.symbols.push(extractNamedNode(node, 'struct'));
          break;
        case 'abstract_definition':
          result.symbols.push(extractNamedNode(node, 'type'));
          break;
        case 'module_definition':
          result.symbols.push(extractNamedNode(node, 'module'));
          break;
        case 'macro_definition':
          result.symbols.push(extractNamedNode(node, 'macro'));
          break;
        case 'import_statement':
          result.imports.push(extractImport(node));
          break;
        case 'using_statement':
          result.imports.push(extractImport(node));
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

function extractShortFunction(node: Parser.SyntaxNode): RawSymbol {
  // `f(x) = x + 1`
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: node.text.split('\n')[0]?.trim() ?? '',
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

function extractImport(node: Parser.SyntaxNode): RawImport {
  // `import Foo` or `using Foo: bar, baz` or `import Foo.Bar`
  const text = node.text
    .replace(/^(import|using)\s+/, '')
    .trim();

  const colonIdx = text.indexOf(':');
  let source: string;
  let importedNames: string[];

  if (colonIdx !== -1) {
    source = text.slice(0, colonIdx).trim();
    importedNames = text.slice(colonIdx + 1).split(',').map(s => s.trim()).filter(Boolean);
  } else {
    source = text;
    const parts = text.split('.');
    importedNames = [parts[parts.length - 1] ?? ''];
  }

  return { source, importedNames };
}
