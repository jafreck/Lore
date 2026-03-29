import { describe, it, expect } from 'vitest';
import {
  inferLoreLanguage,
} from '../../src/indexer/stages/scip-helpers/ingest.js';

// ─── inferLoreLanguage ────────────────────────────────────────────────────────

describe('inferLoreLanguage', () => {
  describe('maps SCIP language strings', () => {
    const cases: Array<[string, string]> = [
      ['typescript', 'typescript'],
      ['typescriptreact', 'typescript'],
      ['javascript', 'javascript'],
      ['javascriptreact', 'javascript'],
      ['python', 'python'],
      ['java', 'java'],
      ['scala', 'scala'],
      ['kotlin', 'kotlin'],
      ['rust', 'rust'],
      ['c', 'c'],
      ['c++', 'cpp'],
      ['cpp', 'cpp'],
      ['c#', 'csharp'],
      ['csharp', 'csharp'],
      ['ruby', 'ruby'],
      ['php', 'php'],
      ['go', 'go'],
    ];

    for (const [scip, expected] of cases) {
      it(`maps "${scip}" → "${expected}"`, () => {
        expect(inferLoreLanguage(scip, 'foo.txt')).toBe(expected);
      });
    }

    it('is case-insensitive', () => {
      expect(inferLoreLanguage('TypeScript', 'foo.txt')).toBe('typescript');
      expect(inferLoreLanguage('PYTHON', 'foo.txt')).toBe('python');
    });
  });

  describe('falls back to file extension', () => {
    it('infers typescript from .ts', () => {
      expect(inferLoreLanguage('', 'src/main.ts')).toBe('typescript');
    });
    it('infers typescript from .tsx', () => {
      expect(inferLoreLanguage('', 'src/App.tsx')).toBe('typescript');
    });
    it('infers python from .py', () => {
      expect(inferLoreLanguage('', 'main.py')).toBe('python');
    });
    it('infers go from .go', () => {
      expect(inferLoreLanguage('', 'main.go')).toBe('go');
    });
    it('infers java from .java', () => {
      expect(inferLoreLanguage('', 'Main.java')).toBe('java');
    });
    it('infers rust from .rs', () => {
      expect(inferLoreLanguage('', 'lib.rs')).toBe('rust');
    });
    it('returns null for unknown extension', () => {
      expect(inferLoreLanguage('', 'data.xyz')).toBeNull();
    });
    it('returns null for no extension', () => {
      expect(inferLoreLanguage('', 'Makefile')).toBeNull();
    });
  });

  describe('prefers explicit language over extension', () => {
    it('uses SCIP language when both are available', () => {
      expect(inferLoreLanguage('python', 'main.ts')).toBe('python');
    });
  });
});
