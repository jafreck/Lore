import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CliArgumentError,
  explicitLspEnabled,
  explicitScipEnabled,
  explicitBuildExecutionAllowed,
  executionOptionsFromArgs,
  parseCliArgs,
  usage,
  LANG_TO_EXTS,
  walkerConfigFromArgs,
  scipScopeFromArgs,
} from '../src/cli/args.js';

describe('CLI args', () => {
  describe('scipScopeFromArgs()', () => {
    it.each(['index', 'doctor', 'validate'])('parses explicit host scope for %s independently of permissions', (command) => {
      const parsed = parseCliArgs([
        command, '--scip-scope-language', 'cpp', '--scip-scope-language', 'c',
        '--scip-scope-include', 'lib/**/*.{c,h}', '--scip-scope-include', 'programs/**/*.{c,h}',
        '--scip-scope-exclude', '**/generated/**',
      ]);
      expect(scipScopeFromArgs(parsed)).toEqual({
        languages: ['c', 'cpp'], includeGlobs: ['lib/**/*.{c,h}', 'programs/**/*.{c,h}'],
        excludeGlobs: ['**/generated/**'],
      });
      expect(executionOptionsFromArgs(parsed)).toEqual({});
    });

    it('requires explicit languages and rejects traversal, unknown languages, and disabled SCIP', () => {
      expect(scipScopeFromArgs(['index'])).toBeUndefined();
      expect(() => scipScopeFromArgs(['--scip-scope-include', 'lib/**'])).toThrow('at least one language');
      expect(() => scipScopeFromArgs(['--scip-scope-language', 'c', '--scip-scope-include', '../**']))
        .toThrow('root-relative');
      expect(() => scipScopeFromArgs(['--scip-scope-language', 'unknown'])).toThrow('Unknown');
      expect(() => scipScopeFromArgs(['--scip-scope-language', 'c', '--no-scip'])).toThrow('cannot be used together');
    });
  });

  describe('parseCliArgs()', () => {
    it('parses values, booleans, and repeatable options from a command schema', () => {
      const parsed = parseCliArgs([
        'index', '--db', '/tmp/lore.db', '--root', '/repo', '--embeddings',
        '--include', 'src/**', '--include', 'tests/**',
      ]);
      expect(parsed.command).toBe('index');
      expect(parsed.value('--db')).toBe('/tmp/lore.db');
      expect(parsed.has('--embeddings')).toBe(true);
      expect(parsed.values('--include')).toEqual(['src/**', 'tests/**']);
    });

    it.each([
      [['index', '--root'], 'option --root requires a value'],
      [['index', '--root', '--db', 'lore.db'], 'option --root requires a value'],
      [['index', '--root', '-x'], 'option --root requires a value'],
      [['index', '--unknown'], 'unknown option for index: --unknown'],
      [['index', 'unexpected'], 'unexpected argument for index: unexpected'],
      [['index', '--root', '/one', '--root', '/two'], 'option --root may only be provided once'],
      [['analyze', '--db', 'lore.db', '--include', 'src/**'], 'unknown option for analyze: --include'],
    ])('rejects malformed argv %j', (argv, message) => {
      expect(() => parseCliArgs(argv)).toThrow(message);
    });

    it.each([
      ['refresh', '--watch', '--poll'],
      ['index', '--lsp', '--no-lsp'],
      ['index', '--scip', '--no-scip'],
      ['index', '--embeddings', '--no-embeddings'],
      ['index', '--embedding-model', 'model', '--no-embeddings'],
      ['refresh', '--embeddings', '--no-embeddings'],
      ['refresh', '--embedding-model', 'model', '--no-embeddings'],
    ])('rejects conflicting options for %s', (command, ...options) => {
      expect(() => parseCliArgs([command, ...options])).toThrow('cannot be used together');
    });

    it('validates typed option values in the schema', () => {
      expect(() => parseCliArgs(['index', '--max-workers', '0']))
        .toThrow('--max-workers must be a positive integer');
      expect(() => parseCliArgs(['doctor', '--min-symbol-coverage', '1.1']))
        .toThrow('--min-symbol-coverage must be a number from 0 to 1');
      expect(() => parseCliArgs(['analyze', '--mode', 'unknown']))
        .toThrow('--mode must be one of');
    });

    it('accepts explicit embedding disablement for one-shot and live refresh', () => {
      expect(() => parseCliArgs(['refresh', '--no-embeddings'])).not.toThrow();
      expect(() => parseCliArgs(['refresh', '--watch', '--no-embeddings'])).not.toThrow();
      expect(() => parseCliArgs(['refresh', '--poll', '--no-embeddings'])).not.toThrow();
    });

    it('uses a dedicated argument error type', () => {
      expect(() => parseCliArgs(['missing'])).toThrow(CliArgumentError);
    });
  });

  describe('explicitLspEnabled()', () => {
    it('returns true when --lsp is present', () => {
      expect(explicitLspEnabled(['--lsp'])).toBe(true);
    });

    it('returns undefined when --lsp is absent', () => {
      expect(explicitLspEnabled(['--other'])).toBeUndefined();
    });

    it('supports explicit disable and rejects conflicts', () => {
      expect(explicitLspEnabled(['--no-lsp'])).toBe(false);
      expect(() => explicitLspEnabled(['--lsp', '--no-lsp'])).toThrow('cannot be used together');
    });
  });

  describe('explicitScipEnabled()', () => {
    it('returns false when --no-scip is present', () => {
      expect(explicitScipEnabled(['--no-scip'])).toBe(false);
    });

    it('returns true when --scip is present and rejects conflicts', () => {
      expect(explicitScipEnabled(['--scip'])).toBe(true);
      expect(() => explicitScipEnabled(['--scip', '--no-scip'])).toThrow('cannot be used together');
    });

    it('returns undefined when --no-scip is absent', () => {
      expect(explicitScipEnabled(['--other'])).toBeUndefined();
    });
  });

  describe('explicitBuildExecutionAllowed()', () => {
    it('returns true only for the explicit opt-in flag', () => {
      expect(explicitBuildExecutionAllowed(['--allow-build-execution'])).toBe(true);
      expect(explicitBuildExecutionAllowed(['--other'])).toBeUndefined();
    });
  });

  describe('executionOptionsFromArgs()', () => {
    it('returns no permissions when trust flags are absent', () => {
      expect(executionOptionsFromArgs(['index'])).toEqual({});
    });

    it('parses capabilities and repeatable approved cwd roots', () => {
      expect(executionOptionsFromArgs([
        '--allow-subprocess-execution',
        '--allow-build-execution',
        '--allow-custom-indexer-commands',
        '--allow-custom-lsp-commands',
        '--allow-auto-install',
        '--allow-command-cwd', '/trusted/one',
        '--allow-command-cwd', '/trusted/two',
        '--allow-external-build-root', '/trusted/build',
      ])).toEqual({
        allowSubprocessExecution: true,
        allowBuildExecution: true,
        allowCustomIndexerCommands: true,
        allowCustomLspCommands: true,
        allowAutoInstall: true,
        allowedCwdRoots: ['/trusted/one', '/trusted/two', '/trusted/build'],
      });
    });
  });

  describe('walkerConfigFromArgs()', () => {
    it('preserves one scope across baseline and live indexing callers', () => {
      const parsed = parseCliArgs([
        'refresh', '--root', '/repo', '--db', '/tmp/lore.db', '--watch',
        '--include', 'src/**', '--exclude', '**/*.gen.ts',
        '--language', 'typescript', '--language', 'cpp',
      ]);
      expect(walkerConfigFromArgs(parsed, '/repo')).toEqual({
        rootDir: '/repo',
        includeGlobs: ['src/**'],
        excludeGlobs: ['**/*.gen.ts'],
        extensions: ['.ts', '.tsx', '.C', '.c++', '.cc', '.cpp', '.cxx', '.h++', '.hh', '.hpp', '.hxx'],
      });
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
      expect(mockStderr).toHaveBeenCalled();

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
