import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LSP_SERVER_REGISTRY,
  getDefaultLspServerRegistry,
  mergeLspServerRegistry,
  resolveLspServerRegistry,
  resolveExecutableOnPath,
  getMissingLanguageServerCommands,
  hasCompleteLanguageCoverage,
} from '../../src/lsp/registry.js';

describe('DEFAULT_LSP_SERVER_REGISTRY', () => {
  it('has entries for common languages', () => {
    expect(DEFAULT_LSP_SERVER_REGISTRY).toHaveProperty('typescript');
    expect(DEFAULT_LSP_SERVER_REGISTRY).toHaveProperty('python');
    expect(DEFAULT_LSP_SERVER_REGISTRY).toHaveProperty('go');
    expect(DEFAULT_LSP_SERVER_REGISTRY).toHaveProperty('rust');
    expect(DEFAULT_LSP_SERVER_REGISTRY).toHaveProperty('java');
  });

  it('each entry has command and args', () => {
    for (const [lang, cfg] of Object.entries(DEFAULT_LSP_SERVER_REGISTRY)) {
      expect(cfg).toHaveProperty('command');
      expect(cfg).toHaveProperty('args');
      expect(typeof cfg.command).toBe('string');
      expect(Array.isArray(cfg.args)).toBe(true);
    }
  });
});

describe('getDefaultLspServerRegistry', () => {
  it('returns a clone, not the original', () => {
    const clone = getDefaultLspServerRegistry();
    expect(clone).toEqual(DEFAULT_LSP_SERVER_REGISTRY);
    clone.typescript.command = 'mutated';
    expect(DEFAULT_LSP_SERVER_REGISTRY.typescript.command).not.toBe('mutated');
  });
});

describe('mergeLspServerRegistry', () => {
  it('returns defaults when no overrides', () => {
    const merged = mergeLspServerRegistry();
    expect(merged).toEqual(DEFAULT_LSP_SERVER_REGISTRY);
  });

  it('overrides command for a language', () => {
    const merged = mergeLspServerRegistry({
      typescript: { command: 'my-custom-ts' },
    });
    expect(merged.typescript.command).toBe('my-custom-ts');
    // args should remain from default
    expect(merged.typescript.args).toEqual(DEFAULT_LSP_SERVER_REGISTRY.typescript.args);
  });

  it('overrides args for a language', () => {
    const merged = mergeLspServerRegistry({
      python: { args: ['--custom-flag'] },
    });
    expect(merged.python.args).toEqual(['--custom-flag']);
    expect(merged.python.command).toBe(DEFAULT_LSP_SERVER_REGISTRY.python.command);
  });

  it('throws for unsupported language', () => {
    expect(() => mergeLspServerRegistry({ foobar: { command: 'x' } })).toThrow(
      'Unsupported LSP language override',
    );
  });

  it('skips null/undefined overrides', () => {
    const merged = mergeLspServerRegistry({ typescript: undefined });
    expect(merged.typescript).toEqual(DEFAULT_LSP_SERVER_REGISTRY.typescript);
  });
});

describe('resolveExecutableOnPath', () => {
  it('returns null for empty command', () => {
    expect(resolveExecutableOnPath('', {})).toBeNull();
    expect(resolveExecutableOnPath('   ', {})).toBeNull();
  });

  it('resolves known executables on PATH', () => {
    // 'node' should be resolvable on any dev machine
    const result = resolveExecutableOnPath('node');
    expect(result).not.toBeNull();
  });

  it('returns null for non-existent command', () => {
    const result = resolveExecutableOnPath('definitely-not-a-real-binary-xyzzy-123');
    expect(result).toBeNull();
  });

  it('handles absolute path that exists', () => {
    const nodePath = resolveExecutableOnPath('node');
    if (nodePath) {
      const result = resolveExecutableOnPath(nodePath);
      expect(result).toBe(nodePath);
    }
  });
});

describe('resolveLspServerRegistry', () => {
  it('returns resolved entries for all languages', () => {
    const resolved = resolveLspServerRegistry();
    for (const [lang, entry] of Object.entries(resolved)) {
      expect(entry).toHaveProperty('language', lang);
      expect(entry).toHaveProperty('command');
      expect(entry).toHaveProperty('args');
      expect(entry).toHaveProperty('available');
      expect(entry).toHaveProperty('resolvedPath');
      expect(typeof entry.available).toBe('boolean');
    }
  });
});

describe('getMissingLanguageServerCommands', () => {
  it('returns sorted list of missing languages', () => {
    const missing = getMissingLanguageServerCommands();
    expect(Array.isArray(missing)).toBe(true);
    // Verify it is sorted
    const sorted = [...missing].sort();
    expect(missing).toEqual(sorted);
  });
});

describe('hasCompleteLanguageCoverage', () => {
  it('returns a boolean indicating coverage state', () => {
    const result = hasCompleteLanguageCoverage();
    expect(typeof result).toBe('boolean');
    // Should be deterministic for the same environment
    expect(hasCompleteLanguageCoverage()).toBe(result);
  });
});
