import fs from 'node:fs';
import { ParserPool } from '../../src/parsing/parser.js';
import type { ExtractionResult, SymbolExtractor } from '../../src/parsing/extractors/types.js';

/** Shared parser pool reused across all tests. */
const pool = new ParserPool();

/**
 * Parses `fixturePath` for the given `language` and runs `extractor.extract()`.
 * Returns `null` when the grammar is unavailable (so callers can skip the test).
 *
 * @deprecated Prefer {@link parseAndExtractStrict} which fails on grammar errors.
 */
export function parseAndExtract(
  language: string,
  fixturePath: string,
  extractor: SymbolExtractor,
): ExtractionResult | null {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const tree = pool.parse(language, source);
  if (!tree) return null;
  return extractor.extract(tree, source, fixturePath);
}

/**
 * Parses `fixturePath` for the given `language` and runs `extractor.extract()`.
 * **Throws** when the grammar fails to load, ensuring grammar breakage is never
 * silently swallowed.
 */
export function parseAndExtractStrict(
  language: string,
  fixturePath: string,
  extractor: SymbolExtractor,
): ExtractionResult {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const tree = pool.parse(language, source);
  if (!tree) {
    throw new Error(
      `Grammar for '${language}' failed to load or parse '${fixturePath}'. ` +
      `Run \`npm rebuild tree-sitter-${language}\` to fix native bindings.`,
    );
  }
  return extractor.extract(tree, source, fixturePath);
}

/**
 * Parses an inline source string for the given `language` and runs
 * `extractor.extract()`.  Throws when the grammar fails to load.
 *
 * Use for focused scenario tests that need exact assertions rather than
 * aggregate checks over a large fixture file.
 */
export function parseInlineSource(
  language: string,
  source: string,
  extractor: SymbolExtractor,
  filePath = `test.${language}`,
): ExtractionResult {
  const tree = pool.parse(language, source);
  if (!tree) {
    throw new Error(
      `Grammar for '${language}' failed to load. ` +
      `Run \`npm rebuild tree-sitter-${language}\` to fix native bindings.`,
    );
  }
  return extractor.extract(tree, source, filePath);
}
