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

/** A call-site reference found in a source file. */
export interface RawCallRef {
  /** Name of the enclosing symbol that contains the call (empty string if top-level). */
  callerSymbol: string;
  /** Raw callee expression text as it appears in source. */
  calleeRaw: string;
  /** 0-indexed line of the call expression. */
  line: number;
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
  return { symbols: [], imports: [], callRefs: [], envRefs: [], relationships: [], routes: [] };
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
