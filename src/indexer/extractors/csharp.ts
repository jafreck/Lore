/**
 * @module indexer/extractors/csharp
 *
 * P2/P3 C# language extractor.  Extracts class declarations, interface
 * declarations, method declarations, and using directives.
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

const CS_SYMBOL_NODE_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'class_declaration',
] as const;

// ─── CSharpExtractor ──────────────────────────────────────────────────────────

export class CSharpExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          break;
        case 'struct_declaration':
          result.symbols.push(extractNamedNode(node, 'struct'));
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'method_declaration':
          result.symbols.push(extractMethod(node));
          break;
        case 'using_directive':
          result.imports.push(extractUsingDirective(node));
          break;
        case 'invocation_expression': {
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'object_creation_expression': {
          const ref = extractNewCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function extractMethod(node: Parser.SyntaxNode): RawSymbol {
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
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, CS_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractNewCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, CS_SYMBOL_NODE_TYPES),
    calleeRaw: `new ${typeNode.text}`,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractUsingDirective(node: Parser.SyntaxNode): RawImport {
  // `using System.Collections.Generic;` or `using alias = Namespace;`
  const text = node.text
    .replace(/^using\s+(static\s+)?/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();

  // If there is an alias (`alias = Namespace`), split on '='
  const eqIdx = text.indexOf('=');
  let source: string;
  let importedNames: string[];
  if (eqIdx !== -1) {
    source = text.slice(eqIdx + 1).trim();
    importedNames = [text.slice(0, eqIdx).trim()];
  } else {
    source = text;
    const parts = text.split('.');
    importedNames = [parts[parts.length - 1] ?? ''];
  }

  return { source, importedNames };
}
