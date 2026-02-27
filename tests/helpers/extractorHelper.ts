import fs from 'node:fs';
import { ParserPool } from '../../src/indexer/parser.js';
import type { ExtractionResult, SymbolExtractor } from '../../src/indexer/extractors/types.js';

/** Shared parser pool reused across all tests. */
const pool = new ParserPool();

/**
 * Parses `fixturePath` for the given `language` and runs `extractor.extract()`.
 * Returns `null` when the grammar is unavailable (so callers can skip the test).
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
