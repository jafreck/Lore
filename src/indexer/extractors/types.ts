/**
 * @module indexer/extractors/types
 *
 * Shared types and the `SymbolExtractor` interface implemented by every
 * language-specific extractor.
 */

import type Parser from 'tree-sitter';

// ─── Raw data types ───────────────────────────────────────────────────────────

/** A symbol (function, class, struct, etc.) extracted from a source file. */
export interface DeclarationSurface {
  /** True when symbol is externally visible from the module/package boundary. */
  isPublic: boolean;
  /** True when symbol comes from a declaration-only API surface (no implementation body). */
  isDeclaration: boolean;
}

/** A symbol (function, class, struct, etc.) extracted from a source file. */
export interface RawSymbol {
  /** Simple name of the symbol (e.g. `myFunc`, `MyStruct`). */
  name: string;
  /** Kind of symbol (e.g. `'function'`, `'class'`, `'struct'`, `'enum'`, `'trait'`, `'impl'`, `'interface'`, `'type'`). */
  kind: string;
  /** 0-indexed start line in the source file. */
  startLine: number;
  /** 0-indexed start character in the source line (best-effort, optional). */
  startCharacter?: number;
  /** 0-indexed end line in the source file. */
  endLine: number;
  /** Textual signature of the symbol (declaration without body). */
  signature: string;
  /** Documentation comment immediately preceding the symbol, if extracted by the language extractor. */
  docComment?: string;
  /** True when declaration is exported from its module. */
  isExported?: boolean;
  /** Normalized declaration-surface metadata for dependency API indexing. */
  declarationSurface?: DeclarationSurface;
  /** Original AST node for the symbol declaration/expression, when available. */
  astNode?: Parser.SyntaxNode;
}

/** An import or include directive extracted from a source file. */
export interface RawImport {
  /** The raw import source string (module path, header name, etc.). */
  source: string;
  /** Resolved absolute or relative file path, if determinable at extraction time. */
  resolvedPath?: string;
  /** Named symbols imported from the source (empty for wildcard / side-effect imports). */
  importedNames: string[];
}

/**
 * Classification of how a call-site invokes its target.
 *
 * - `'direct'`   — ordinary named function/method call.
 * - `'indirect'` — call through a function pointer or `std::function`-like wrapper.
 * - `'macro'`    — invocation of a function-like macro.
 * - `'virtual'`  — virtual / dynamic-dispatch call (reserved for future use).
 */
export type CallKind = 'direct' | 'indirect' | 'macro' | 'virtual';

/** A call-site reference found in a source file. */
export interface RawCallRef {
  /** Name of the enclosing symbol that contains the call (empty string if top-level). */
  callerSymbol: string;
  /** Raw callee expression text as it appears in source. */
  calleeRaw: string;
  /** 0-indexed line of the call expression. */
  line: number;
  /** 0-indexed character in the call line (best-effort, optional). */
  character?: number;
  /** How the callee is invoked (defaults to `'direct'` when absent). */
  callKind?: CallKind;
  /** True when the call target is reached via indirection (pointer deref, field, etc.). */
  isIndirect?: boolean;
}

/** An environment-variable reference found in a source file. */
export interface RawEnvRef {
  /** Environment-variable key (e.g. `DATABASE_URL`). */
  key: string;
  /** 0-indexed line of the reference. */
  line: number;
}

/** A semantic relationship between two symbols found in a source file. */
export interface RawRelationship {
  /** Relationship category (e.g. `extends`, `implements`). */
  kind: string;
  /** Name of the source symbol in the relationship. */
  fromSymbol: string;
  /** Name of the target symbol in the relationship. */
  toSymbol: string;
  /** 0-indexed line where the relationship is declared. */
  line: number;
  /** 0-indexed character of the target type identifier (best-effort, optional). */
  character?: number;
}

/**
 * Classification of how a type reference is used at the referencing site.
 */
export type TypeRefKind =
  | 'parameter'
  | 'return'
  | 'field'
  | 'variable'
  | 'cast'
  | 'sizeof'
  | 'generic_arg'
  | 'bound'
  | 'other';

/** A type-usage reference found in a source file. */
export interface RawTypeRef {
  /** Name of the enclosing symbol that contains the reference (empty string if top-level). */
  enclosingSymbol: string;
  /** Raw type text as it appears in source. */
  typeRaw: string;
  /** How the type is referenced (parameter, return, field, etc.). */
  refKind: TypeRefKind;
  /** 0-indexed line of the type reference. */
  line: number;
  /** 0-indexed character in the line (best-effort, optional). */
  character?: number;
}

/** A framework route/endpoint extracted from source. */
export interface RawRoute {
  /** HTTP method for the route (e.g. `GET`, `POST`). */
  method: string;
  /** Route path template (e.g. `/users/:id`). */
  path: string;
  /** Raw handler reference as seen in source. */
  handler: string;
  /** Framework inferred by the extractor (e.g. `express`, `fastapi`, `gin`). */
  framework: string;
  /** 0-indexed line where the route is declared. */
  line: number;
  /** Optional middleware references in declaration order. */
  middleware?: string[];
}

/** The full extraction result returned by a `SymbolExtractor`. */
export interface ExtractionResult {
  symbols: RawSymbol[];
  imports: RawImport[];
  callRefs: RawCallRef[];
  envRefs: RawEnvRef[];
  relationships: RawRelationship[];
  typeRefs: RawTypeRef[];
  routes: RawRoute[];
}

// ─── SymbolExtractor interface ────────────────────────────────────────────────

/**
 * Implemented by each language extractor to pull symbols, imports, and call
 * references out of a parsed tree-sitter AST.
 */
export interface SymbolExtractor {
  /**
   * @param tree      Parsed tree-sitter syntax tree for the file.
   * @param source    Raw source text of the file.
   * @param filePath  Absolute path to the file (for context / error messages).
   */
  extract(tree: Parser.Tree, source: string, filePath: string): ExtractionResult;
}

export interface ComplexityNodeTypes {
  parameterListTypes: readonly string[];
  parameterTypes: readonly string[];
  decisionTypes: readonly string[];
  nestingTypes: readonly string[];
}

// ─── Shared utilities ─────────────────────────────────────────────────────────

/**
 * Iterates every node in the subtree rooted at `node` in depth-first order.
 */
export function* walk(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  yield node;
  for (const child of node.children) {
    yield* walk(child);
  }
}

/**
 * Returns the first descendant with the given `type`, or `null`.
 */
export function findFirst(
  node: Parser.SyntaxNode,
  type: string,
): Parser.SyntaxNode | null {
  for (const n of walk(node)) {
    if (n.type === type) return n;
  }
  return null;
}

/**
 * Extracts a signature from a node by returning everything before the first
 * opening brace `{` (or the first line if there is no brace).
 */
export function nodeSignature(node: Parser.SyntaxNode): string {
  const text = node.text;
  const braceIdx = text.indexOf('{');
  if (braceIdx !== -1) {
    return text.slice(0, braceIdx).trim();
  }
  return (text.split('\n')[0] ?? text).trim();
}

/** Returns an empty `ExtractionResult`. */
export function emptyResult(): ExtractionResult {
  return { symbols: [], imports: [], callRefs: [], envRefs: [], relationships: [], typeRefs: [], routes: [] };
}

/**
 * Walks up the parent chain from `node` to find the nearest enclosing symbol
 * declaration and returns its name.  Returns `''` for top-level code.
 *
 * @param symbolNodeTypes  AST node types that represent symbol declarations
 *                         in the current language (e.g. `function_definition`).
 */
export function findEnclosingSymbolName(
  node: Parser.SyntaxNode,
  symbolNodeTypes: readonly string[],
): string {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (symbolNodeTypes.includes(current.type)) {
      // Standard 'name' field (Go, Python, Rust, Java, C#, etc.)
      const nameNode = current.childForFieldName('name');
      if (nameNode) return nameNode.text;
      // C/C++ use 'declarator' for function names
      const declNode = current.childForFieldName('declarator');
      if (declNode) {
        const id =
          findFirst(declNode, 'qualified_identifier')
          ?? findFirst(declNode, 'identifier');
        if (id) return id.text;
      }
    }
    // TS/JS arrow functions: const foo = () => {} — name is on the variable_declarator
    if (
      current.type === 'variable_declarator'
      && current.parent
      && (current.parent.type === 'lexical_declaration' || current.parent.type === 'variable_declaration')
    ) {
      const valueNode = current.childForFieldName('value');
      if (
        valueNode
        && (valueNode.type === 'arrow_function'
          || valueNode.type === 'function_expression'
          || valueNode.type === 'generator_function')
        && node.startIndex >= valueNode.startIndex
        && node.endIndex <= valueNode.endIndex
      ) {
        const nameNode = current.childForFieldName('name');
        if (nameNode) return nameNode.text;
      }
    }
    current = current.parent;
  }
  return '';
}

/**
 * Returns true when a symbol belongs to the public declaration API surface.
 *
 * Falls back to `isExported` so existing extractors remain compatible while
 * they migrate to `declarationSurface`.
 */
export function isPublicDeclarationSurfaceSymbol(symbol: RawSymbol): boolean {
  if (symbol.declarationSurface) {
    return symbol.declarationSurface.isPublic && symbol.declarationSurface.isDeclaration;
  }
  return symbol.isExported === true;
}

/**
 * Extracts type argument names from a generic/template type node.
 *
 * Walks the immediate children of the argument list node and returns their
 * text values.  One level deep only — nested generics are **not** recursed.
 *
 * @param typeNode         The type node that may contain generic args.
 * @param genericNodeType  The AST node type of the generic wrapper (e.g. `generic_type`, `template_type`).
 * @param argListNodeType  The AST node type of the argument list (e.g. `type_arguments`, `template_argument_list`).
 * @returns Array of type argument text values, or empty if none found.
 */
export function extractGenericTypeArgs(
  typeNode: Parser.SyntaxNode,
  genericNodeType: string,
  argListNodeType: string,
): string[] {
  if (typeNode.type !== genericNodeType) return [];
  for (const child of typeNode.namedChildren) {
    if (child.type === argListNodeType) {
      return child.namedChildren.map(c => c.text);
    }
  }
  return [];
}

/**
 * Unwraps wrapper types (nullable, reference, pointer, array, optional, slice)
 * to find the inner type node that may carry generic arguments.
 *
 * When `extractTypeName` descends through these wrappers internally but
 * `extractGenericTypeArgs` is called on the outer node, generic args would be
 * lost because the outer node's type doesn't match `genericNodeType`.
 */
const WRAPPER_NODE_TYPES = new Set([
  'nullable_type',
  'optional_type',
  'reference_type',
  'pointer_type',
  'slice_type',
  'array_type',
]);

function unwrapToGenericNode(node: Parser.SyntaxNode, genericNodeType: string): Parser.SyntaxNode {
  let current = node;
  while (WRAPPER_NODE_TYPES.has(current.type) && current.type !== genericNodeType) {
    const inner = current.namedChildren.find(c =>
      c.type !== 'mutable_specifier' && c.type !== 'lifetime');
    if (!inner) break;
    current = inner;
  }
  return current;
}

/**
 * Creates a type-ref emitter function that encapsulates the standard
 * three-step pattern used by most language extractors:
 *
 * 1. Call `extractTypeName(typeNode)` → `string | null`
 * 2. Push a `RawTypeRef` with the result
 * 3. Call `extractGenericTypeArgs` and push a `RawTypeRef` per arg with `refKind: 'generic_arg'`
 *
 * @param config.extractTypeName   Language-specific function to extract a type name from a node.
 * @param config.genericNodeType   AST node type for generic/template wrappers.
 * @param config.argListNodeType   AST node type for the generic argument list.
 * @param config.recurseIntoTypes  Optional list of AST node types to recurse into
 *                                 (e.g. `['union_type', 'intersection_type']` for TypeScript).
 *                                 When the type node matches one of these, the emitter walks
 *                                 its `namedChildren` instead of emitting directly.
 */
export function createTypeRefEmitter(config: {
  extractTypeName: (node: Parser.SyntaxNode) => string | null;
  genericNodeType: string;
  argListNodeType: string;
  recurseIntoTypes?: string[];
}): (refs: RawTypeRef[], enclosing: string, typeNode: Parser.SyntaxNode, refKind: TypeRefKind) => void {
  const { extractTypeName, genericNodeType, argListNodeType, recurseIntoTypes } = config;
  const emitter = (
    refs: RawTypeRef[],
    enclosing: string,
    typeNode: Parser.SyntaxNode,
    refKind: TypeRefKind,
  ): void => {
    // Recurse into compound types (union, intersection, map, etc.)
    if (recurseIntoTypes && recurseIntoTypes.includes(typeNode.type)) {
      for (const child of typeNode.namedChildren) {
        emitter(refs, enclosing, child, refKind);
      }
      return;
    }
    const typeName = extractTypeName(typeNode);
    if (!typeName) return;
    refs.push({
      enclosingSymbol: enclosing,
      typeRaw: typeName,
      refKind,
      line: typeNode.startPosition.row,
      character: typeNode.startPosition.column,
    });
    // Unwrap wrapper types (nullable, optional, reference, etc.) before
    // checking for generic args — extractTypeName may have already descended
    // through these wrappers, so the outer node won't match genericNodeType.
    const innerNode = unwrapToGenericNode(typeNode, genericNodeType);
    const genericArgs = extractGenericTypeArgs(innerNode, genericNodeType, argListNodeType);
    for (const arg of genericArgs) {
      refs.push({
        enclosingSymbol: enclosing,
        typeRaw: arg,
        refKind: 'generic_arg',
        line: typeNode.startPosition.row,
        character: typeNode.startPosition.column,
      });
    }
  };
  return emitter;
}
