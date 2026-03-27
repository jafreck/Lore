/**
 * @module indexer/extractors/javascript
 *
 * P1 JavaScript language extractor.  Extracts function declarations, class
 * declarations, arrow/function expressions assigned to variables, and
 * import statements and require() calls.
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

const JS_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'class_declaration',
] as const;

// ─── JavaScriptExtractor ──────────────────────────────────────────────────────

export class JavaScriptExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
        case 'generator_function_declaration':
          result.symbols.push(extractNamedDecl(node, 'function'));
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedDecl(node, 'class'));
          extractJsClassMembers(node, result);
          break;
        case 'lexical_declaration':
        case 'variable_declaration': {
          const syms = maybeExtractArrowOrFunctionExpr(node);
          for (const sym of syms) result.symbols.push(sym);
          break;
        }
        case 'import_statement':
          result.imports.push(extractImport(node));
          break;
        case 'call_expression': {
          const imp = maybeExtractRequire(node);
          if (imp) result.imports.push(imp);
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

function extractNamedDecl(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
    parentName: findEnclosingSymbolName(node, JS_SYMBOL_NODE_TYPES) || undefined,
  };
}

function extractJsClassMembers(classNode: Parser.SyntaxNode, result: ExtractionResult): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  const className = classNode.childForFieldName('name')?.text;
  for (const child of body.namedChildren) {
    if (child.type === 'method_definition') {
      const nameNode = child.childForFieldName('name');
      const name = nameNode?.text ?? '';
      if (!name) continue;
      const kind = name === 'constructor' ? 'constructor' : 'method';
      result.symbols.push({
        name,
        kind,
        startLine: child.startPosition.row,
        endLine: child.endPosition.row,
        signature: nodeSignature(child),
        parentName: className || undefined,
      });
    }
  }
}

function maybeExtractArrowOrFunctionExpr(
  node: Parser.SyntaxNode,
): RawSymbol[] {
  const results: RawSymbol[] = [];
  for (const declarator of node.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode || !valueNode) continue;
    if (
      valueNode.type === 'arrow_function' ||
      valueNode.type === 'function_expression' ||
      valueNode.type === 'generator_function'
    ) {
      results.push({
        name: nameNode.text,
        kind: 'function',
        startLine: declarator.startPosition.row,
        endLine: declarator.endPosition.row,
        signature: nodeSignature(declarator),
      });
    }
  }
  return results;
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  const sourceNode = node.childForFieldName('source');
  const source = stripQuotes(sourceNode?.text ?? '');
  const importedNames: string[] = [];

  const clauseNode = node.childForFieldName('import_clause') ?? null;
  if (clauseNode) {
    collectImportNames(clauseNode, importedNames);
  }

  return { source, importedNames };
}

function collectImportNames(node: Parser.SyntaxNode, out: string[]): void {
  switch (node.type) {
    case 'identifier':
      out.push(node.text);
      break;
    case 'namespace_import': {
      const alias = node.namedChildren[0];
      if (alias) out.push(`* as ${alias.text}`);
      break;
    }
    case 'named_imports':
      for (const spec of node.namedChildren) {
        if (spec.type === 'import_specifier') {
          const name = spec.childForFieldName('name');
          if (name) out.push(name.text);
        }
      }
      break;
    default:
      for (const child of node.namedChildren) {
        collectImportNames(child, out);
      }
  }
}

/**
 * Detects `require('...')` and `require("...")` call expressions.
 */
function maybeExtractRequire(node: Parser.SyntaxNode): RawImport | null {
  const fnNode = node.childForFieldName('function');
  if (fnNode?.type !== 'identifier' || fnNode.text !== 'require') return null;

  const argsNode = node.childForFieldName('arguments');
  if (!argsNode) return null;

  const firstArg = argsNode.namedChildren[0];
  if (
    !firstArg ||
    (firstArg.type !== 'string' && firstArg.type !== 'template_string')
  ) {
    return null;
  }

  const source = stripQuotes(firstArg.text);
  return { source, importedNames: [] };
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, JS_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

