/**
 * @module indexer/scip/config
 *
 * Configuration for the SCIP enrichment pipeline stage.
 *
 * Settings are loaded from `.lore.config` under the `"scip"` key, with
 * the same layering as LSP config: file settings ← explicit overrides.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ScipIndexerRegistry, ScipIndexerRegistryOverrides } from './registry.js';
import { mergeScipIndexerRegistry } from './registry.js';

// ─── Effective settings ───────────────────────────────────────────────────────

export const DEFAULT_SCIP_ENABLED = false;
export const DEFAULT_SCIP_TIMEOUT_MS = 120_000; // 2 minutes per indexer run

export interface EffectiveScipSettings {
  enabled: boolean;
  /** Per-indexer execution timeout in milliseconds. */
  timeoutMs: number;
  /** Merged indexer registry (defaults + overrides). */
  indexers: ScipIndexerRegistry;
  /**
   * Optional path to a directory containing pre-computed SCIP index files.
   * If set, Lore reads `<dir>/<language>.scip` instead of running indexers.
   */
  indexDir: string | null;
}

export interface ScipSettingsOverrides {
  enabled?: boolean;
  timeoutMs?: number;
  indexers?: ScipIndexerRegistryOverrides;
  indexDir?: string;
}

// ─── Zod schema for .lore.config → scip section ──────────────────────────────

const IndexerOverrideSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()
  .refine((v) => v.command !== undefined || v.args !== undefined, {
    message: 'must provide at least one of "command" or "args"',
  });

const ScipSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    indexDir: z.string().optional(),
    indexers: z.record(z.string(), IndexerOverrideSchema).optional(),
  })
  .strict();

// ─── Config loaders ───────────────────────────────────────────────────────────

export function loadScipSettingsFromLoreConfig(rootDir: string): ScipSettingsOverrides {
  const configPath = join(rootDir, '.lore.config');
  if (!existsSync(configPath)) return {};

  let parsedConfig: unknown;
  try {
    const raw = readFileSync(configPath, 'utf8');
    parsedConfig = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .lore.config: ${message}`);
  }

  if (!isRecord(parsedConfig)) {
    throw new Error('Invalid .lore.config: root must be a JSON object');
  }
  if (!Object.prototype.hasOwnProperty.call(parsedConfig, 'scip')) {
    return {};
  }

  const parse = ScipSchema.safeParse(parsedConfig.scip);
  if (!parse.success) {
    const issue = parse.error.issues[0];
    throw new Error(
      `Invalid .lore.config scip settings: ${issue?.path.join('.') ?? 'scip'} ${issue?.message ?? 'invalid value'}`,
    );
  }

  const scip = parse.data;
  return {
    ...(scip.enabled !== undefined && { enabled: scip.enabled }),
    ...(scip.timeoutMs !== undefined && { timeoutMs: scip.timeoutMs }),
    ...(scip.indexDir !== undefined && { indexDir: scip.indexDir }),
    ...(scip.indexers && { indexers: scip.indexers as ScipIndexerRegistryOverrides }),
  };
}

export function resolveEffectiveScipSettings(
  configSettings: ScipSettingsOverrides = {},
  explicitOverrides: ScipSettingsOverrides = {},
): EffectiveScipSettings {
  // Merge per-language indexer overrides.
  const configIndexers = configSettings.indexers ?? {};
  const overrideIndexers = explicitOverrides.indexers ?? {};
  const mergedOverrides: ScipIndexerRegistryOverrides = { ...configIndexers };
  for (const [lang, override] of Object.entries(overrideIndexers)) {
    const existing = mergedOverrides[lang];
    if (existing && override) {
      mergedOverrides[lang] = {
        command: override.command ?? existing.command,
        args: override.args ?? existing.args,
        ...(override.cwd !== undefined ? { cwd: override.cwd } : existing.cwd ? { cwd: existing.cwd } : {}),
      };
    } else {
      mergedOverrides[lang] = override;
    }
  }

  return {
    enabled: explicitOverrides.enabled ?? configSettings.enabled ?? DEFAULT_SCIP_ENABLED,
    timeoutMs: explicitOverrides.timeoutMs ?? configSettings.timeoutMs ?? DEFAULT_SCIP_TIMEOUT_MS,
    indexers: mergeScipIndexerRegistry(mergedOverrides),
    indexDir: explicitOverrides.indexDir ?? configSettings.indexDir ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
