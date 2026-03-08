/**
 * @module indexer/extractors/typescript
 *
 * P1 TypeScript language extractor.  Extracts function declarations, class
 * declarations, interface declarations, type alias declarations, arrow
 * functions assigned to const variables, and import statements.
 */

import type Parser from 'tree-sitter';
import {
  type ComplexityNodeTypes,
  type ExtractionResult,
  type RawCallRef,
  type RawImport,
  type RawRelationship,
  type RawSymbol,
  type SymbolExtractor,
  emptyResult,
  findEnclosingSymbolName,
  nodeSignature,
  walk,
} from './types.js';

const TS_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'class_declaration',
] as const;

export const TYPESCRIPT_COMPLEXITY_NODE_TYPES: ComplexityNodeTypes = {
  parameterListTypes: ['formal_parameters'],
  parameterTypes: ['required_parameter', 'optional_parameter', 'rest_parameter'],
  decisionTypes: [
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'switch_case',
    'conditional_expression',
  ],
  nestingTypes: [
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'catch_clause',
    'conditional_expression',
  ],
};

// ─── TypeScriptExtractor ──────────────────────────────────────────────────────

export class TypeScriptExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, source: string, filePath: string): ExtractionResult {
    const result = emptyResult();
    const declarationMode = filePath.endsWith('.d.ts');

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_declaration':
        case 'generator_function_declaration':
        case 'function_signature':
          result.symbols.push(extractNamedDecl(node, 'function', source, declarationMode));
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedDecl(node, 'class', source, declarationMode));
          result.relationships.push(...extractClassInheritance(node));
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedDecl(node, 'interface', source, declarationMode));
          break;
        case 'type_alias_declaration':
          result.symbols.push(extractNamedDecl(node, 'type', source, declarationMode));
          break;
        case 'lexical_declaration':
        case 'variable_declaration': {
          // Handle: const foo = () => {} or const foo = function() {}
          const sym = maybeExtractArrowOrFunctionExpr(node, source, declarationMode);
          if (sym) result.symbols.push(sym);
          break;
        }
        case 'import_statement':
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

function extractClassInheritance(node: Parser.SyntaxNode): RawRelationship[] {
  const nameNode = node.childForFieldName('name');
  const heritageNode = node.namedChildren.find((child) => child.type === 'class_heritage');
  if (!nameNode || !heritageNode) return [];
  const extendsClause = heritageNode.namedChildren.find((child) => child.type === 'extends_clause');
  if (!extendsClause) return [];
  const target = extendsClause.namedChildren[0];
  if (!target) return [];
  return [
    {
      kind: 'extends',
      fromSymbol: nameNode.text,
      toSymbol: target.text,
      line: extendsClause.startPosition.row,
    },
  ];
}

function extractNamedDecl(
  node: Parser.SyntaxNode,
  kind: string,
  source: string,
  declarationMode: boolean,
): RawSymbol {
  const nameNode = node.childForFieldName('name');
  const docComment = declarationMode ? extractLeadingDocComment(node, source) : undefined;
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
    ...(docComment ? { docComment } : {}),
    ...(declarationMode && isNodeExported(node) ? { isExported: true } : {}),
    astNode: node,
  };
}

function maybeExtractArrowOrFunctionExpr(
  node: Parser.SyntaxNode,
  source: string,
  declarationMode: boolean,
): RawSymbol | null {
  // Look for: const/let/var <name> = <arrow_function | function_expression>
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
      const docComment = declarationMode ? extractLeadingDocComment(node, source) : undefined;
      return {
        name: nameNode.text,
        kind: 'function',
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        signature: nodeSignature(node),
        ...(docComment ? { docComment } : {}),
        ...(declarationMode && isNodeExported(node) ? { isExported: true } : {}),
        astNode: valueNode,
      };
    }
  }
  return null;
}

function isNodeExported(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (current.type === 'export_statement') return true;
    if (current.children.some((child) => child.type === 'export')) return true;
    if (current.text.trimStart().startsWith('export ')) return true;
    current = current.parent;
  }
  return false;
}

function extractLeadingDocComment(node: Parser.SyntaxNode, source: string): string | undefined {
  let anchor = node;
  while (anchor.parent && (anchor.parent.type === 'ambient_declaration' || anchor.parent.type === 'export_statement')) {
    anchor = anchor.parent;
  }
  const beforeNode = source.slice(0, anchor.startIndex);
  const jsDoc = beforeNode.match(/\/\*\*[\s\S]*?\*\/\s*$/);
  return jsDoc ? jsDoc[0].trim() : undefined;
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  // import { a, b } from 'module'
  // import defaultExport from 'module'
  // import * as ns from 'module'
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
      // default import
      out.push(node.text);
      break;
    case 'namespace_import': {
      // import * as ns
      const alias = node.namedChildren[0];
      if (alias) out.push(`* as ${alias.text}`);
      break;
    }
    case 'named_imports':
      // { a, b as c }
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

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, TS_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}
