import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LSP_ENABLED,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  loadLspSettingsFromLoreConfig,
  resolveEffectiveLspSettings,
} from '../../src/lsp/config.js';

describe('loadLspSettingsFromLoreConfig', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-config-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('should return empty overrides when .lore.config does not exist', () => {
    expect(loadLspSettingsFromLoreConfig(rootDir)).toEqual({});
  });

  it('should return empty overrides when lsp section is absent', () => {
    writeFileSync(join(rootDir, '.lore.config'), JSON.stringify({ app: { name: 'demo' } }), 'utf8');
    expect(loadLspSettingsFromLoreConfig(rootDir)).toEqual({});
  });

  it('should parse valid LSP settings and map timeoutMs to requestTimeoutMs', () => {
    writeFileSync(
      join(rootDir, '.lore.config'),
      JSON.stringify({
        lsp: {
          enabled: true,
          timeoutMs: 9876,
          servers: {
            typescript: {
              command: 'custom-ts-ls',
              args: ['--stdio'],
            },
            python: {
              args: ['--custom'],
            },
          },
        },
      }),
      'utf8',
    );

    expect(loadLspSettingsFromLoreConfig(rootDir)).toEqual({
      enabled: true,
      requestTimeoutMs: 9876,
      servers: {
        typescript: {
          command: 'custom-ts-ls',
          args: ['--stdio'],
        },
        python: {
          args: ['--custom'],
        },
      },
    });
  });

  it('should throw an explicit error when .lore.config is malformed JSON', () => {
    writeFileSync(join(rootDir, '.lore.config'), '{ "lsp": ', 'utf8');
    expect(() => loadLspSettingsFromLoreConfig(rootDir)).toThrow(/Invalid \.lore\.config:/u);
  });

  it('should throw an explicit error when lsp settings violate the schema', () => {
    writeFileSync(
      join(rootDir, '.lore.config'),
      JSON.stringify({
        lsp: {
          timeoutMs: 'fast',
        },
      }),
      'utf8',
    );

    expect(() => loadLspSettingsFromLoreConfig(rootDir)).toThrow(/Invalid \.lore\.config lsp settings/u);
  });

  it('should throw when lsp server overrides include an unsupported language', () => {
    writeFileSync(
      join(rootDir, '.lore.config'),
      JSON.stringify({
        lsp: {
          servers: {
            unknownlang: {
              command: 'missing-ls',
            },
          },
        },
      }),
      'utf8',
    );

    expect(() => loadLspSettingsFromLoreConfig(rootDir)).toThrow(/unsupported language "unknownlang"/u);
  });
});

describe('resolveEffectiveLspSettings', () => {
  it('should use module defaults when config and explicit overrides are absent', () => {
    const effective = resolveEffectiveLspSettings();

    expect(effective.enabled).toBe(DEFAULT_LSP_ENABLED);
    expect(effective.requestTimeoutMs).toBe(DEFAULT_LSP_REQUEST_TIMEOUT_MS);
    expect(effective.servers.typescript).toEqual({
      command: 'typescript-language-server',
      args: ['--stdio'],
    });
  });

  it('should apply explicit overrides over config overrides while merging server entries', () => {
    const effective = resolveEffectiveLspSettings(
      {
        enabled: false,
        requestTimeoutMs: 500,
        servers: {
          typescript: {
            command: 'config-ts-ls',
          },
        },
      },
      {
        enabled: true,
        requestTimeoutMs: 1500,
        servers: {
          python: {
            args: ['--explicit'],
          },
        },
      },
    );

    expect(effective.enabled).toBe(true);
    expect(effective.requestTimeoutMs).toBe(1500);
    expect(effective.servers.typescript).toEqual({
      command: 'config-ts-ls',
      args: ['--stdio'],
    });
    expect(effective.servers.python).toEqual({
      command: 'pyright-langserver',
      args: ['--explicit'],
    });
  });
});
