/**
 * @module indexer/extractors/objc
 *
 * Objective-C language extractor.  Extracts class interfaces, class implementations,
 * protocol declarations, method declarations, and #import directives.
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

const OBJC_SYMBOL_NODE_TYPES = [
  'method_declaration',
  'class_method_declaration',
  'instance_method_declaration',
] as const;

// ─── ObjcExtractor ───────────────────────────────────────────────────────────

export class ObjcExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'class_interface':
          result.symbols.push(extractClassInterface(node));
          break;
        case 'class_implementation':
          result.symbols.push(extractClassImpl(node));
          break;
        case 'protocol_declaration':
          result.symbols.push(extractProtocol(node));
          break;
        case 'method_declaration':
        case 'class_method_declaration':
        case 'instance_method_declaration':
          result.symbols.push(extractMethod(node));
          break;
        case 'category_interface':
          result.symbols.push(extractCategory(node));
          break;
        case 'preproc_import':
          result.imports.push(extractPreprocessorImport(node));
          break;
        case 'module_import':
          result.imports.push(extractModuleImport(node));
          break;
        case 'message_expression': {
          const ref = extractMessageCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
      }
    }

    // Also extract #import directives via regex for preprocessor includes
    extractHashImports(source, result);

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractMessageCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // [receiver selector:arg] — extract selector as callee
  const selectorNode = node.childForFieldName('selector') ??
    node.namedChildren.find(c => c.type === 'selector' || c.type === 'keyword_selector');
  const receiverNode = node.childForFieldName('receiver') ?? node.namedChildren[0];
  if (!selectorNode && !receiverNode) return null;
  const callee = selectorNode?.text ?? receiverNode?.text ?? '';
  // Find enclosing method
  let callerSymbol = '';
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (OBJC_SYMBOL_NODE_TYPES.includes(current.type as typeof OBJC_SYMBOL_NODE_TYPES[number])) {
      const sel = current.childForFieldName('selector') ??
        current.namedChildren.find(c => c.type === 'selector' || c.type === 'keyword_selector');
      callerSymbol = sel?.text ?? '';
      break;
    }
    current = current.parent;
  }
  return {
    callerSymbol,
    calleeRaw: callee,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractClassInterface(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'class',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractClassImpl(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'impl',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractProtocol(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'interface',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractMethod(node: Parser.SyntaxNode): RawSymbol {
  const selectorNode = node.childForFieldName('selector') ??
    node.namedChildren.find(c => c.type === 'selector' || c.type === 'keyword_selector');
  return {
    name: selectorNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCategory(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'identifier');
  return {
    name: nameNode?.text ?? '',
    kind: 'category',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractPreprocessorImport(node: Parser.SyntaxNode): RawImport {
  const pathNode = node.childForFieldName('path') ??
    node.namedChildren.find(c => c.type === 'string_literal' || c.type === 'system_lib_string');
  const source = pathNode?.text.replace(/^["<]|[">]$/g, '') ?? '';
  return { source, importedNames: [] };
}

function extractModuleImport(node: Parser.SyntaxNode): RawImport {
  // @import Foundation;
  const text = node.text
    .replace(/^@import\s+/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();
  return { source: text, importedNames: [] };
}

/**
 * Fallback: scan source for `#import "..."` and `#import <...>` directives
 * that might not be captured as tree-sitter nodes.
 */
function extractHashImports(source: string, result: ExtractionResult): void {
  const re = /#import\s+["<]([^">]+)[">]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const src = match[1]!;
    // Avoid duplicates
    if (!result.imports.some(i => i.source === src)) {
      result.imports.push({ source: src, importedNames: [] });
    }
  }
}
