import { describe, it, expect } from 'vitest';
import {
  buildSymbolDefinitionMap,
  buildInternalPrefixes,
  isExternalSymbol,
  buildContainmentIndex,
  findContainingSymbol,
} from '../../src/indexer/stages/scip-indexer.js';
import { classifyScipReference } from '../../src/indexer/stages/scip-helpers/symbol-kinds.js';
import { SymbolRole } from '../../src/scip/scip_pb.js';

describe('buildInternalPrefixes', () => {
  it('extracts first 4 space-separated tokens from symbol descriptors', () => {
    const indexes = [{
      documents: [{
        symbols: [{ symbol: 'scip-typescript npm @org/package 1.0.0 src/`index.ts`/greet().' }],
      }],
    }];
    const prefixes = buildInternalPrefixes(indexes);
    expect(prefixes.size).toBe(1);
    expect([...prefixes][0]).toBe('scip-typescript npm @org/package 1.0.0');
  });

  it('skips local symbols', () => {
    const indexes = [{
      documents: [{
        symbols: [{ symbol: 'local 42' }],
      }],
    }];
    const prefixes = buildInternalPrefixes(indexes);
    expect(prefixes.size).toBe(0);
  });

  it('takes first non-local symbol per document', () => {
    const indexes = [{
      documents: [{
        symbols: [
          { symbol: 'local 1' },
          { symbol: 'scip-typescript npm pkg 1.0.0 Class#method().' },
          { symbol: 'scip-typescript npm pkg 1.0.0 AnotherClass#method().' },
        ],
      }],
    }];
    const prefixes = buildInternalPrefixes(indexes);
    expect(prefixes.size).toBe(1);
  });

  it('handles multiple documents across indexes', () => {
    const indexes = [
      { documents: [{ symbols: [{ symbol: 'scip-typescript npm pkg1 1.0.0 foo.' }] }] },
      { documents: [{ symbols: [{ symbol: 'scip-go gomod example.com/pkg 1.0.0 bar.' }] }] },
    ];
    const prefixes = buildInternalPrefixes(indexes);
    expect(prefixes.size).toBe(2);
  });

  it('handles empty indexes', () => {
    expect(buildInternalPrefixes([]).size).toBe(0);
    expect(buildInternalPrefixes([{ documents: [] }]).size).toBe(0);
    expect(buildInternalPrefixes([{ documents: [{ symbols: [] }] }]).size).toBe(0);
  });

  it('handles symbols with fewer than 4 parts', () => {
    const indexes = [{
      documents: [{
        symbols: [{ symbol: 'scip-ts npm pkg' }], // only 3 parts
      }],
    }];
    const prefixes = buildInternalPrefixes(indexes);
    expect(prefixes.size).toBe(0);
  });
});

describe('isExternalSymbol', () => {
  const prefixes = new Set(['scip-typescript npm pkg 1.0.0']);

  it('returns false for internal symbols', () => {
    expect(isExternalSymbol('scip-typescript npm pkg 1.0.0 src/index.ts/foo().', prefixes)).toBe(false);
  });

  it('returns true for external symbols', () => {
    expect(isExternalSymbol('scip-typescript npm other-pkg 2.0.0 bar().', prefixes)).toBe(true);
  });

  it('returns false when no prefixes (empty set)', () => {
    expect(isExternalSymbol('anything', new Set())).toBe(false);
  });
});

describe('buildSymbolDefinitionMap', () => {
  it('maps definition occurrences to file locations', () => {
    const indexes = [{
      documents: [{
        relativePath: 'src/index.ts',
        occurrences: [
          { symbolRoles: SymbolRole.Definition, symbol: 'scip-ts npm pkg 1.0.0 foo().', range: [10, 5, 10, 8] },
          { symbolRoles: 0, symbol: 'scip-ts npm pkg 1.0.0 bar().', range: [20, 0] }, // not a definition
        ],
      }],
    }];
    const map = buildSymbolDefinitionMap(indexes, '/project');
    expect(map.size).toBe(1);
    const def = map.get('scip-ts npm pkg 1.0.0 foo().');
    expect(def).toBeDefined();
    expect(def!.line).toBe(10);
    expect(def!.character).toBe(5);
    expect(def!.filePath).toContain('src/index.ts');
  });

  it('skips local symbols', () => {
    const indexes = [{
      documents: [{
        relativePath: 'a.ts',
        occurrences: [
          { symbolRoles: SymbolRole.Definition, symbol: 'local 42', range: [0, 0] },
        ],
      }],
    }];
    const map = buildSymbolDefinitionMap(indexes, '/project');
    expect(map.size).toBe(0);
  });

  it('keeps first definition per symbol', () => {
    const indexes = [{
      documents: [
        {
          relativePath: 'a.ts',
          occurrences: [
            { symbolRoles: SymbolRole.Definition, symbol: 'sym1', range: [1, 0] },
          ],
        },
        {
          relativePath: 'b.ts',
          occurrences: [
            { symbolRoles: SymbolRole.Definition, symbol: 'sym1', range: [2, 0] },
          ],
        },
      ],
    }];
    const map = buildSymbolDefinitionMap(indexes, '/root');
    expect(map.get('sym1')!.line).toBe(1); // First one wins
  });

  it('handles empty indexes', () => {
    const map = buildSymbolDefinitionMap([], '/root');
    expect(map.size).toBe(0);
  });
});

describe('buildContainmentIndex', () => {
  it('groups spans by file_id', () => {
    const rows = [
      { id: 1, file_id: 100, start_line: 0, end_line: 10 },
      { id: 2, file_id: 100, start_line: 12, end_line: 20 },
      { id: 3, file_id: 200, start_line: 0, end_line: 5 },
    ];
    const index = buildContainmentIndex(rows);
    expect(index.get(100)!).toHaveLength(2);
    expect(index.get(200)!).toHaveLength(1);
  });

  it('handles empty rows', () => {
    const index = buildContainmentIndex([]);
    expect(index.size).toBe(0);
  });
});

describe('findContainingSymbol', () => {
  const index = new Map([
    [100, [
      { id: 1, startLine: 0, endLine: 10 },
      { id: 2, startLine: 12, endLine: 20 },
      { id: 3, startLine: 5, endLine: 8 },  // nested inside id:1
    ]],
  ]);

  it('finds containing symbol for a line', () => {
    expect(findContainingSymbol(index, 100, 3)).toBe(1);
    expect(findContainingSymbol(index, 100, 15)).toBe(2);
  });

  it('returns first match in iteration order for overlapping spans', () => {
    // id:1 (span 0-10) is iterated before id:3 (span 5-8), so line 6 → id:1
    expect(findContainingSymbol(index, 100, 6)).toBe(1);
  });

  it('returns null for line outside all spans', () => {
    expect(findContainingSymbol(index, 100, 25)).toBeNull();
  });

  it('returns null for unknown file id', () => {
    expect(findContainingSymbol(index, 999, 5)).toBeNull();
  });

  it('handles boundary lines (inclusive)', () => {
    expect(findContainingSymbol(index, 100, 0)).toBe(1);
    expect(findContainingSymbol(index, 100, 10)).toBe(1);
    expect(findContainingSymbol(index, 100, 12)).toBe(2);
    expect(findContainingSymbol(index, 100, 20)).toBe(2);
  });
});

// ─── classifyScipReference ────────────────────────────────────────────────────

describe('classifyScipReference', () => {
  describe('Tier 1: syntaxKind (authoritative when non-zero)', () => {
    it('classifies IdentifierFunction (15) as call', () => {
      expect(classifyScipReference('any.symbol.', 15)).toBe('call');
    });

    it('classifies IdentifierFunctionDefinition (16) as call', () => {
      expect(classifyScipReference('any.symbol.', 16)).toBe('call');
    });

    it('classifies IdentifierMacro (17) as call', () => {
      expect(classifyScipReference('any.symbol.', 17)).toBe('call');
    });

    it('classifies IdentifierMacroDefinition (18) as call', () => {
      expect(classifyScipReference('any.symbol.', 18)).toBe('call');
    });

    it('classifies IdentifierType (19) as type', () => {
      expect(classifyScipReference('any.symbol.', 19)).toBe('type');
    });

    it('classifies IdentifierBuiltinType (20) as type', () => {
      expect(classifyScipReference('any.symbol.', 20)).toBe('type');
    });

    it('skips IdentifierNamespace (14)', () => {
      // syntaxKind is non-zero but doesn't match call or type → falls through to tier 2
      // The symbol suffix '.' → tier 2 returns 'skip'
      expect(classifyScipReference('some.namespace/', 14)).toBe('skip');
    });

    it('skips IdentifierParameter (11)', () => {
      expect(classifyScipReference('some.param.', 11)).toBe('skip');
    });

    it('syntaxKind overrides descriptor suffix (term . symbol classified as call)', () => {
      // Term suffix '.' would normally be 'skip', but syntaxKind 15 = call
      expect(classifyScipReference('scip-typescript npm pkg 1.0 src/a.ts/arrowFn.', 15)).toBe('call');
    });
  });

  describe('Tier 2: descriptor suffix (fallback)', () => {
    it('classifies method/function suffix ().', () => {
      expect(classifyScipReference('scip-ts npm pkg 1.0 src/a.ts/foo().')).toBe('call');
    });

    it('classifies disambiguated method (+N).', () => {
      expect(classifyScipReference('scip-ts npm pkg 1.0 src/a.ts/overloaded(+1).')).toBe('call');
    });

    it('classifies scip-clang hex hash suffix as call', () => {
      expect(classifyScipReference('$ parse_analyze_fixedparams(39d222e79bbfb7c0).')).toBe('call');
    });

    it('classifies type suffix #', () => {
      expect(classifyScipReference('scip-ts npm pkg 1.0 src/a.ts/MyClass#')).toBe('type');
    });

    it('classifies type parameter suffix ]', () => {
      expect(classifyScipReference('scip-ts npm pkg 1.0 src/a.ts/MyClass#[T]')).toBe('type');
    });

    it('skips term suffix . (variable/property)', () => {
      expect(classifyScipReference('scip-ts npm pkg 1.0 src/a.ts/myVar.')).toBe('skip');
    });

    it('skips namespace suffix /', () => {
      expect(classifyScipReference('scip-ts npm pkg 1.0 src/a.ts/')).toBe('skip');
    });

    it('syntaxKind 0 falls through to tier 2', () => {
      expect(classifyScipReference('scip-ts npm pkg 1.0 src/a.ts/foo().', 0)).toBe('call');
    });
  });
});
