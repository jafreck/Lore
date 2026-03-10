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
} from '../../../src/indexer/scip/registry.js';

describe('SCIP indexer registry', () => {
  it('default registry covers expected languages', () => {
    const expectedLanguages = [
      'typescript', 'javascript', 'python', 'java', 'scala', 'kotlin',
      'rust', 'c', 'cpp', 'csharp', 'ruby', 'php',
    ];
    for (const lang of expectedLanguages) {
      expect(SCIP_SUPPORTED_LANGUAGES.has(lang)).toBe(true);
    }
  });

  it('does not include languages without SCIP indexers', () => {
    const unsupported = ['go', 'swift', 'lua', 'bash', 'elixir', 'zig', 'ocaml', 'haskell', 'julia', 'elm'];
    for (const lang of unsupported) {
      expect(SCIP_SUPPORTED_LANGUAGES.has(lang)).toBe(false);
    }
  });

  it('resolveScipIndexerRegistry marks unavailable executables', () => {
    const resolved = resolveScipIndexerRegistry(DEFAULT_SCIP_INDEXER_REGISTRY, { PATH: '' });
    for (const entry of Object.values(resolved)) {
      expect(entry.available).toBe(false);
      expect(entry.resolvedPath).toBeNull();
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
      expect(resolved.typescript!.resolvedPath).toBe(fakeExec);
      // JavaScript also uses scip-typescript.
      expect(resolved.javascript!.available).toBe(true);
      // Python uses scip-python which isn't in our fake PATH.
      expect(resolved.python!.available).toBe(false);
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
      dart: { command: 'scip-dart', args: ['--output', '{output}'] },
    });
    expect(merged.dart).toEqual({ command: 'scip-dart', args: ['--output', '{output}'] });
  });
});
