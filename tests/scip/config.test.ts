import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  resolveEffectiveScipSettings,
  loadScipSettingsFromLoreConfig,
  DEFAULT_SCIP_ENABLED,
  DEFAULT_SCIP_TIMEOUT_MS,
  type ScipSettingsOverrides,
} from '../../src/scip/config.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-scip-config-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveEffectiveScipSettings', () => {
  it('returns defaults when no overrides provided', () => {
    const settings = resolveEffectiveScipSettings();
    expect(settings.enabled).toBe(DEFAULT_SCIP_ENABLED);
    expect(settings.timeoutMs).toBe(DEFAULT_SCIP_TIMEOUT_MS);
    expect(settings.indexDir).toBeNull();
    expect(typeof settings.indexers).toBe('object');
  });

  it('applies config settings', () => {
    const settings = resolveEffectiveScipSettings({ enabled: false, timeoutMs: 60_000 });
    expect(settings.enabled).toBe(false);
    expect(settings.timeoutMs).toBe(60_000);
  });

  it('explicit overrides take precedence over config', () => {
    const settings = resolveEffectiveScipSettings(
      { enabled: false, timeoutMs: 60_000 },
      { enabled: true, timeoutMs: 30_000 },
    );
    expect(settings.enabled).toBe(true);
    expect(settings.timeoutMs).toBe(30_000);
  });

  it('merges indexer overrides from both layers', () => {
    const config: ScipSettingsOverrides = {
      indexers: { typescript: { command: 'custom-ts' } },
    };
    const explicit: ScipSettingsOverrides = {
      indexers: { python: { command: 'custom-py', args: ['index'] } },
    };

    const settings = resolveEffectiveScipSettings(config, explicit);
    expect(settings.indexers.typescript?.command).toBe('custom-ts');
    expect(settings.indexers.python?.command).toBe('custom-py');
  });

  it('explicit indexer override wins over config for same language', () => {
    const config: ScipSettingsOverrides = {
      indexers: { typescript: { command: 'from-config' } },
    };
    const explicit: ScipSettingsOverrides = {
      indexers: { typescript: { command: 'from-explicit' } },
    };

    const settings = resolveEffectiveScipSettings(config, explicit);
    expect(settings.indexers.typescript?.command).toBe('from-explicit');
  });

  it('sets indexDir from explicit overrides', () => {
    const settings = resolveEffectiveScipSettings({}, { indexDir: '/custom/dir' });
    expect(settings.indexDir).toBe('/custom/dir');
  });
});

describe('loadScipSettingsFromLoreConfig', () => {
  it('returns empty object when no .lore.config exists', () => {
    const result = loadScipSettingsFromLoreConfig(tmpDir);
    expect(result).toEqual({});
  });

  it('returns empty object when .lore.config has no scip key', () => {
    fs.writeFileSync(path.join(tmpDir, '.lore.config'), JSON.stringify({ lsp: {} }));
    const result = loadScipSettingsFromLoreConfig(tmpDir);
    expect(result).toEqual({});
  });

  it('parses valid scip settings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.lore.config'),
      JSON.stringify({
        scip: {
          enabled: false,
          timeoutMs: 30000,
        },
      }),
    );

    const result = loadScipSettingsFromLoreConfig(tmpDir);
    expect(result.enabled).toBe(false);
    expect(result.timeoutMs).toBe(30000);
  });

  it('throws on invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.lore.config'), 'not json');
    expect(() => loadScipSettingsFromLoreConfig(tmpDir)).toThrow('Invalid .lore.config');
  });

  it('throws on invalid scip settings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.lore.config'),
      JSON.stringify({ scip: { enabled: 'not-a-boolean' } }),
    );
    expect(() => loadScipSettingsFromLoreConfig(tmpDir)).toThrow('Invalid .lore.config scip settings');
  });

  it('throws when root is not an object', () => {
    fs.writeFileSync(path.join(tmpDir, '.lore.config'), JSON.stringify('string'));
    expect(() => loadScipSettingsFromLoreConfig(tmpDir)).toThrow('root must be a JSON object');
  });

  it('parses indexer overrides', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.lore.config'),
      JSON.stringify({
        scip: {
          indexers: {
            typescript: { command: 'my-ts-indexer' },
          },
        },
      }),
    );

    const result = loadScipSettingsFromLoreConfig(tmpDir);
    expect(result.indexers).toBeDefined();
    expect(result.indexers!['typescript']?.command).toBe('my-ts-indexer');
  });

  it('parses indexDir setting', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.lore.config'),
      JSON.stringify({
        scip: {
          indexDir: '/precomputed/scip',
        },
      }),
    );

    const result = loadScipSettingsFromLoreConfig(tmpDir);
    expect(result.indexDir).toBe('/precomputed/scip');
  });
});

describe('default constants', () => {
  it('DEFAULT_SCIP_ENABLED is true', () => {
    expect(DEFAULT_SCIP_ENABLED).toBe(true);
  });

  it('DEFAULT_SCIP_TIMEOUT_MS is 120000', () => {
    expect(DEFAULT_SCIP_TIMEOUT_MS).toBe(120_000);
  });
});
