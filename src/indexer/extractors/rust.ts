/**
 * @module indexer/extractors/rust
 *
 * P0 Rust language extractor.  Extracts fn items, struct/enum/trait/impl
 * declarations, and use declarations.
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

const RUST_SYMBOL_NODE_TYPES = [
  'function_item',
  'impl_item',
] as const;

// ─── RustExtractor ────────────────────────────────────────────────────────────

export class RustExtractor implements SymbolExtractor {
  extract(tree: Parser.Tree, _source: string, _filePath: string): ExtractionResult {
    const result = emptyResult();

    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_item':
          result.symbols.push(extractItem(node, 'function'));
          extractRustFunctionTypeRefs(node, result.typeRefs);
          break;
        case 'struct_item':
          result.symbols.push(extractItem(node, 'struct'));
          extractRustStructFieldTypeRefs(node, result.typeRefs);
          break;
        case 'enum_item':
          result.symbols.push(extractItem(node, 'enum'));
          break;
        case 'trait_item':
          result.symbols.push(extractItem(node, 'trait'));
          break;
        case 'impl_item': {
          result.symbols.push(extractImpl(node));
          extractImplRelationships(node, result.relationships, result.typeRefs);
          break;
        }
        case 'use_declaration':
          result.imports.push(extractUse(node));
          break;
        case 'call_expression': {
          const ref = extractCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'macro_invocation': {
          const ref = extractMacroCallRef(node);
          if (ref) result.callRefs.push(ref);
          break;
        }
        case 'let_declaration': {
          extractRustLetTypeRef(node, result.typeRefs);
          break;
        }
        case 'type_cast_expression': {
          extractRustCastTypeRef(node, result.typeRefs);
          break;
        }
      }
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractItem(node: Parser.SyntaxNode, kind: string): RawSymbol {
  const nameNode = node.childForFieldName('name');
  return {
    name: nameNode?.text ?? '',
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractImpl(node: Parser.SyntaxNode): RawSymbol {
  // impl Trait for Type  — use the `type` field as the name
  const typeNode = node.childForFieldName('type');
  const traitNode = node.childForFieldName('trait');
  const name = traitNode
    ? `${traitNode.text} for ${typeNode?.text ?? ''}`
    : (typeNode?.text ?? '');
  return {
    name,
    kind: 'impl',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    signature: nodeSignature(node),
  };
}

function extractUse(node: Parser.SyntaxNode): RawImport {
  const argNode = node.childForFieldName('argument');
  const source = argNode?.text ?? node.text;

  // Collect leaf identifiers as imported names (best-effort)
  const importedNames: string[] = [];
  if (argNode) {
    collectLeafIdentifiers(argNode, importedNames);
  }

  return { source, importedNames };
}

function extractCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const fnNode = node.childForFieldName('function');
  if (!fnNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, RUST_SYMBOL_NODE_TYPES),
    calleeRaw: fnNode.text,
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function extractMacroCallRef(node: Parser.SyntaxNode): RawCallRef | null {
  const macroNode = node.childForFieldName('macro');
  if (!macroNode) return null;
  return {
    callerSymbol: findEnclosingSymbolName(node, RUST_SYMBOL_NODE_TYPES),
    calleeRaw: macroNode.text + '!',
    line: node.startPosition.row,
    character: node.startPosition.column,
  };
}

function collectLeafIdentifiers(
  node: Parser.SyntaxNode,
  out: string[],
): void {
  if (node.type === 'identifier' && node.namedChildCount === 0) {
    out.push(node.text);
    return;
  }
  for (const child of node.namedChildren) {
    collectLeafIdentifiers(child, out);
  }
}

// ─── Relationship extraction ──────────────────────────────────────────────────

function extractImplRelationships(
  implNode: Parser.SyntaxNode,
  relationships: RawRelationship[],
  typeRefs: RawTypeRef[],
): void {
  const traitNode = implNode.childForFieldName('trait');
  const typeNode = implNode.childForFieldName('type');
  if (!traitNode || !typeNode) return;
  const typeName = typeNode.text;
  const traitName = traitNode.text;
  relationships.push({
    kind: 'implements',
    fromSymbol: `${traitName} for ${typeName}`,
    toSymbol: traitName,
    line: traitNode.startPosition.row,
    character: traitNode.startPosition.column,
  });
  typeRefs.push({
    enclosingSymbol: `${traitName} for ${typeName}`,
    typeRaw: traitName,
    refKind: 'bound',
    line: traitNode.startPosition.row,
    character: traitNode.startPosition.column,
  });
}

// ─── Type-ref extraction ──────────────────────────────────────────────────────

function extractRustTypeName(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier' || typeNode.type === 'scoped_type_identifier') return typeNode.text;
  if (typeNode.type === 'generic_type') return typeNode.text;
  if (typeNode.type === 'reference_type') {
    const inner = typeNode.namedChildren.find(c => c.type !== 'mutable_specifier' && c.type !== 'lifetime');
    return inner ? extractRustTypeName(inner) : null;
  }
  return null;
}

const emitRustTypeRef = createTypeRefEmitter({
  extractTypeName: extractRustTypeName,
  genericNodeType: 'generic_type',
  argListNodeType: 'type_arguments',
});

function extractRustFunctionTypeRefs(funcNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const funcName = funcNode.childForFieldName('name')?.text ?? '';
  // Parameters
  const params = funcNode.childForFieldName('parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (param.type === 'parameter' || param.type === 'self_parameter') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) emitRustTypeRef(refs, funcName, typeNode, 'parameter');
      }
    }
  }
  // Return type
  const returnType = funcNode.childForFieldName('return_type');
  if (returnType) {
    emitRustTypeRef(refs, funcName, returnType, 'return');
  }
}

function extractRustStructFieldTypeRefs(structNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const structName = structNode.childForFieldName('name')?.text ?? '';
  const body = structNode.childForFieldName('body');
  if (!body) return;
  for (const child of body.namedChildren) {
    if (child.type === 'field_declaration') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) emitRustTypeRef(refs, structName, typeNode, 'field');
    }
  }
}

function extractRustLetTypeRef(letNode: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  const typeNode = letNode.childForFieldName('type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(letNode, RUST_SYMBOL_NODE_TYPES);
  emitRustTypeRef(refs, enclosing, typeNode, 'variable');
}

function extractRustCastTypeRef(node: Parser.SyntaxNode, refs: RawTypeRef[]): void {
  // expr as Type
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const enclosing = findEnclosingSymbolName(node, RUST_SYMBOL_NODE_TYPES);
  emitRustTypeRef(refs, enclosing, typeNode, 'cast');
}
