import { describe, it, expect } from 'vitest';
import { ParserPool, SUPPORTED_PARSER_LANGUAGES, LANG_PACKAGES } from '../../src/parsing/parser.js';

describe('ParserPool', () => {
  const pool = new ParserPool();

  describe('SUPPORTED_PARSER_LANGUAGES', () => {
    it('is a frozen sorted array', () => {
      expect(Object.isFrozen(SUPPORTED_PARSER_LANGUAGES)).toBe(true);
      const sorted = [...SUPPORTED_PARSER_LANGUAGES].sort();
      expect(SUPPORTED_PARSER_LANGUAGES).toEqual(sorted);
    });

    it('includes core languages', () => {
      for (const lang of ['typescript', 'javascript', 'python', 'go', 'java', 'rust', 'c']) {
        expect(SUPPORTED_PARSER_LANGUAGES).toContain(lang);
      }
    });

    it('matches LANG_PACKAGES keys', () => {
      expect([...SUPPORTED_PARSER_LANGUAGES]).toEqual(Object.keys(LANG_PACKAGES).sort());
    });
  });

  describe('parse()', () => {
    it('parses valid TypeScript source', () => {
      const tree = pool.parse('typescript', 'function hello(): void {}');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('program');
    });

    it('parses valid JavaScript source', () => {
      const tree = pool.parse('javascript', 'const x = 42;');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('program');
    });

    it('parses valid Python source', () => {
      const tree = pool.parse('python', 'def greet():\n    pass\n');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('module');
    });

    it('parses valid Go source', () => {
      const tree = pool.parse('go', 'package main\nfunc main() {}');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('source_file');
    });

    it('parses valid Java source', () => {
      const tree = pool.parse('java', 'class Foo { void bar() {} }');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('program');
    });

    it('parses valid Rust source', () => {
      const tree = pool.parse('rust', 'fn main() {}');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('source_file');
    });

    it('parses valid C source', () => {
      const tree = pool.parse('c', 'int main() { return 0; }');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('translation_unit');
    });

    it('returns null for unknown language', () => {
      const tree = pool.parse('brainfuck', 'hello');
      expect(tree).toBeNull();
    });

    it('returns null for unknown language on second call', () => {
      pool.parse('nonexistent_lang', 'x');
      const tree = pool.parse('nonexistent_lang', 'y');
      expect(tree).toBeNull();
    });

    it('reuses cached parser for same language', () => {
      const tree1 = pool.parse('typescript', 'const a = 1;');
      const tree2 = pool.parse('typescript', 'const b = 2;');
      expect(tree1).not.toBeNull();
      expect(tree2).not.toBeNull();
    });

    it('handles empty source', () => {
      const tree = pool.parse('typescript', '');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.childCount).toBe(0);
    });

    it('handles source with syntax errors gracefully', () => {
      const tree = pool.parse('typescript', 'function { broken syntax !!!');
      expect(tree).not.toBeNull();
      // Tree-sitter produces a partial tree with ERROR nodes
      expect(tree!.rootNode.hasError).toBe(true);
    });

    it('handles large source via chunked parsing', () => {
      // Source larger than PARSER_CHUNK_SIZE (4096)
      const source = 'const x = 1;\n'.repeat(1000);
      const tree = pool.parse('typescript', source);
      expect(tree).not.toBeNull();
    });
  });
});
