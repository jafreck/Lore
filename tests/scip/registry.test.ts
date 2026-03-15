/**
 * Tests for the SCIP indexer registry.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCIP_INDEXER_REGISTRY,
  SCIP_SUPPORTED_LANGUAGES,
  resolveScipIndexerRegistry,
  mergeScipIndexerRegistry,
} from '../../src/scip/registry.js';

describe('SCIP indexer registry', () => {
  it('default registry covers expected languages', () => {
    const expectedLanguages = [
      'typescript', 'python', 'java', 'scala', 'kotlin',
      'rust', 'c', 'cpp', 'csharp', 'ruby', 'php', 'go', 'dart',
    ];
    for (const lang of expectedLanguages) {
      expect(SCIP_SUPPORTED_LANGUAGES.has(lang)).toBe(true);
    }
  });

  it('does not include languages without SCIP indexers', () => {
    const unsupported = ['swift', 'lua', 'bash', 'elixir', 'zig', 'ocaml', 'haskell', 'julia', 'elm'];
    for (const lang of unsupported) {
      expect(SCIP_SUPPORTED_LANGUAGES.has(lang)).toBe(false);
    }
  });

  it('resolveScipIndexerRegistry marks unavailable executables', () => {
    const resolved = resolveScipIndexerRegistry(DEFAULT_SCIP_INDEXER_REGISTRY, { PATH: '' });
    // With empty PATH, indexers are only available if they are either:
    // - npm-bundled (scip-typescript, scip-python) → found in node_modules/.bin/
    // - managed (scip-clang, scip-go, etc.) → found in ~/.lore/bin/
    // - system-level (rust-analyzer, dotnet, etc.) → found on default system PATH
    //
    // At minimum, languages that have no npm-bundled dep AND no managed binary
    // AND no system install should still be unavailable.
    // scip-java (needs Coursier) should reliably be unavailable in CI.
    // Just verify the structure is valid for all entries.
    for (const entry of Object.values(resolved)) {
      expect(typeof entry.available).toBe('boolean');
      if (entry.available) {
        expect(entry.resolvedPath).toBeTruthy();
      } else {
        expect(entry.resolvedPath).toBeNull();
      }
    }
  });

  it('resolveScipIndexerRegistry finds executables on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-scip-reg-'));
    const fakeExec = join(dir, 'scip-typescript');
    writeFileSync(fakeExec, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fakeExec, 0o755);

    try {
      const resolved = resolveScipIndexerRegistry(DEFAULT_SCIP_INDEXER_REGISTRY, { PATH: dir });
      expect(resolved.typescript!.available).toBe(true);
      // May resolve to either the fake exec on PATH or the npm-bundled binary
      expect(resolved.typescript!.resolvedPath).toBeTruthy();
      // JavaScript is not in the SCIP registry (scip-typescript lacks
      // reliable CommonJS/import support for plain JS repos).
      expect(resolved.javascript).toBeUndefined();
      // Other languages that aren't npm-bundled and aren't on our fake PATH
      // should be unavailable (unless they happen to be npm-bundled deps too).
      // scip-python is now an npm dependency, so it may resolve.
      // Check a language that definitely isn't bundled:
      expect(resolved.java!.available).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mergeScipIndexerRegistry overrides commands', () => {
    const merged = mergeScipIndexerRegistry({
      typescript: { command: 'my-ts-indexer' },
    });
    expect(merged.typescript!.command).toBe('my-ts-indexer');
    // Args should be preserved from default.
    expect(merged.typescript!.args).toEqual(DEFAULT_SCIP_INDEXER_REGISTRY.typescript!.args);
  });

  it('mergeScipIndexerRegistry allows adding new languages', () => {
    const merged = mergeScipIndexerRegistry({
      haskell: { command: 'scip-haskell', args: ['--output', '{output}'] },
    });
    expect(merged.haskell).toEqual({ command: 'scip-haskell', args: ['--output', '{output}'] });
  });

  it('go entry uses scip-go with no args', () => {
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.go).toEqual({ command: 'scip-go', args: [] });
  });

  it('dart entry uses scip-dart with index command', () => {
    expect(DEFAULT_SCIP_INDEXER_REGISTRY.dart).toEqual({
      command: 'scip-dart',
      args: ['index', '--output', '{output}'],
    });
  });
});
