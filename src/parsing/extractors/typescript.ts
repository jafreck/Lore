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
  type RawTypeRef,
  type TypeRefKind,
  type SymbolExtractor,
  createTypeRefEmitter,
  emptyResult,
  findEnclosingSymbolName,
  nodeSignature,
  walk,
} from './types.js';

const TS_SYMBOL_NODE_TYPES = [
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'method_definition',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
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
          extractTsFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'class_declaration':
          result.symbols.push(extractNamedDecl(node, 'class', source, declarationMode));
          result.relationships.push(...extractClassInheritance(node));
          extractTsClassInheritanceTypeRefs(node, result.typeRefs);
          extractTsClassFieldTypeRefs(node, result.typeRefs);
          extractTsClassMethodTypeRefs(node, result.typeRefs);
          // Extract class methods and constructors as separate symbols
          extractClassMembers(node, source, declarationMode, result);
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedDecl(node, 'interface', source, declarationMode));
          extractTsInterfaceTypeRefs(node, result.typeRefs);
          break;
        case 'type_alias_declaration':
          result.symbols.push(extractNamedDecl(node, 'type', source, declarationMode));
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedDecl(node, 'enum', source, declarationMode));
          break;
        case 'lexical_declaration':
        case 'variable_declaration': {
          // Handle: const foo = () => {} or const foo = function() {}
          const sym = maybeExtractArrowOrFunctionExpr(node, source, declarationMode);
          if (sym) result.symbols.push(sym);
          extractTsVariableTypeRefs(node, result.typeRefs);
          break;
        }
        case 'import_statement':
          result.imports.push(extractImport(node));
          break;
        case 'call_expression': {
          // Dynamic import(): import('./module') — treat as an import edge
          const dynImport = maybeDynamicImport(node);
          if (dynImport) {
            result.imports.push(dynImport);
          }
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'as_expression': {
          extractTsCastTypeRef(node, result.typeRefs);
          break;
        }
        case 'type_assertion': {
          extractTsTypeAssertionRef(node, result.typeRefs);
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
      character: target.startPosition.column,
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

/**
 * Extract class methods and constructors as separate symbols.
 *
 * Gap 1: Constructors were not extracted at all.
 * Gap 2: Methods inside classes were not extracted as symbols
 *        (only used for type-ref extraction and caller containment).
 */
function extractClassMembers(
  classNode: Parser.SyntaxNode,
  source: string,
  declarationMode: boolean,
  result: ExtractionResult,
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;

  for (const child of body.namedChildren) {
    if (child.type === 'method_definition') {
      const nameNode = child.childForFieldName('name');
      const name = nameNode?.text ?? '';
      if (!name) continue;

      // Distinguish constructors from methods
      const kind = name === 'constructor' ? 'constructor' : 'method';
      const docComment = declarationMode ? extractLeadingDocComment(child, source) : undefined;

      result.symbols.push({
        name,
        kind,
        startLine: child.startPosition.row,
        endLine: child.endPosition.row,
        signature: nodeSignature(child),
        ...(docComment ? { docComment } : {}),
        astNode: child,
      });
    }
  }
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

/** Extract a dynamic `import('...')` as an import edge, or null if not one. */
function maybeDynamicImport(node: Parser.SyntaxNode): RawImport | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode || fnNode.type !== 'import') return null;
  const argsNode = node.childForFieldName('arguments');
  const firstArg = argsNode?.namedChildren[0];
  if (!firstArg || firstArg.type !== 'string') return null;
  return { source: stripQuotes(firstArg.text), importedNames: [] };
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

// ─── Type-ref extraction ──────────────────────────────────────────────────────

function extractTsTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'generic_type') return typeNode.text;
  if (typeNode.type === 'nested_type_identifier') return typeNode.text;
  if (typeNode.type === 'array_type') {
    const element = typeNode.namedChildren[0];
    return element ? extractTsTypeName(element) : null;
  }
  if (typeNode.type === 'union_type' || typeNode.type === 'intersection_type') {
    // Don't extract entire union/intersection as a type ref; each constituent is handled separately
    return null;
  }
  return null;
}

const emitTsTypeRef = createTypeRefEmitter({
  extractTypeName: extractTsTypeName,
  genericNodeType: 'generic_type',
  argListNodeType: 'type_arguments',
  recurseIntoTypes: ['union_type', 'intersection_type'],
});

function extractTsFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = funcNode.childForFieldName('name')?.text ?? '';
  // Parameters
  const params = funcNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'required_parameter' || param.type === 'optional_parameter' || param.type === 'rest_parameter') {
        const typeAnnotation = param.childForFieldName('type');
        if (typeAnnotation) {
          const actualType = typeAnnotation.namedChildren[0];
          if (actualType) emitTsTypeRef(refs, funcName, actualType, 'parameter');
        }
      }
    }
  }
  // Return type
  const returnType = funcNode.childForFieldName('return_type');
  if (returnType) {
    const actualType = returnType.namedChildren[0];
    if (actualType) emitTsTypeRef(refs, funcName, actualType, 'return');
  }
}

function extractTsClassInheritanceTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ?? '';
  if (!className) return;
  const heritageNode = classNode.namedChildren.find(c => c.type === 'class_heritage');
  if (!heritageNode) return;
  // extends clause
  const extendsClause = heritageNode.namedChildren.find(c => c.type === 'extends_clause');
  if (extendsClause) {
    const target = extendsClause.namedChildren[0];
    if (target) {
      refs.push({ enclosingSymbol: className, typeRaw: target.text, refKind: 'bound', line: extendsClause.startPosition.row, character: extendsClause.startPosition.column });
    }
  }
  // implements clause
  const implementsClause = heritageNode.namedChildren.find(c => c.type === 'implements_clause');
  if (implementsClause) {
    for (const child of implementsClause.namedChildren) {
      refs.push({ enclosingSymbol: className, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
    }
  }
}

function extractTsClassFieldTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ?? '';
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'public_field_definition' || child.type === 'property_declaration') {
      const typeAnnotation = child.childForFieldName('type');
      if (typeAnnotation) {
        const actualType = typeAnnotation.namedChildren[0];
        if (actualType) emitTsTypeRef(refs, className, actualType, 'field');
      }
    }
  }
}

function extractTsClassMethodTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'method_definition') {
      extractTsFunctionTypeRefs(child, refs);
    }
  }
}

function extractTsInterfaceTypeRefs(ifaceNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const name = ifaceNode.childForFieldName('name')?.text ?? '';
  // Interface extends clause: interface Foo extends Bar, Baz
  const heritageNode = ifaceNode.namedChildren.find(c => c.type === 'extends_type_clause');
  if (heritageNode) {
    for (const child of heritageNode.namedChildren) {
      if (child.type === 'type_identifier' || child.type === 'generic_type' || child.type === 'nested_type_identifier') {
        refs.push({ enclosingSymbol: name, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
      }
    }
  }
  const body = ifaceNode.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'property_signature') {
      const typeAnnotation = child.childForFieldName('type');
      if (typeAnnotation) {
        const actualType = typeAnnotation.namedChildren[0];
        if (actualType) emitTsTypeRef(refs, name, actualType, 'field');
      }
    }
    if (child.type === 'method_signature') {
      const methodName = child.childForFieldName('name')?.text ?? name;
      const params = child.childForFieldName('parameters');
      if (params) {
        for (const param of params.namedChildren) {
          const typeAnnotation = param.childForFieldName('type');
          if (typeAnnotation) {
            const actualType = typeAnnotation.namedChildren[0];
            if (actualType) emitTsTypeRef(refs, methodName, actualType, 'parameter');
          }
        }
      }
      const returnType = child.childForFieldName('return_type');
      if (returnType) {
        const actualType = returnType.namedChildren[0];
        if (actualType) emitTsTypeRef(refs, methodName, actualType, 'return');
      }
    }
  }
}

function extractTsVariableTypeRefs(declNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  for (const child of declNode.namedChildren) {
    if (child.type !== 'variable_declarator') continue;
    const typeAnnotation = child.childForFieldName('type');
    if (!typeAnnotation) continue;
    const enclosing = findEnclosingSymbolName(child, TS_SYMBOL_NODE_TYPES);
    const actualType = typeAnnotation.namedChildren[0];
    if (actualType) emitTsTypeRef(refs, enclosing, actualType, 'variable');
  }
}

function extractTsCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // expr as Type
  const typeNode = node.namedChildren.find(c =>
    c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'nested_type_identifier');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, TS_SYMBOL_NODE_TYPES);
  emitTsTypeRef(refs, enclosing, typeNode, 'cast');
}

function extractTsTypeAssertionRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // <Type>expr — type field returns the type directly (not wrapped in type_annotation)
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, TS_SYMBOL_NODE_TYPES);
  emitTsTypeRef(refs, enclosing, typeNode, 'cast');
}
