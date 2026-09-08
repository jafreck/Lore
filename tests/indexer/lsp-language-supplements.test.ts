import { describe, expect, it } from 'vitest';
import type { DocumentSymbol } from '../../src/lsp/client.js';
import {
  extractPreprocessorMacros,
  getLanguageSupplementProvider,
} from '../../src/indexer/stages/lsp-language-supplements.js';

function symbol(name: string, line: number): DocumentSymbol {
  return {
    name,
    kind: 14,
    range: {
      start: { line, character: 0 },
      end: { line, character: 24 },
    },
    selectionRange: {
      start: { line, character: 8 },
      end: { line, character: 8 + name.length },
    },
    children: [],
  };
}

describe('C macro supplement provider', () => {
  it('records conditional provenance as heuristic in raw extraction', () => {
    const macros = extractPreprocessorMacros([
      '#define ALWAYS 1',
      '#if FEATURE_X',
      '#define MAYBE 2',
      '#else',
      '#define FALLBACK 3',
      '#endif',
    ].join('\n'));

    expect(macros).toEqual([
      expect.objectContaining({
        name: 'ALWAYS', conditional: false, condition: null, heuristic: false,
      }),
      expect.objectContaining({
        name: 'MAYBE', conditional: true, condition: 'FEATURE_X', heuristic: true,
      }),
      expect.objectContaining({
        name: 'FALLBACK', conditional: true, condition: 'else(FEATURE_X)', heuristic: true,
      }),
    ]);
  });

  it('does not treat comment markers inside macro literals as comments', () => {
    const macros = extractPreprocessorMacros([
      '#define BLOCK_MARKER "/*"',
      '#define URL "https://example.test/path"',
      '#define NEXT 1',
    ].join('\n'));
    expect(macros.map((macro) => macro.name)).toEqual(['BLOCK_MARKER', 'URL', 'NEXT']);
  });

  it('omits unconfirmed conditional macros and inserts only compiler-visible ones', () => {
    const source = [
      '#define ALWAYS 1',
      '#if FEATURE_X',
      '#define MAYBE 2',
      '#define HIDDEN 3',
      '#endif',
    ].join('\n');
    const visible = symbol('MAYBE', 2);
    const provider = getLanguageSupplementProvider('cpp');
    const result = provider!.collect({
      filePath: '/repo/config.h',
      language: 'cpp',
      source,
      documentSymbols: [visible],
      nextIndex: 0,
    });

    expect(result.symbols.map((item) => item.name)).toEqual(['ALWAYS', 'MAYBE']);
    expect(result.symbols[1]?.provenance).toBe('lsp-visible-conditional');
    expect(result.symbols[1]?.docComment).toContain('condition=FEATURE_X');
    expect(result.consumedDocumentSymbols.has(visible)).toBe(true);
    expect(result.diagnostics.heuristicConditionalMacrosSkipped).toBe(1);
  });

  it('has no raw macro hook for non-C languages', () => {
    expect(getLanguageSupplementProvider('typescript')).toBeNull();
  });
});
