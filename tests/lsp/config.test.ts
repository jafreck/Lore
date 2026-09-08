import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveEffectiveLspSettings,
  loadLspSettingsFromLoreConfig,
  DEFAULT_LSP_ENABLED,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  DEFAULT_LSP_SUPPLEMENTATION_FILE_CONCURRENCY,
  DEFAULT_LSP_SUPPLEMENTATION_MAX_FILES,
} from '../../src/lsp/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-lsp-config-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveEffectiveLspSettings', () => {
  it('returns defaults when no overrides provided', () => {
    const settings = resolveEffectiveLspSettings();
    expect(settings.enabled).toBe(DEFAULT_LSP_ENABLED);
    expect(settings.requestTimeoutMs).toBe(DEFAULT_LSP_REQUEST_TIMEOUT_MS);
    expect(settings.allowServerExecution).toBe(false);
    expect(typeof settings.servers).toBe('object');
    expect(settings.servers).toHaveProperty('typescript');
    expect(settings.supplementation).toEqual({
      maxFiles: DEFAULT_LSP_SUPPLEMENTATION_MAX_FILES,
      fileConcurrency: DEFAULT_LSP_SUPPLEMENTATION_FILE_CONCURRENCY,
      strict: false,
    });
  });

  it('applies config settings', () => {
    const settings = resolveEffectiveLspSettings({
      enabled: true,
      requestTimeoutMs: 10_000,
    });
    expect(settings.enabled).toBe(true);
    expect(settings.requestTimeoutMs).toBe(10_000);
  });

  it('explicit overrides take precedence over config', () => {
    const settings = resolveEffectiveLspSettings(
      { enabled: false, requestTimeoutMs: 10_000 },
      { enabled: true, requestTimeoutMs: 3_000 },
    );
    expect(settings.enabled).toBe(true);
    expect(settings.requestTimeoutMs).toBe(3_000);
  });

  it('merges server overrides from both layers', () => {
    const settings = resolveEffectiveLspSettings(
      { servers: { typescript: { command: 'my-ts-server' } } },
      { servers: { python: { command: 'my-pyright' } } },
      { allowCustomLspCommands: true },
    );
    expect(settings.servers.typescript?.command).toBe('my-ts-server');
    expect(settings.servers.python?.command).toBe('my-pyright');
  });

  it('deep-merges server overrides for same language', () => {
    const settings = resolveEffectiveLspSettings(
      { servers: { typescript: { command: 'custom-ts' } } },
      { servers: { typescript: { args: ['--extra'] } } },
      { allowCustomLspCommands: true },
    );
    expect(settings.servers.typescript?.command).toBe('custom-ts');
    expect(settings.servers.typescript?.args).toEqual(['--extra']);
  });

  it('merges supplementation overrides by field', () => {
    const settings = resolveEffectiveLspSettings(
      { supplementation: { maxFiles: 20, fileConcurrency: 2, strict: false } },
      { supplementation: { fileConcurrency: 8, strict: true } },
    );
    expect(settings.supplementation).toEqual({
      maxFiles: 20,
      fileConcurrency: 8,
      strict: true,
    });
  });

  it('ignores custom repository servers unless the host trusts them', () => {
    const settings = resolveEffectiveLspSettings({
      servers: { typescript: { command: 'malicious-lsp', args: ['--eval', 'pwn'] } },
    });
    expect(settings.servers.typescript?.command).toBe('typescript-language-server');
    expect(settings.servers.typescript?.args).toEqual(['--stdio']);
    expect(settings.allowServerExecution).toBe(false);
  });

  it('allows custom server cwd only with explicit host trust', () => {
    const settings = resolveEffectiveLspSettings(
      { servers: { typescript: { cwd: 'tools/lsp' } } },
      {},
      { allowCustomLspCommands: true },
    );
    expect(settings.servers.typescript?.cwd).toBe('tools/lsp');
    expect(settings.allowServerExecution).toBe(true);
  });
});

describe('loadLspSettingsFromLoreConfig', () => {
  it('returns empty when no .lore.config exists', () => {
    const result = loadLspSettingsFromLoreConfig(tmpDir);
    expect(result).toEqual({});
  });

  it('returns empty when .lore.config has no lsp key', () => {
    fs.writeFileSync(path.join(tmpDir, '.lore.config'), JSON.stringify({ other: true }));
    const result = loadLspSettingsFromLoreConfig(tmpDir);
    expect(result).toEqual({});
  });

  it('parses valid lsp settings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.lore.config'),
      JSON.stringify({
        lsp: {
          enabled: true,
          timeoutMs: 8000,
          supplementation: { maxFiles: 40, fileConcurrency: 6, strict: true },
        },
      }),
    );
    const result = loadLspSettingsFromLoreConfig(tmpDir);
    expect(result.enabled).toBe(true);
    expect(result.requestTimeoutMs).toBe(8000);
    expect(result.supplementation).toEqual({ maxFiles: 40, fileConcurrency: 6, strict: true });
  });

  it('throws on invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.lore.config'), 'not json');
    expect(() => loadLspSettingsFromLoreConfig(tmpDir)).toThrow('Invalid .lore.config');
  });

  it('throws on unsupported language in servers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.lore.config'),
      JSON.stringify({
        lsp: {
          servers: {
            brainfuck: { command: 'bf-lsp' },
          },
        },
      }),
    );
    expect(() => loadLspSettingsFromLoreConfig(tmpDir)).toThrow('unsupported language');
  });

  it('parses a custom server cwd as an untrusted request', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.lore.config'),
      JSON.stringify({ lsp: { servers: { typescript: { cwd: 'tools/lsp' } } } }),
    );
    const result = loadLspSettingsFromLoreConfig(tmpDir);
    expect(result.servers?.typescript?.cwd).toBe('tools/lsp');
  });

  it('throws when root is not an object', () => {
    fs.writeFileSync(path.join(tmpDir, '.lore.config'), JSON.stringify('string'));
    expect(() => loadLspSettingsFromLoreConfig(tmpDir)).toThrow('root must be a JSON object');
  });
});
