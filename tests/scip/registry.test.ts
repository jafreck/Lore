import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCIP_INDEXER_REGISTRY,
  SCIP_SUPPORTED_LANGUAGES,
  getDefaultScipIndexerRegistry,
  mergeScipIndexerRegistry,
  resolveScipIndexerRegistry,
  type ScipIndexerRegistry,
  type ScipIndexerRegistryOverrides,
} from '../../src/scip/registry.js';

describe('SCIP_SUPPORTED_LANGUAGES', () => {
  it('is a Set of all default registry keys', () => {
    const keys = Object.keys(DEFAULT_SCIP_INDEXER_REGISTRY);
    expect(SCIP_SUPPORTED_LANGUAGES.size).toBe(keys.length);
    for (const key of keys) {
      expect(SCIP_SUPPORTED_LANGUAGES.has(key)).toBe(true);
    }
  });

  it('contains expected languages', () => {
    const expected = ['typescript', 'python', 'java', 'rust', 'go', 'c', 'cpp', 'csharp', 'ruby', 'php'];
    for (const lang of expected) {
      expect(SCIP_SUPPORTED_LANGUAGES.has(lang)).toBe(true);
    }
  });
});

describe('DEFAULT_SCIP_INDEXER_REGISTRY', () => {
  it('has command and args for each entry', () => {
    for (const [lang, cmd] of Object.entries(DEFAULT_SCIP_INDEXER_REGISTRY)) {
      expect(typeof cmd.command).toBe('string');
      expect(cmd.command.length).toBeGreaterThan(0);
      expect(Array.isArray(cmd.args)).toBe(true);
    }
  });

  it('java, scala, kotlin share scip-java command', () => {
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.java?.command).toBe('scip-java');
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.scala?.command).toBe('scip-java');
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.kotlin?.command).toBe('scip-java');
  });

  it('c and cpp share scip-clang command', () => {
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.c?.command).toBe('scip-clang');
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.cpp?.command).toBe('scip-clang');
  });
});

describe('getDefaultScipIndexerRegistry', () => {
  it('returns a deep clone', () => {
    const registry = getDefaultScipIndexerRegistry();
    expect(registry).toEqual(DEFAULT_SCIP_INDEXER_REGISTRY);

    // Mutate clone — original should not change
    registry.typescript!.command = 'modified';
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.typescript?.command).toBe('scip-typescript');
  });

  it('clones args arrays', () => {
    const registry = getDefaultScipIndexerRegistry();
    registry.typescript!.args.push('extra');
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.typescript?.args).not.toContain('extra');
  });
});

describe('mergeScipIndexerRegistry', () => {
  it('returns defaults when no overrides given', () => {
    const merged = mergeScipIndexerRegistry();
    expect(Object.keys(merged).length).toBe(Object.keys(DEFAULT_SCIP_INDEXER_REGISTRY).length);
  });

  it('overrides command for existing language', () => {
    const merged = mergeScipIndexerRegistry({
      typescript: { command: 'custom-ts' },
    });
    expect(merged.typescript?.command).toBe('custom-ts');
    // args should be preserved from defaults
    expect(merged.typescript?.args).toEqual(DEFAULT_SCIP_INDEXER_REGISTRY.typescript?.args);
  });

  it('overrides args for existing language', () => {
    const merged = mergeScipIndexerRegistry({
      typescript: { args: ['--custom'] },
    });
    expect(merged.typescript?.args).toEqual(['--custom']);
    expect(merged.typescript?.command).toBe('scip-typescript');
  });

  it('adds new languages not in default registry', () => {
    const merged = mergeScipIndexerRegistry({
      haskell: { command: 'scip-haskell', args: ['index'] },
    });
    expect(merged.haskell).toBeDefined();
    expect(merged.haskell?.command).toBe('scip-haskell');
  });

  it('does not add incomplete new languages', () => {
    const merged = mergeScipIndexerRegistry({
      haskell: { command: 'scip-haskell' },
    });
    // Missing args — should not be added
    expect(merged.haskell).toBeUndefined();
  });

  it('handles undefined override values', () => {
    const overrides: ScipIndexerRegistryOverrides = { typescript: undefined };
    const merged = mergeScipIndexerRegistry(overrides);
    expect(merged.typescript?.command).toBe('scip-typescript');
  });
});

describe('resolveScipIndexerRegistry', () => {
  it('resolves all registry entries', () => {
    const resolved = resolveScipIndexerRegistry(DEFAULT_SCIP_INDEXER_REGISTRY, {});
    for (const lang of Object.keys(DEFAULT_SCIP_INDEXER_REGISTRY)) {
      expect(resolved[lang]).toBeDefined();
      expect(resolved[lang]!.language).toBe(lang);
      expect(typeof resolved[lang]!.available).toBe('boolean');
    }
  });

  it('marks commands as unavailable when not on PATH', () => {
    // With empty env, nothing should be found on PATH
    const resolved = resolveScipIndexerRegistry(DEFAULT_SCIP_INDEXER_REGISTRY, {});
    // Most SCIP indexers won't be installed in test environments
    for (const entry of Object.values(resolved)) {
      expect(typeof entry.available).toBe('boolean');
      if (!entry.available) {
        expect(entry.resolvedPath).toBeNull();
      }
    }
  });

  it('deduplicates resolution for shared commands', () => {
    // java, scala, kotlin all use scip-java — should resolve once
    const resolved = resolveScipIndexerRegistry(DEFAULT_SCIP_INDEXER_REGISTRY, {});
    const javaAvail = resolved.java?.available;
    expect(resolved.scala?.available).toBe(javaAvail);
    expect(resolved.kotlin?.available).toBe(javaAvail);
  });
});

describe('DEFAULT_SCIP_INDEXER_REGISTRY (indexer-specific args)', () => {
  it('ruby uses bare path arg (no --output)', () => {
    const entry = DEFAULT_SCIP_INDEXER_REGISTRY.ruby!;
    expect(entry.command).toBe('scip-ruby');
    expect(entry.args).toEqual(['.']);
    expect(entry.args).not.toContain('--output');
  });

  it('php uses empty args (writes index.scip in cwd)', () => {
    const entry = DEFAULT_SCIP_INDEXER_REGISTRY.php!;
    expect(entry.command).toBe('scip-php');
    expect(entry.args).toEqual([]);
  });

  it('csharp uses {project} placeholder', () => {
    const entry = DEFAULT_SCIP_INDEXER_REGISTRY.csharp!;
    expect(entry.command).toBe('scip-dotnet');
    expect(entry.args).toContain('{project}');
    expect(entry.args).toContain('{output}');
  });
});
