import { describe, it, expect } from 'vitest';
import {
  isPublicDeclarationSurfaceSymbol,
  emptyResult,
  walk,
  findFirst,
  nodeSignature,
  findEnclosingSymbolName,
  extractGenericTypeArgs,
} from '../../../src/parsing/extractors/types.js';
import type { RawSymbol } from '../../../src/parsing/extractors/types.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();

describe('types utilities', () => {
  describe('emptyResult', () => {
    it('returns a fresh empty result object', () => {
      const result = emptyResult();
      expect(result.symbols).toEqual([]);
      expect(result.imports).toEqual([]);
      expect(result.callRefs).toEqual([]);
      expect(result.envRefs).toEqual([]);
      expect(result.relationships).toEqual([]);
      expect(result.typeRefs).toEqual([]);
    });

    it('returns distinct objects each time', () => {
      const a = emptyResult();
      const b = emptyResult();
      expect(a).not.toBe(b);
      expect(a.symbols).not.toBe(b.symbols);
    });
  });

  describe('isPublicDeclarationSurfaceSymbol', () => {
    it('returns true when declarationSurface.isPublic and isDeclaration', () => {
      const sym: RawSymbol = {
        name: 'test',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'fn test',
        declarationSurface: { isPublic: true, isDeclaration: true },
      };
      expect(isPublicDeclarationSurfaceSymbol(sym)).toBe(true);
    });

    it('returns false when declarationSurface.isPublic is false', () => {
      const sym: RawSymbol = {
        name: 'test',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'fn test',
        declarationSurface: { isPublic: false, isDeclaration: true },
      };
      expect(isPublicDeclarationSurfaceSymbol(sym)).toBe(false);
    });

    it('returns false when declarationSurface.isDeclaration is false', () => {
      const sym: RawSymbol = {
        name: 'test',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'fn test',
        declarationSurface: { isPublic: true, isDeclaration: false },
      };
      expect(isPublicDeclarationSurfaceSymbol(sym)).toBe(false);
    });

    it('falls back to isExported when no declarationSurface', () => {
      const exported: RawSymbol = {
        name: 'test',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'fn test',
        isExported: true,
      };
      expect(isPublicDeclarationSurfaceSymbol(exported)).toBe(true);

      const notExported: RawSymbol = {
        name: 'test',
        kind: 'function',
        startLine: 0,
        endLine: 0,
        signature: 'fn test',
      };
      expect(isPublicDeclarationSurfaceSymbol(notExported)).toBe(false);
    });
  });

  describe('walk', () => {
    it('iterates all nodes in depth-first order', () => {
      const tree = pool.parse('typescript', 'const x = 1;')!;
      const types: string[] = [];
      for (const node of walk(tree.rootNode)) {
        types.push(node.type);
      }
      expect(types[0]).toBe('program');
      expect(types.length).toBeGreaterThan(1);
    });
  });

  describe('findFirst', () => {
    it('finds a descendant of the given type', () => {
      const tree = pool.parse('typescript', 'function foo() { return 1; }')!;
      const id = findFirst(tree.rootNode, 'identifier');
      expect(id).not.toBeNull();
      expect(id!.text).toBe('foo');
    });

    it('returns null when type not found', () => {
      const tree = pool.parse('typescript', 'const x = 1;')!;
      const result = findFirst(tree.rootNode, 'class_declaration');
      expect(result).toBeNull();
    });
  });

  describe('nodeSignature', () => {
    it('extracts signature before body', () => {
      const tree = pool.parse('typescript', 'function hello(x: number): string { return "hi"; }')!;
      const fnNode = findFirst(tree.rootNode, 'function_declaration')!;
      const sig = nodeSignature(fnNode);
      expect(sig).toContain('function hello');
      expect(sig).toContain('x: number');
      expect(sig).not.toContain('return');
    });

    it('handles single-line function', () => {
      const tree = pool.parse('go', 'package main\nfunc add(a int, b int) int { return a + b }')!;
      const fnNode = findFirst(tree.rootNode, 'function_declaration')!;
      const sig = nodeSignature(fnNode);
      expect(sig).toContain('func add');
    });
  });

  describe('findEnclosingSymbolName', () => {
    it('returns parent function name for nested node', () => {
      const source = `function outer() {
  const x = doSomething();
}`;
      const tree = pool.parse('typescript', source)!;
      const callNode = findFirst(tree.rootNode, 'call_expression')!;
      const name = findEnclosingSymbolName(callNode, ['function_declaration']);
      expect(name).toBe('outer');
    });

    it('returns empty string for top-level node', () => {
      const tree = pool.parse('typescript', 'const x = 1;')!;
      const decl = findFirst(tree.rootNode, 'lexical_declaration')!;
      const name = findEnclosingSymbolName(decl, ['function_declaration']);
      expect(name).toBe('');
    });

    it('handles arrow function assignment in variable_declarator', () => {
      const source = `const handler = () => { console.log("hi"); };`;
      const tree = pool.parse('typescript', source)!;
      const callNode = findFirst(tree.rootNode, 'call_expression')!;
      const name = findEnclosingSymbolName(callNode, ['function_declaration']);
      expect(name).toBe('handler');
    });
  });

  describe('extractGenericTypeArgs', () => {
    it('extracts type arguments from generic types', () => {
      const tree = pool.parse('typescript', 'let x: Map<string, number>;')!;
      // Find the generic type node
      const genericNode = findFirst(tree.rootNode, 'generic_type');
      if (genericNode) {
        const args = extractGenericTypeArgs(genericNode, 'generic_type', 'type_arguments');
        expect(args.length).toBeGreaterThan(0);
      }
    });

    it('returns empty array for non-generic types', () => {
      const tree = pool.parse('typescript', 'let x: string;')!;
      const typeNode = findFirst(tree.rootNode, 'type_identifier');
      if (typeNode) {
        const args = extractGenericTypeArgs(typeNode, 'generic_type', 'type_arguments');
        expect(args).toEqual([]);
      }
    });
  });
});
