/**
 * @module indexer/extractors/scala
 *
 * Scala language extractor.  Extracts function definitions, class/trait/object
 * declarations, and import declarations.
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

const SCALA_SYMBOL_NODE_TYPES = [
  'function_definition',
  'class_definition',
  'trait_definition',
  'object_definition',
] as const;

// ─── ScalaExtractor ───────────────────────────────────────────────────────────

export class ScalaExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_definition':
          result.symbols.push(extractFunction(node));
          break;
        case 'val_definition':
        case 'var_definition':
          result.symbols.push(extractVal(node));
          break;
        case 'class_definition':
          result.symbols.push(extractNamedNode(node, 'class'));
          break;
        case 'trait_definition':
          result.symbols.push(extractNamedNode(node, 'trait'));
          break;
        case 'object_definition':
          result.symbols.push(extractNamedNode(node, 'class'));
          break;
        case 'import_declaration':
          result.imports.push(extractImport(node));
          break;
        case 'call_expression': {
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

function extractVal(node: Parser.SyntaxNode): RawSymbol {
  const patternNode = node.childForFieldName('pattern');
  return {
    name: patternNode?.text ?? '',
    kind: node.type === 'val_definition' ? 'val' : 'var',
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

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function') ?? node.namedChildren[0];
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, SCALA_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  // `import scala.collection.mutable.ArrayBuffer`
  // or `import scala.collection.mutable.{ArrayBuffer, ListBuffer}`
  const text = node.text
    .replace(/^import\s+/, '')
    .trim();

  const parts = text.split('.');
  const last = parts[parts.length - 1] ?? '';

  let importedNames: string[];
  if (last.startsWith('{') && last.endsWith('}')) {
    // Grouped imports: `{A, B, C}`
    importedNames = last.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  } else if (last === '_') {
    // Wildcard import
    importedNames = [];
  } else {
    importedNames = [last];
  }

  return { source: text, importedNames };
}
