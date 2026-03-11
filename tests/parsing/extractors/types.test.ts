import { describe, it, expect } from 'vitest';
import {
  emptyResult,
  walk,
  findFirst,
  nodeSignature,
  isPublicDeclarationSurfaceSymbol,
} from '../../../src/parsing/extractors/types.js';
import { ParserPool } from '../../../src/parsing/parser.js';

// Parse a simple JS source to obtain real AST nodes for testing tree utilities.
const pool = new ParserPool();
const simpleSource = 'function hello() { return 42; }';
const tree = pool.parse('javascript', simpleSource);

// ─── emptyResult ──────────────────────────────────────────────────────────────

describe('emptyResult', () => {
  it('should return an object with empty symbols, imports, callRefs, relationships, typeRefs, and routes arrays', () => {
    expect(emptyResult()).toEqual({
      symbols: [],
      imports: [],
      callRefs: [],
      envRefs: [],
      relationships: [],
      typeRefs: [],
      routes: [],
    });
  });

  it('should return a new object on each call', () => {
    const a = emptyResult();
    const b = emptyResult();
    expect(a).not.toBe(b);
  });

  it('should return independently mutable arrays', () => {
    const result = emptyResult();
    // Mutating one field must not affect a fresh call.
    result.symbols.push({ name: 'x', kind: 'function', startLine: 0, endLine: 0, signature: '' });
    expect(emptyResult().symbols).toHaveLength(0);
  });
});

// ─── walk ─────────────────────────────────────────────────────────────────────

describe('walk', () => {
  it.skipIf(!tree)('should yield the root node as the first element', () => {
    const nodes = [...walk(tree!.rootNode)];
    expect(nodes[0]).toBe(tree!.rootNode);
  });

  it.skipIf(!tree)('should yield more than one node for a non-trivial tree', () => {
    const nodes = [...walk(tree!.rootNode)];
    expect(nodes.length).toBeGreaterThan(1);
  });

  it.skipIf(!tree)('should include every node reachable from the root', () => {
    const nodes = [...walk(tree!.rootNode)];
    // The function_declaration node must appear somewhere in the walk.
    const types = nodes.map((n) => n.type);
    expect(types).toContain('function_declaration');
  });
});

// ─── findFirst ────────────────────────────────────────────────────────────────

describe('findFirst', () => {
  it.skipIf(!tree)('should return the first descendant matching the given type', () => {
    const fn = findFirst(tree!.rootNode, 'function_declaration');
    expect(fn).not.toBeNull();
    expect(fn!.type).toBe('function_declaration');
  });

  it.skipIf(!tree)('should return null when no descendant of that type exists', () => {
    // There are no class declarations in our simple source.
    const cls = findFirst(tree!.rootNode, 'class_declaration');
    expect(cls).toBeNull();
  });
});

// ─── nodeSignature ────────────────────────────────────────────────────────────

describe('nodeSignature', () => {
  it.skipIf(!tree)('should return text before the opening brace, trimmed', () => {
    const fn = findFirst(tree!.rootNode, 'function_declaration');
    expect(fn).not.toBeNull();
    const sig = nodeSignature(fn!);
    expect(sig).toBe('function hello()');
  });

  it.skipIf(!tree)('should never include a leading or trailing space', () => {
    const fn = findFirst(tree!.rootNode, 'function_declaration');
    expect(fn).not.toBeNull();
    const sig = nodeSignature(fn!);
    expect(sig).toBe(sig.trim());
  });

  it.skipIf(!tree)(
    'should return the first line when the node text contains no brace',
    () => {
      // Use an identifier node — it has no braces.
      const identifier = findFirst(tree!.rootNode, 'identifier');
      expect(identifier).not.toBeNull();
      const sig = nodeSignature(identifier!);
      // An identifier's text is a single word with no brace, so we get the first line.
      expect(sig).toBeTruthy();
      expect(sig).not.toContain('{');
    },
  );
});

describe('isPublicDeclarationSurfaceSymbol', () => {
  it('should return true when declaration surface is public and declaration-only', () => {
    expect(
      isPublicDeclarationSurfaceSymbol({
        name: 'publicApi',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'function publicApi(): void;',
        declarationSurface: { isPublic: true, isDeclaration: true },
      }),
    ).toBe(true);
  });

  it('should return false when declaration surface is not publicly visible', () => {
    expect(
      isPublicDeclarationSurfaceSymbol({
        name: 'internalApi',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'function internalApi(): void;',
        declarationSurface: { isPublic: false, isDeclaration: true },
      }),
    ).toBe(false);
  });

  it('should return false when declaration surface contains implementation details', () => {
    expect(
      isPublicDeclarationSurfaceSymbol({
        name: 'runtimeApi',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'function runtimeApi(): void;',
        declarationSurface: { isPublic: true, isDeclaration: false },
      }),
    ).toBe(false);
  });

  it('should fall back to isExported when declaration surface metadata is missing', () => {
    expect(
      isPublicDeclarationSurfaceSymbol({
        name: 'legacyExport',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'function legacyExport(): void;',
        isExported: true,
      }),
    ).toBe(true);
  });

  it('should return false when neither declaration metadata nor export flag marks symbol as public', () => {
    expect(
      isPublicDeclarationSurfaceSymbol({
        name: 'legacyPrivate',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'function legacyPrivate(): void;',
      }),
    ).toBe(false);
  });
});
