/**
 * Health-check tests for remaining language extractors.
 *
 * Each test verifies that the extractor can be instantiated and can extract
 * from a minimal source snippet without crashing.
 */
import { describe, it, expect } from 'vitest';
import { ParserPool } from '../../../src/parsing/parser.js';
import { CppExtractor } from '../../../src/parsing/extractors/cpp.js';
import { CSharpExtractor } from '../../../src/parsing/extractors/csharp.js';
import { RubyExtractor } from '../../../src/parsing/extractors/ruby.js';
import { PhpExtractor } from '../../../src/parsing/extractors/php.js';
import { SwiftExtractor } from '../../../src/parsing/extractors/swift.js';
import { KotlinExtractor } from '../../../src/parsing/extractors/kotlin.js';
import { ScalaExtractor } from '../../../src/parsing/extractors/scala.js';
import { LuaExtractor } from '../../../src/parsing/extractors/lua.js';
import { BashExtractor } from '../../../src/parsing/extractors/bash.js';
import { ElixirExtractor } from '../../../src/parsing/extractors/elixir.js';
import { ZigExtractor } from '../../../src/parsing/extractors/zig.js';
import { OcamlExtractor } from '../../../src/parsing/extractors/ocaml.js';
import { HaskellExtractor } from '../../../src/parsing/extractors/haskell.js';
import { JuliaExtractor } from '../../../src/parsing/extractors/julia.js';
import { ElmExtractor } from '../../../src/parsing/extractors/elm.js';
import { ObjcExtractor } from '../../../src/parsing/extractors/objc.js';

const pool = new ParserPool();

interface HealthCase {
  language: string;
  extractor: { extract: (tree: import('tree-sitter').Tree, source: string, filePath: string) => unknown };
  source: string;
  filePath: string;
  expectSymbol?: string;
}

const cases: HealthCase[] = [
  {
    language: 'cpp',
    extractor: new CppExtractor(),
    source: `#include <iostream>
class Greeter {
public:
  void greet() { std::cout << "Hello"; }
};
int main() { Greeter g; g.greet(); return 0; }`,
    filePath: 'test.cpp',
    expectSymbol: 'main',
  },
  {
    language: 'csharp',
    extractor: new CSharpExtractor(),
    source: `using System;
class Program {
  static void Main() { Console.WriteLine("Hello"); }
}`,
    filePath: 'test.cs',
    expectSymbol: 'Program',
  },
  {
    language: 'ruby',
    extractor: new RubyExtractor(),
    source: `require 'json'
class Greeter
  def greet(name)
    puts "Hello #{name}"
  end
end`,
    filePath: 'test.rb',
    expectSymbol: 'greet',
  },
  {
    language: 'php',
    extractor: new PhpExtractor(),
    source: `<?php
function greet($name) { echo "Hello $name"; }
class User {
  public function getName() { return $this->name; }
}
?>`,
    filePath: 'test.php',
    expectSymbol: 'greet',
  },
  {
    language: 'swift',
    extractor: new SwiftExtractor(),
    source: `import Foundation
class Greeter {
  func greet(name: String) -> String {
    return "Hello \\(name)"
  }
}`,
    filePath: 'test.swift',
    expectSymbol: 'Greeter',
  },
  {
    language: 'kotlin',
    extractor: new KotlinExtractor(),
    source: `package example
fun greet(name: String): String = "Hello $name"
class Server {
  fun start() {}
}`,
    filePath: 'test.kt',
    expectSymbol: 'greet',
  },
  {
    language: 'scala',
    extractor: new ScalaExtractor(),
    source: `object Main {
  def greet(name: String): String = s"Hello $name"
}
class Server {
  def start(): Unit = {}
}`,
    filePath: 'test.scala',
    expectSymbol: 'Main',
  },
  {
    language: 'lua',
    extractor: new LuaExtractor(),
    source: `local function greet(name)
  print("Hello " .. name)
end
function globalFn()
  return 42
end`,
    filePath: 'test.lua',
    expectSymbol: 'greet',
  },
  {
    language: 'bash',
    extractor: new BashExtractor(),
    source: `#!/bin/bash
greet() {
  echo "Hello $1"
}
function cleanup {
  rm -rf /tmp/test
}`,
    filePath: 'test.sh',
    expectSymbol: 'greet',
  },
  {
    language: 'elixir',
    extractor: new ElixirExtractor(),
    source: `defmodule Greeter do
  def greet(name) do
    "Hello #{name}"
  end
end`,
    filePath: 'test.ex',
    expectSymbol: 'Greeter',
  },
  {
    language: 'zig',
    extractor: new ZigExtractor(),
    source: `const std = @import("std");
pub fn add(a: i32, b: i32) i32 {
    return a + b;
}`,
    filePath: 'test.zig',
    expectSymbol: 'add',
  },
  {
    language: 'ocaml',
    extractor: new OcamlExtractor(),
    source: `let greet name = Printf.printf "Hello %s" name
let add a b = a + b`,
    filePath: 'test.ml',
    expectSymbol: 'greet',
  },
  {
    language: 'haskell',
    extractor: new HaskellExtractor(),
    source: `module Main where
greet :: String -> String
greet name = "Hello " ++ name
main :: IO ()
main = putStrLn (greet "world")`,
    filePath: 'test.hs',
    expectSymbol: 'greet',
  },
  {
    language: 'julia',
    extractor: new JuliaExtractor(),
    source: `module MyModule
function greet(name::String)
    println("Hello $name")
end
struct Point
    x::Float64
    y::Float64
end
end`,
    filePath: 'test.jl',
    expectSymbol: 'greet',
  },
  {
    language: 'elm',
    extractor: new ElmExtractor(),
    source: `module Main exposing (main)
greet : String -> String
greet name = "Hello " ++ name
main = text (greet "World")`,
    filePath: 'test.elm',
    expectSymbol: 'greet',
  },
  {
    language: 'objc',
    extractor: new ObjcExtractor(),
    source: `#import <Foundation/Foundation.h>
@interface Greeter : NSObject
- (void)greet:(NSString *)name;
@end
@implementation Greeter
- (void)greet:(NSString *)name {
  NSLog(@"Hello %@", name);
}
@end`,
    filePath: 'test.m',
    expectSymbol: 'Greeter',
  },
];

describe('extractor health checks', () => {
  for (const tc of cases) {
    describe(tc.language, () => {
      it('parses and extracts without crashing', () => {
        const tree = pool.parse(tc.language, tc.source);
        // Some grammars may not be installed — skip gracefully
        if (!tree) {
          console.warn(`Grammar not available for ${tc.language}, skipping`);
          return;
        }
        const result = tc.extractor.extract(tree, tc.source, tc.filePath) as import('../../../src/parsing/extractors/types.js').ExtractionResult;
        expect(result).toBeDefined();
        expect(Array.isArray(result.symbols)).toBe(true);
        expect(Array.isArray(result.imports)).toBe(true);
        expect(Array.isArray(result.callRefs)).toBe(true);
      });

      it('extracts expected symbol', () => {
        const tree = pool.parse(tc.language, tc.source);
        if (!tree) return;
        const result = tc.extractor.extract(tree, tc.source, tc.filePath) as import('../../../src/parsing/extractors/types.js').ExtractionResult;
        if (tc.expectSymbol) {
          const sym = result.symbols.find(s => s.name === tc.expectSymbol);
          expect(sym, `Expected symbol '${tc.expectSymbol}' in ${tc.language}`).toBeDefined();
        }
      });

      it('handles empty source', () => {
        const emptySource = tc.language === 'php' ? '<?php ?>' : '';
        const tree = pool.parse(tc.language, emptySource);
        if (!tree) return;
        expect(() => {
          tc.extractor.extract(tree, emptySource, tc.filePath);
        }).not.toThrow();
      });
    });
  }
});
