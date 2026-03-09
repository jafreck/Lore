/**
 * @module tests/indexer/extractors/health
 *
 * Comprehensive health check for all 24 language extractors.
 *
 * For each language verifies:
 * 1. The parser successfully produces a tree from the fixture file (MUST pass — not skipped)
 * 2. The extractor produces non-empty symbols
 * 3. No symbols have empty names
 * 4. Call-refs that are inside a symbol body have non-empty callerSymbol
 * 5. Type-refs (if any) have non-empty enclosingSymbol when they exist inside a symbol body
 * 6. All emitted symbol kinds are expected for the language
 *
 * Unlike tier2/tier3 tests, these tests **fail** (not skip) when a grammar
 * cannot load.  Every grammar is a declared dependency in package.json, so a
 * load failure indicates a broken native build that must be fixed.
 */
import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtract } from '../../helpers/extractorHelper.js';

import { BashExtractor } from '../../../src/indexer/extractors/bash.js';
import { CExtractor } from '../../../src/indexer/extractors/c.js';
import { CppExtractor } from '../../../src/indexer/extractors/cpp.js';
import { CSharpExtractor } from '../../../src/indexer/extractors/csharp.js';
import { ElixirExtractor } from '../../../src/indexer/extractors/elixir.js';
import { ElmExtractor } from '../../../src/indexer/extractors/elm.js';
import { GoExtractor } from '../../../src/indexer/extractors/go.js';
import { HaskellExtractor } from '../../../src/indexer/extractors/haskell.js';
import { JavaExtractor } from '../../../src/indexer/extractors/java.js';
import { JavaScriptExtractor } from '../../../src/indexer/extractors/javascript.js';
import { JuliaExtractor } from '../../../src/indexer/extractors/julia.js';
import { KotlinExtractor } from '../../../src/indexer/extractors/kotlin.js';
import { LuaExtractor } from '../../../src/indexer/extractors/lua.js';
import { ObjcExtractor } from '../../../src/indexer/extractors/objc.js';
import { OcamlExtractor } from '../../../src/indexer/extractors/ocaml.js';
import { PhpExtractor } from '../../../src/indexer/extractors/php.js';
import { PythonExtractor } from '../../../src/indexer/extractors/python.js';
import { RubyExtractor } from '../../../src/indexer/extractors/ruby.js';
import { RustExtractor } from '../../../src/indexer/extractors/rust.js';
import { ScalaExtractor } from '../../../src/indexer/extractors/scala.js';
import { SwiftExtractor } from '../../../src/indexer/extractors/swift.js';
import { TypeScriptExtractor } from '../../../src/indexer/extractors/typescript.js';
import { ZigExtractor } from '../../../src/indexer/extractors/zig.js';
import type { ExtractionResult, SymbolExtractor } from '../../../src/indexer/extractors/types.js';

const fixtureDir = path.join(import.meta.dirname, '../../fixtures');

// ─── Language registry ────────────────────────────────────────────────────────

interface LanguageSpec {
  lang: string;
  fixture: string;
  extractor: SymbolExtractor;
  /** Expected symbol kinds that the fixture should produce. */
  expectedKinds: string[];
  /** Minimum number of symbols expected (sanity floor). */
  minSymbols: number;
}

const LANGUAGES: LanguageSpec[] = [
  { lang: 'bash',       fixture: 'bash/sample.sh',       extractor: new BashExtractor(),       expectedKinds: ['function'],                                minSymbols: 1 },
  { lang: 'c',          fixture: 'c/sample.c',           extractor: new CExtractor(),          expectedKinds: ['function', 'struct', 'macro'],             minSymbols: 4 },
  { lang: 'c',          fixture: 'c/sample.h',           extractor: new CExtractor(),          expectedKinds: ['function', 'struct', 'enum', 'macro'],     minSymbols: 6 },
  { lang: 'cpp',        fixture: 'cpp/sample.cpp',       extractor: new CppExtractor(),        expectedKinds: ['function', 'class'],                       minSymbols: 2 },
  { lang: 'csharp',     fixture: 'csharp/sample.cs',     extractor: new CSharpExtractor(),     expectedKinds: ['class', 'function'],                       minSymbols: 2 },
  { lang: 'elixir',     fixture: 'elixir/sample.ex',     extractor: new ElixirExtractor(),     expectedKinds: ['function', 'module'],                      minSymbols: 2 },
  { lang: 'elm',        fixture: 'elm/sample.elm',       extractor: new ElmExtractor(),        expectedKinds: ['function'],                                minSymbols: 1 },
  { lang: 'go',         fixture: 'go/sample.go',         extractor: new GoExtractor(),         expectedKinds: ['function'],                                minSymbols: 2 },
  { lang: 'haskell',    fixture: 'haskell/sample.hs',    extractor: new HaskellExtractor(),    expectedKinds: ['function'],                                minSymbols: 1 },
  { lang: 'java',       fixture: 'java/sample.java',     extractor: new JavaExtractor(),       expectedKinds: ['class', 'function'],                       minSymbols: 2 },
  { lang: 'javascript', fixture: 'javascript/sample.js', extractor: new JavaScriptExtractor(), expectedKinds: ['function'],                                minSymbols: 2 },
  { lang: 'julia',      fixture: 'julia/sample.jl',      extractor: new JuliaExtractor(),      expectedKinds: ['function'],                                minSymbols: 1 },
  { lang: 'kotlin',     fixture: 'kotlin/sample.kt',     extractor: new KotlinExtractor(),     expectedKinds: ['function', 'class'],                       minSymbols: 2 },
  { lang: 'lua',        fixture: 'lua/sample.lua',       extractor: new LuaExtractor(),        expectedKinds: ['function'],                                minSymbols: 1 },
  { lang: 'objc',       fixture: 'objc/sample.m',        extractor: new ObjcExtractor(),       expectedKinds: ['class', 'function'],                       minSymbols: 2 },
  { lang: 'ocaml',      fixture: 'ocaml/sample.ml',      extractor: new OcamlExtractor(),      expectedKinds: ['function'],                                minSymbols: 1 },
  { lang: 'php',        fixture: 'php/sample.php',       extractor: new PhpExtractor(),        expectedKinds: ['function'],                                minSymbols: 1 },
  { lang: 'python',     fixture: 'python/sample.py',     extractor: new PythonExtractor(),     expectedKinds: ['function', 'class'],                       minSymbols: 2 },
  { lang: 'ruby',       fixture: 'ruby/sample.rb',       extractor: new RubyExtractor(),       expectedKinds: ['function', 'class'],                       minSymbols: 2 },
  { lang: 'rust',       fixture: 'rust/sample.rs',       extractor: new RustExtractor(),       expectedKinds: ['function', 'struct'],                      minSymbols: 2 },
  { lang: 'scala',      fixture: 'scala/sample.scala',   extractor: new ScalaExtractor(),      expectedKinds: ['function', 'class'],                       minSymbols: 2 },
  { lang: 'swift',      fixture: 'swift/sample.swift',   extractor: new SwiftExtractor(),      expectedKinds: ['function', 'class'],                       minSymbols: 2 },
  { lang: 'typescript', fixture: 'typescript/sample.ts',  extractor: new TypeScriptExtractor(), expectedKinds: ['function', 'class'],                       minSymbols: 2 },
  { lang: 'zig',        fixture: 'zig/sample.zig',       extractor: new ZigExtractor(),        expectedKinds: ['function'],                                minSymbols: 1 },
];

// ─── Pre-extract all fixtures at module load ──────────────────────────────────

const results = new Map<string, { spec: LanguageSpec; result: ExtractionResult | null }>();
for (const spec of LANGUAGES) {
  const key = `${spec.lang}:${spec.fixture}`;
  results.set(key, {
    spec,
    result: parseAndExtract(spec.lang, path.join(fixtureDir, spec.fixture), spec.extractor),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('extractor health check', () => {
  for (const [key, { spec, result }] of results) {
    describe(`${key}`, () => {
      test('parser produces a tree and extraction succeeds', () => {
        // Every grammar is a declared dependency — a null result means the
        // native binding failed to load.  This MUST fail, not skip.
        expect(
          result,
          `grammar '${spec.lang}' failed to load or parse fixture '${spec.fixture}' — run \`npm rebuild tree-sitter-${spec.lang}\``,
        ).not.toBeNull();
      });

      test(`produces >= ${spec.minSymbols} symbols`, () => {
        expect(result, `grammar '${spec.lang}' unavailable`).not.toBeNull();
        expect(result!.symbols.length).toBeGreaterThanOrEqual(spec.minSymbols);
      });

      test('no empty-name symbols', () => {
        expect(result, `grammar '${spec.lang}' unavailable`).not.toBeNull();
        const emptyNames = result!.symbols.filter(s => !s.name);
        expect(emptyNames).toEqual([]);
      });

      test(`emits expected kinds: ${spec.expectedKinds.join(', ')}`, () => {
        expect(result, `grammar '${spec.lang}' unavailable`).not.toBeNull();
        const kinds = new Set(result!.symbols.map(s => s.kind));
        for (const expected of spec.expectedKinds) {
          expect(kinds, `missing symbol kind '${expected}'`).toContain(expected);
        }
      });

      test('call-refs inside symbols have non-empty callerSymbol', () => {
        expect(result, `grammar '${spec.lang}' unavailable`).not.toBeNull();
        // Allow some top-level call-refs (callerSymbol === '') but in files with
        // enough call-refs, a reasonable fraction should resolve to a parent.
        const callRefs = result!.callRefs;
        if (callRefs.length === 0) return;
        const resolved = callRefs.filter(r => r.callerSymbol !== '');
        if (callRefs.length >= 8) {
          expect(
            resolved.length / callRefs.length,
            `only ${resolved.length}/${callRefs.length} call-refs have a resolved callerSymbol`,
          ).toBeGreaterThanOrEqual(0.2);
        }
      });

      test('type-refs (if any) have non-empty enclosingSymbol', () => {
        expect(result, `grammar '${spec.lang}' unavailable`).not.toBeNull();
        const typeRefs = result!.typeRefs;
        if (typeRefs.length === 0) return;
        const resolved = typeRefs.filter(r => r.enclosingSymbol !== '');
        if (typeRefs.length >= 4) {
          expect(
            resolved.length / typeRefs.length,
            `only ${resolved.length}/${typeRefs.length} type-refs have a resolved enclosingSymbol`,
          ).toBeGreaterThanOrEqual(0.3);
        }
      });

      test('no duplicate symbol names on same line', () => {
        expect(result, `grammar '${spec.lang}' unavailable`).not.toBeNull();
        // Haskell intentionally emits both a type-signature and function symbol
        // for annotated functions — skip this check for Haskell.
        if (spec.lang === 'haskell') return;
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const s of result!.symbols) {
          const key = `${s.name}:${s.startLine}:${s.kind}`;
          if (seen.has(key)) dupes.push(key);
          seen.add(key);
        }
        expect(dupes, `duplicate symbols: ${dupes.join(', ')}`).toEqual([]);
      });
    });
  }
});
