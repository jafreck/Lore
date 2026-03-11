/**
 * @module indexer/parser
 *
 * Provides a `ParserPool` that lazily creates one tree-sitter `Parser` per
 * language and caches it for reuse.  Grammar packages that are not installed
 * are logged as warnings — `parse()` returns `null` for those languages.
 */

import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { getLogger } from '../logger.js';

const esmRequire = createRequire(import.meta.url);

/**
 * Loads a grammar package via `require()`.  Falls back to `node-gyp-build`
 * for packages that only expose ESM entry points (e.g. scoped
 * `@tree-sitter-grammars/*` packages with top-level `await`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadGrammarPackage(pkg: string): any {
  try {
    return esmRequire(pkg);
  } catch (firstError: unknown) {
    // If require() fails because the package is ESM-only, try loading the
    // native addon directly via node-gyp-build from the package root.
    const isEsmError =
      firstError instanceof Error &&
      (firstError as NodeJS.ErrnoException).code === 'ERR_REQUIRE_ASYNC_MODULE';
    if (!isEsmError) throw firstError;

    // Resolve package.json to find the package root, then use node-gyp-build.
    const pkgJsonPath = esmRequire.resolve(`${pkg}/package.json`);
    const pkgDir = dirname(pkgJsonPath);
    const nodeGypBuild = esmRequire('node-gyp-build') as (dir: string) => unknown;
    return nodeGypBuild(pkgDir);
  }
}

/**
 * Size of chunks returned to tree-sitter when parsing source text.
 *
 * We intentionally stream source via callback input instead of passing a raw
 * string to avoid a tree-sitter binding bug that can throw `Invalid argument`
 * on large files when it chunks strings internally.
 */
const PARSER_CHUNK_SIZE = 4096;

// ─── Grammar package map ──────────────────────────────────────────────────────

/**
 * Maps a language identifier (as returned by the file walker) to the npm
 * package name that exports the corresponding tree-sitter grammar.
 */
export const LANG_PACKAGES: Record<string, string> = {
  c:          'tree-sitter-c',
  rust:       'tree-sitter-rust',
  python:     'tree-sitter-python',
  cpp:        'tree-sitter-cpp',
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  go:         'tree-sitter-go',
  java:       'tree-sitter-java',
  csharp:     'tree-sitter-c-sharp',
  ruby:       'tree-sitter-ruby',
  php:        'tree-sitter-php',
  swift:      'tree-sitter-swift',
  kotlin:     'tree-sitter-kotlin',
  scala:      'tree-sitter-scala',
  lua:        '@tree-sitter-grammars/tree-sitter-lua',
  bash:       'tree-sitter-bash',
  elixir:     'tree-sitter-elixir',
  zig:        '@tree-sitter-grammars/tree-sitter-zig',
  ocaml:      'tree-sitter-ocaml',
  haskell:    'tree-sitter-haskell',
  julia:      'tree-sitter-julia',
  elm:        '@elm-tooling/tree-sitter-elm',
  objc:       'tree-sitter-objc',
};

/** Sorted list of all extractor languages with parser package mappings. */
export const SUPPORTED_PARSER_LANGUAGES: readonly string[] = Object.freeze(
  Object.keys(LANG_PACKAGES).sort(),
);

// ─── ParserPool ───────────────────────────────────────────────────────────────

/**
 * Maintains one `Parser` instance per language for efficient reuse.
 *
 * Grammar packages are loaded lazily on the first `parse()` call for a given
 * language.  If the package is not installed, `parse()` returns `null` and the
 * failed language is never retried.
 */
export class ParserPool {
  /** Cache of successfully initialised parsers, keyed by language. */
  private readonly parsers = new Map<string, Parser>();

  /** Languages whose grammar package could not be loaded. */
  private readonly unavailable = new Set<string>();

  /**
   * Parses `source` with the grammar for `language`.
   *
   * Returns `null` if the grammar package is not installed or `language` is
   * not recognised.  Each `Parser` instance is created once and reused.
   */
  parse(language: string, source: string): Parser.Tree | null {
    if (this.unavailable.has(language)) return null;

    if (!this.parsers.has(language)) {
      this.initParser(language);
    }

    const parser = this.parsers.get(language);
    if (!parser) return null;

    return parser.parse((offset) => source.slice(offset, offset + PARSER_CHUNK_SIZE));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private initParser(language: string): void {
    const pkg = LANG_PACKAGES[language];
    if (!pkg) {
      this.unavailable.add(language);
      return;
    }

    try {
      // Load the grammar package, handling both CJS and ESM-only packages.
      let grammar = loadGrammarPackage(pkg);

      // Some packages (e.g. tree-sitter-typescript) export sub-grammars.
      if (language === 'typescript' && grammar.typescript) {
        grammar = grammar.typescript;
      } else if (language === 'javascript' && grammar.javascript) {
        grammar = grammar.javascript;
      } else if (language === 'php' && grammar.php) {
        grammar = grammar.php;
      } else if (language === 'ocaml' && grammar.ocaml) {
        grammar = grammar.ocaml;
      }

      const parser = new Parser();
      parser.setLanguage(grammar);
      this.parsers.set(language, parser);
    } catch (error) {
      // Grammar not installed or ABI mismatch — mark as unavailable.
      this.unavailable.add(language);
      const log = getLogger();
      log.warn('parser', `grammar load failed for '${language}' (${pkg}) — all ${language} files will be skipped`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
