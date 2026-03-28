import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flag, flags, explicitLspEnabled, explicitScipEnabled, usage, LANG_TO_EXTS } from '../src/cli/args.js';

describe('CLI args', () => {
  describe('flag()', () => {
    it('returns the value after the flag', () => {
      expect(flag(['--db', '/path/to/db'], '--db')).toBe('/path/to/db');
    });

    it('returns undefined when flag is absent', () => {
      expect(flag(['--root', '/path'], '--db')).toBeUndefined();
    });

    it('returns the first occurrence', () => {
      expect(flag(['--db', 'first', '--db', 'second'], '--db')).toBe('first');
    });
  });

  describe('flags()', () => {
    it('returns all values for a repeatable flag', () => {
      expect(flags(['--include', 'a', '--include', 'b'], '--include')).toEqual(['a', 'b']);
    });

    it('returns empty array when flag is absent', () => {
      expect(flags(['--root', '/path'], '--include')).toEqual([]);
    });
  });

  describe('explicitLspEnabled()', () => {
    it('returns true when --lsp is present', () => {
      expect(explicitLspEnabled(['--lsp'])).toBe(true);
    });

    it('returns undefined when --lsp is absent', () => {
      expect(explicitLspEnabled(['--other'])).toBeUndefined();
    });
  });

  describe('explicitScipEnabled()', () => {
    it('returns false when --no-scip is present', () => {
      expect(explicitScipEnabled(['--no-scip'])).toBe(false);
    });

    it('returns undefined when --no-scip is absent', () => {
      expect(explicitScipEnabled(['--other'])).toBeUndefined();
    });
  });

  describe('usage()', () => {
    it('calls process.exit(1)', () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      const mockStderr = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => usage()).toThrow('exit');
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
      mockStderr.mockRestore();
    });
  });

  describe('LANG_TO_EXTS', () => {
    it('maps languages to extension arrays', () => {
      expect(LANG_TO_EXTS.typescript).toContain('.ts');
      expect(LANG_TO_EXTS.typescript).toContain('.tsx');
      expect(LANG_TO_EXTS.python).toContain('.py');
      expect(LANG_TO_EXTS.go).toContain('.go');
      expect(LANG_TO_EXTS.java).toContain('.java');
    });

    it('all values are non-empty arrays of strings', () => {
      for (const [lang, exts] of Object.entries(LANG_TO_EXTS)) {
        expect(Array.isArray(exts)).toBe(true);
        expect(exts.length).toBeGreaterThan(0);
        for (const ext of exts) {
          expect(ext.startsWith('.')).toBe(true);
        }
      }
    });
  });
});
