/**
 * @module indexer/extractors/haskell
 *
 * Haskell language extractor.  Extracts function declarations, type/data/newtype/
 * class declarations, and import declarations.
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

// ─── HaskellExtractor ─────────────────────────────────────────────────────────

export class HaskellExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function':
          result.symbols.push(extractFunction(node));
          break;
        case 'signature':
          // Type signature for a function — extract the name
          result.symbols.push(extractSignature(node));
          break;
        case 'adt':
        case 'data_type':
        case 'newtype':
        case 'type_alias':
          result.symbols.push(extractDataType(node, 'type'));
          break;
        case 'class':
          result.symbols.push(extractDataType(node, 'class'));
          break;
        case 'instance':
          result.symbols.push(extractInstance(node));
          break;
        case 'import':
          result.imports.push(extractImport(node));
          break;
        case 'apply': {
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
  // The function name is typically the first named child (a `variable`)
  const nameNode = node.childForFieldName('name') ?? node.namedChildren[0];
  return {
    name: nameNode?.text ?? '',
    kind: 'function',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractSignature(node: Parser.SyntaxNode): RawSymbol {
  const nameNode = node.childForFieldName('name') ?? node.namedChildren[0];
  return {
    name: nameNode?.text ?? '',
    kind: 'signature',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: node.text.split('\n')[0]?.trim() ?? '',
  };
}

function extractDataType(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name') ??
    node.namedChildren.find(c => c.type === 'type' || c.type === 'name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractInstance(node: Parser.SyntaxNode): RawSymbol {
  return {
    name: node.text.split('\n')[0]?.replace(/\bwhere\b.*/, '').trim() ?? '',
    kind: 'instance',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  // function application: (fn arg1 arg2)
  const fnNode = node.namedChildren[0];
  if (!fnNode) return null;
  // Find enclosing function
  let callerSymbol = '';
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === 'function') {
      const nameNode = current.childForFieldName('name') ?? current.namedChildren[0];
      callerSymbol = nameNode?.text ?? '';
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
  // `import qualified Data.Map as Map`
  const moduleNode = node.childForFieldName('module') ??
    node.namedChildren.find(c => c.type === 'module');
  const source = moduleNode?.text ?? '';

  const importedNames: string[] = [];
  // Look for an import list
  const importList = node.namedChildren.find(c => c.type === 'import_list');
  if (importList) {
    for (const child of importList.namedChildren) {
      if (child.type === 'import_item' || child.type === 'variable' || child.type === 'type') {
        importedNames.push(child.text);
      }
    }
  }

  return { source, importedNames };
}
