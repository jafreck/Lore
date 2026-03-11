import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_PARSER_LANGUAGES } from '../../src/parsing/parser.js';
import { SUPPORTED_WALKER_LANGUAGES } from '../../src/discovery/walker.js';
import {
  DEFAULT_LSP_SERVER_REGISTRY,
  getDefaultLspServerRegistry,
  getMissingLanguageServerCommands,
  hasCompleteLanguageCoverage,
  mergeLspServerRegistry,
  resolveExecutableOnPath,
  resolveLspServerRegistry,
} from '../../src/lsp/registry.js';

describe('LSP registry defaults', () => {
  it('covers all parser-supported extractor languages', () => {
    expect(Object.keys(DEFAULT_LSP_SERVER_REGISTRY).sort()).toEqual([...SUPPORTED_PARSER_LANGUAGES].sort());
    expect(hasCompleteLanguageCoverage()).toBe(true);
  });

  it('stays synchronized with walker language detection coverage', () => {
    expect(Object.keys(DEFAULT_LSP_SERVER_REGISTRY).sort()).toEqual([...SUPPORTED_WALKER_LANGUAGES].sort());
  });

  it('returns cloned defaults so callers cannot mutate module defaults', () => {
    const defaults = getDefaultLspServerRegistry();
    defaults.typescript = { command: 'custom', args: [] };
    expect(DEFAULT_LSP_SERVER_REGISTRY.typescript?.command).toBe('typescript-language-server');
  });
});

describe('LSP registry resolution', () => {
  it('resolves PATH entries and reports missing commands without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lore-lsp-registry-'));
    try {
      const fakeServer = join(tmp, 'fake-server');
      writeFileSync(fakeServer, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(fakeServer, 0o755);

      const resolved = resolveLspServerRegistry(
        {
          typescript: { command: 'fake-server', args: ['--stdio'] },
          python: { command: 'missing-server', args: ['--stdio'] },
        },
        { ...process.env, PATH: tmp },
      );

      expect(resolved.typescript?.available).toBe(true);
      expect(resolved.typescript?.resolvedPath).toBe(fakeServer);
      expect(resolved.python?.available).toBe(false);
      expect(resolved.python?.resolvedPath).toBeNull();
      expect(
        getMissingLanguageServerCommands(
          {
            typescript: { command: 'fake-server', args: ['--stdio'] },
            python: { command: 'missing-server', args: ['--stdio'] },
          },
          { ...process.env, PATH: tmp },
        ),
      ).toEqual(['python']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('merges per-language command and args overrides', () => {
    const merged = mergeLspServerRegistry({
      typescript: { command: 'custom-ts-ls' },
      python: { args: ['--custom'] },
    });

    expect(merged.typescript).toEqual({ command: 'custom-ts-ls', args: ['--stdio'] });
    expect(merged.python).toEqual({ command: 'pyright-langserver', args: ['--custom'] });
  });

  it('returns null for empty command names and resolves absolute executable paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lore-lsp-resolve-cmd-'));
    try {
      const executablePath = join(tmp, 'server-bin');
      writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(executablePath, 0o755);

      expect(resolveExecutableOnPath('   ')).toBeNull();
      expect(resolveExecutableOnPath(executablePath)).toBe(executablePath);
      expect(resolveExecutableOnPath(join(tmp, 'missing-bin'))).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
