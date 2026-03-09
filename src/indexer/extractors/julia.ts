/**
 * @module indexer/extractors/julia
 *
 * Julia language extractor.  Extracts function definitions, struct/abstract type
 * definitions, module definitions, and import/using statements.
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
  findFirst,
  nodeSignature,
  walk,
} from './types.js';

const JULIA_SYMBOL_NODE_TYPES = [
  'function_definition',
  'short_function_definition',
  'struct_definition',
  'abstract_definition',
  'module_definition',
  'macro_definition',
] as const;

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
  // tree-sitter-julia puts the name inside a `signature` child, not a
  // direct `name` field.  Drill in: signature → call_expression → identifier.
  let nameNode = node.childForFieldName('name');
  if (!nameNode) {
    const sig = node.namedChildren.find(c => c.type === 'signature');
    if (sig) {
      nameNode = findFirst(sig, 'identifier');
    }
  }
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
  // tree-sitter-julia may nest the name inside a `type_head` child (structs)
  // rather than exposing a top-level `name` field.
  let nameNode = node.childForFieldName('name');
  if (!nameNode) {
    const typeHead = node.namedChildren.find(c => c.type === 'type_head');
    if (typeHead) {
      nameNode = findFirst(typeHead, 'identifier');
    }
  }
  if (!nameNode) {
    nameNode = findFirst(node, 'identifier');
  }
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // Julia call_expression: first child is the callee
  const fnNode = node.namedChildren[0];
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, JULIA_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
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
