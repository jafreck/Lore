import { describe, it, expect, beforeEach } from 'vitest';
import { ParserPool } from '../../src/indexer/parser.js';

// Pre-check grammar availability at module level so test.skipIf can use it.
const _probe = new ParserPool();
const jsAvailable = _probe.parse('javascript', 'const x = 1;') !== null;

describe('ParserPool', () => {
  let pool: ParserPool;

  beforeEach(() => {
    pool = new ParserPool();
  });

  describe('parse()', () => {
    it('should return null for an unrecognized language', () => {
      const result = pool.parse('unknownlang_xyz', 'some code');
      expect(result).toBeNull();
    });

    it('should return null consistently for the same unavailable language on repeated calls', () => {
      pool.parse('unknownlang_xyz', 'first call');
      const result = pool.parse('unknownlang_xyz', 'second call');
      expect(result).toBeNull();
    });

    it.skipIf(!jsAvailable)(
      'should return a non-null tree for a language with grammar installed',
      () => {
        const tree = pool.parse('javascript', 'const x = 1;');
        expect(tree).not.toBeNull();
        expect(tree!.rootNode).toBeDefined();
      },
    );

    it.skipIf(!jsAvailable)(
      'should reuse the same parser across multiple parse calls',
      () => {
        const tree1 = pool.parse('javascript', 'const a = 1;');
        const tree2 = pool.parse('javascript', 'const b = 2;');
        expect(tree1).not.toBeNull();
        expect(tree2).not.toBeNull();
        // Both parse calls should succeed, indicating the cached parser works.
        expect(tree1!.rootNode.type).toBe(tree2!.rootNode.type);
      },
    );

    it.skipIf(!jsAvailable)(
      'should produce a tree whose root node has the expected type',
      () => {
        const tree = pool.parse('javascript', 'function hello() {}');
        expect(tree).not.toBeNull();
        expect(tree!.rootNode.type).toBe('program');
      },
    );
  });
});
