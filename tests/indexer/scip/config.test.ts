/**
 * Tests for SCIP configuration parsing and resolution.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  loadScipSettingsFromLoreConfig,
  resolveEffectiveScipSettings,
  DEFAULT_SCIP_ENABLED,
  DEFAULT_SCIP_TIMEOUT_MS,
} from '../../../src/indexer/scip/config.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lore-scip-config-'));
}

describe('loadScipSettingsFromLoreConfig', () => {
  it('returns empty overrides when no .lore.config exists', () => {
    const dir = tmpDir();
    try {
      expect(loadScipSettingsFromLoreConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty overrides when .lore.config has no scip key', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.lore.config'), '{"lsp": {"enabled": true}}');
    try {
      expect(loadScipSettingsFromLoreConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads enabled and timeoutMs from config', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.lore.config'), JSON.stringify({
      scip: { enabled: true, timeoutMs: 60000 },
    }));
    try {
      const settings = loadScipSettingsFromLoreConfig(dir);
      expect(settings.enabled).toBe(true);
      expect(settings.timeoutMs).toBe(60000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads indexDir from config', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.lore.config'), JSON.stringify({
      scip: { indexDir: '.scip-indexes' },
    }));
    try {
      const settings = loadScipSettingsFromLoreConfig(dir);
      expect(settings.indexDir).toBe('.scip-indexes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on invalid scip config', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.lore.config'), JSON.stringify({
      scip: { enabled: 'yes' },
    }));
    try {
      expect(() => loadScipSettingsFromLoreConfig(dir)).toThrow('Invalid .lore.config scip settings');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads indexer overrides', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '.lore.config'), JSON.stringify({
      scip: {
        indexers: {
          typescript: { command: 'my-ts-indexer', args: ['index'] },
        },
      },
    }));
    try {
      const settings = loadScipSettingsFromLoreConfig(dir);
      expect(settings.indexers).toEqual({
        typescript: { command: 'my-ts-indexer', args: ['index'] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveEffectiveScipSettings', () => {
  it('uses defaults when no overrides are provided', () => {
    const effective = resolveEffectiveScipSettings();
    expect(effective.enabled).toBe(DEFAULT_SCIP_ENABLED);
    expect(effective.timeoutMs).toBe(DEFAULT_SCIP_TIMEOUT_MS);
    expect(effective.indexDir).toBeNull();
    expect(Object.keys(effective.indexers).length).toBeGreaterThan(0);
  });

  it('explicit overrides take priority over config settings', () => {
    const effective = resolveEffectiveScipSettings(
      { enabled: false, timeoutMs: 30000 },
      { enabled: true },
    );
    expect(effective.enabled).toBe(true);
    expect(effective.timeoutMs).toBe(30000);
  });

  it('merges indexer overrides with defaults', () => {
    const effective = resolveEffectiveScipSettings({
      indexers: {
        typescript: { command: 'custom-ts' },
      },
    });
    expect(effective.indexers.typescript!.command).toBe('custom-ts');
    // Python should still have the default.
    expect(effective.indexers.python).toBeDefined();
  });
});
