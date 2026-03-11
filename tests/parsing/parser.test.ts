import { describe, it, expect, beforeEach } from 'vitest';
import { ParserPool, SUPPORTED_PARSER_LANGUAGES, LANG_PACKAGES } from '../../src/parsing/parser.js';
import { DEFAULT_LSP_SERVER_REGISTRY } from '../../src/lsp/registry.js';

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

    it('should return a non-null tree for a language with grammar installed', () => {
      const tree = pool.parse('javascript', 'const x = 1;');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode).toBeDefined();
    });

    it('should reuse the same parser across multiple parse calls', () => {
      const tree1 = pool.parse('javascript', 'const a = 1;');
      const tree2 = pool.parse('javascript', 'const b = 2;');
      expect(tree1).not.toBeNull();
      expect(tree2).not.toBeNull();
      expect(tree1!.rootNode.type).toBe(tree2!.rootNode.type);
    });

    it('should produce a tree whose root node has the expected type', () => {
      const tree = pool.parse('javascript', 'function hello() {}');
      expect(tree).not.toBeNull();
      expect(tree!.rootNode.type).toBe('program');
    });
  });

  // ─── Grammar coverage: every declared language MUST parse ─────────────────

  describe('grammar coverage', () => {
    /**
     * Minimal source snippets for each language — just enough for the parser
     * to produce a non-empty tree.  These verify the native grammar binding
     * loads and the parser can tokenise real code, catching ABI mismatches
     * and broken builds that would otherwise be silently swallowed.
     */
    const SNIPPETS: Record<string, string> = {
      bash:       '#!/bin/bash\ngreet() { echo "hi"; }',
      c:          'int main() { return 0; }',
      cpp:        'int main() { return 0; }',
      csharp:     'class Foo { void Bar() {} }',

      elixir:     'defmodule M do\n  def greet, do: :ok\nend',
      elm:        'module Main exposing (..)\n\ngreet x = x',
      go:         'package main\nfunc main() {}',
      haskell:    'main = putStrLn "hi"',
      java:       'class Foo { void bar() {} }',
      javascript: 'function greet() {}',
      julia:      'function greet()\n  println("hi")\nend',
      kotlin:     'fun main() {}',
      lua:        'function greet() end',
      objc:       '@interface Foo\n@end\n@implementation Foo\n@end',
      ocaml:      'let greet () = print_endline "hi"',
      php:        '<?php\nfunction greet() {}',
      python:     'def greet():\n    pass',
      ruby:       'def greet; end',
      rust:       'fn main() {}',
      scala:      'object Main { def greet(): Unit = {} }',
      swift:      'func greet() {}',
      typescript: 'function greet(): void {}',
      zig:        'pub fn main() void {}',
    };

    // Ensure the snippet map covers every language in LANG_PACKAGES.
    it('has a snippet for every supported language', () => {
      const snippetLangs = Object.keys(SNIPPETS).sort();
      expect(snippetLangs).toEqual([...SUPPORTED_PARSER_LANGUAGES]);
    });

    for (const lang of SUPPORTED_PARSER_LANGUAGES) {
      it(`parses ${lang} source without error`, () => {
        const snippet = SNIPPETS[lang];
        expect(snippet, `no snippet defined for language '${lang}'`).toBeDefined();
        const tree = pool.parse(lang, snippet!);
        expect(tree, `grammar for '${lang}' failed to load or parse — check native binding`).not.toBeNull();
        expect(tree!.rootNode.childCount).toBeGreaterThan(0);
      });
    }
  });

  it('keeps parser language coverage aligned with LSP registry defaults', () => {
    expect(Object.keys(DEFAULT_LSP_SERVER_REGISTRY).sort()).toEqual([...SUPPORTED_PARSER_LANGUAGES].sort());
  });
});
