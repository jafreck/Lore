/**
 * @module indexer/extractors/java
 *
 * P2/P3 Java language extractor.  Extracts class declarations, interface
 * declarations, method declarations, and import declarations.
 */

import type Parser from 'tree-sitter';
import {
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

const JAVA_SYMBOL_NODE_TYPES = [
  'method_declaration',
  'constructor_declaration',
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
] as const;

// ─── JavaExtractor ────────────────────────────────────────────────────────────

export class JavaExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'class_declaration':
          result.symbols.push(extractNamedNode(node, 'class'));
          extractJavaClassRelationships(node, result.relationships, result.typeRefs);
          extractJavaFieldTypeRefs(node, result.typeRefs);
          break;
        case 'interface_declaration':
          result.symbols.push(extractNamedNode(node, 'interface'));
          extractJavaInterfaceRelationships(node, result.relationships, result.typeRefs);
          break;
        case 'enum_declaration':
          result.symbols.push(extractNamedNode(node, 'enum'));
          break;
        case 'method_declaration':
          result.symbols.push(extractMethod(node));
          extractJavaMethodTypeRefs(node, result.typeRefs);
          break;
        case 'constructor_declaration':
          result.symbols.push(extractMethod(node));
          extractJavaMethodTypeRefs(node, result.typeRefs);
          break;
        case 'import_declaration':
          result.imports.push(extractImport(node));
          break;
        case 'method_invocation': {
          const ref = extractMethodCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'object_creation_expression': {
          const ref = extractNewCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'local_variable_declaration': {
          extractJavaLocalVarTypeRefs(node, result.typeRefs);
          break;
        }
        case 'cast_expression': {
          extractJavaCastTypeRef(node, result.typeRefs);
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

function extractMethodCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const objectNode = node.childForFieldName('object');
  const calleeRaw = objectNode ? `${objectNode.text}.${nameNode.text}` : nameNode.text;
  return {
    callerSymbol: findEnclosingSymbolName(node, JAVA_SYMBOL_NODE_TYPES),
    calleeRaw,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractNewCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, JAVA_SYMBOL_NODE_TYPES),
    calleeRaw: `new ${typeNode.text}`,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractImport(node: Parser.SyntaxNode): RawImport {
  // import a.b.C;  or  import static a.b.C.method;
  // The raw text is like "import a.b.C;" — strip keyword and semicolon.
  const text = node.text
    .replace(/^import\s+(static\s+)?/, '')
    .replace(/\s*;?\s*$/, '')
    .trim();

  // Extract the simple name as the last segment (or '*' for wildcard)
  const parts = text.split('.');
  const lastName = parts[parts.length - 1] ?? '';
  const importedNames = lastName === '*' ? [] : [lastName];

  return { source: text, importedNames };
}

// ─── Relationship extraction ──────────────────────────────────────────────────

function extractJavaClassRelationships(
  classNode: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const className = classNode.childForFieldName('name')?.text ?? '';
  if (!className) return;
  // superclass
  const superclass = classNode.childForFieldName('superclass');
  if (superclass) {
    // The superclass node wraps the type — look at its first named child
    const typeNode = superclass.namedChildren[0];
    if (typeNode) {
      relationships.push({ kind: 'extends', fromSymbol: className, toSymbol: typeNode.text, line: typeNode.startPosition.row, character: typeNode.startPosition.column });
      typeRefs.push({ enclosingSymbol: className, typeRaw: typeNode.text, refKind: 'bound', line: typeNode.startPosition.row, character: typeNode.startPosition.column });
    }
  }
  // super_interfaces
  const interfaces = classNode.childForFieldName('interfaces');
  if (interfaces) {
    // type_list children
    for (const child of interfaces.namedChildren) {
      if (child.type === 'type_list') {
        for (const iface of child.namedChildren) {
          relationships.push({ kind: 'implements', fromSymbol: className, toSymbol: iface.text, line: iface.startPosition.row, character: iface.startPosition.column });
          typeRefs.push({ enclosingSymbol: className, typeRaw: iface.text, refKind: 'bound', line: iface.startPosition.row, character: iface.startPosition.column });
        }
      } else {
        relationships.push({ kind: 'implements', fromSymbol: className, toSymbol: child.text, line: child.startPosition.row, character: child.startPosition.column });
        typeRefs.push({ enclosingSymbol: className, typeRaw: child.text, refKind: 'bound', line: child.startPosition.row, character: child.startPosition.column });
      }
    }
  }
}

function extractJavaInterfaceRelationships(
  ifaceNode: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const name = ifaceNode.childForFieldName('name')?.text ?? '';
  if (!name) return;
  const extendsNode = ifaceNode.namedChildren.find(c => c.type === 'extends_interfaces');
  if (!extendsNode) return;
  for (const child of extendsNode.namedChildren) {
    if (child.type === 'type_list') {
      for (const iface of child.namedChildren) {
        relationships.push({ kind: 'extends', fromSymbol: name, toSymbol: iface.text, line: iface.startPosition.row, character: iface.startPosition.column });
        typeRefs.push({ enclosingSymbol: name, typeRaw: iface.text, refKind: 'bound', line: iface.startPosition.row, character: iface.startPosition.column });
      }
    }
  }
}

// ─── Type-ref extraction ──────────────────────────────────────────────────────

function extractJavaTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'generic_type') return typeNode.text;
  if (typeNode.type === 'array_type') {
    const element = typeNode.childForFieldName('element');
    return element ? extractJavaTypeName(element) : null;
  }
  if (typeNode.type === 'scoped_type_identifier') return typeNode.text;
  return null;
}

const emitJavaTypeRef = createTypeRefEmitter({
  extractTypeName: extractJavaTypeName,
  genericNodeType: 'generic_type',
  argListNodeType: 'type_arguments',
});

function extractJavaMethodTypeRefs(methodNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const methodName = methodNode.childForFieldName('name')?.text ?? '';
  const returnType = methodNode.childForFieldName('type');
  if (returnType) emitJavaTypeRef(refs, methodName, returnType, 'return');
  const params = methodNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'formal_parameter' || param.type === 'spread_parameter') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) emitJavaTypeRef(refs, methodName, typeNode, 'parameter');
      }
    }
  }
}

function extractJavaFieldTypeRefs(classNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const className = classNode.childForFieldName('name')?.text ?? '';
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) emitJavaTypeRef(refs, className, typeNode, 'field');
    }
  }
}

function extractJavaLocalVarTypeRefs(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, JAVA_SYMBOL_NODE_TYPES);
  emitJavaTypeRef(refs, enclosing, typeNode, 'variable');
}

function extractJavaCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // (Type)expr
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, JAVA_SYMBOL_NODE_TYPES);
  emitJavaTypeRef(refs, enclosing, typeNode, 'cast');
}
