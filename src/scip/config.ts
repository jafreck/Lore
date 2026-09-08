/**
 * @module indexer/scip/config
 *
 * Configuration for the SCIP enrichment pipeline stage.
 *
 * Settings are loaded from `.lore.config` under the `"scip"` key, with
 * the same layering as LSP config: file settings ← explicit overrides.
 * Execution capabilities are resolved exclusively from the separate,
 * host-supplied `IndexExecutionOptions` argument.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  resolveIndexExecutionPolicy,
  type IndexExecutionOptions,
} from '../execution-policy.js';
import type { ScipIndexerRegistry, ScipIndexerRegistryOverrides } from './registry.js';
import { mergeScipIndexerRegistry } from './registry.js';

// ─── Effective settings ───────────────────────────────────────────────────────

export const DEFAULT_SCIP_ENABLED = true;
export const DEFAULT_SCIP_TIMEOUT_MS = 120_000; // 2 minutes per indexer run
export const DEFAULT_SCIP_C_FAMILY_TIMEOUT_MS = 600_000; // 10 minutes

export interface EffectiveScipSettings {
  enabled: boolean;
  /** Per-indexer execution timeout in milliseconds. */
  timeoutMs: number;
  /** False only when timeoutMs came from Lore's default rather than configuration. */
  timeoutMsExplicit?: boolean;
  /** Host-authorized permission to start configured SCIP indexers. */
  allowIndexerExecution: boolean;
  /** Host-authorized permission to run configure/build tools. */
  allowBuildExecution: boolean;
  /** Host-authorized permission to download or install missing indexers. */
  allowAutoInstall: boolean;
  /** Additional host-approved roots for custom command working directories. */
  allowedCwdRoots: readonly string[];
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
  /** Internal provenance retained when adapting EffectiveScipSettings. */
  timeoutMsExplicit?: boolean;
  /** Repository request only; cannot grant build execution without host permission. */
  allowBuildExecution?: boolean;
  /** Repository request only; cannot grant installation without host permission. */
  autoInstall?: boolean;
  indexers?: ScipIndexerRegistryOverrides;
  indexDir?: string | null;
}

// ─── Zod schema for .lore.config → scip section ──────────────────────────────

const IndexerOverrideSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()
  .refine((v) => v.command !== undefined || v.args !== undefined || v.cwd !== undefined, {
    message: 'must provide at least one of "command", "args", or "cwd"',
  });

const ScipSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    allowBuildExecution: z.boolean().optional(),
    autoInstall: z.boolean().optional(),
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
    ...(scip.allowBuildExecution !== undefined && { allowBuildExecution: scip.allowBuildExecution }),
    ...(scip.autoInstall !== undefined && { autoInstall: scip.autoInstall }),
    ...(scip.indexDir !== undefined && { indexDir: scip.indexDir }),
    ...(scip.indexers && { indexers: scip.indexers as ScipIndexerRegistryOverrides }),
  };
}

export function resolveEffectiveScipSettings(
  configSettings: ScipSettingsOverrides = {},
  explicitOverrides: ScipSettingsOverrides = {},
  trustedExecution: IndexExecutionOptions = {},
): EffectiveScipSettings {
  const execution = resolveIndexExecutionPolicy(trustedExecution);
  // Merge per-language indexer overrides.
  // Command/argument/cwd changes are inert unless the host explicitly trusts
  // custom SCIP commands. This applies equally to repository requests and to
  // partial settings objects passed through an untrusted adapter.
  const configIndexers = execution.allowCustomIndexerCommands
    ? (configSettings.indexers ?? {})
    : {};
  const overrideIndexers = execution.allowCustomIndexerCommands
    ? (explicitOverrides.indexers ?? {})
    : {};
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
    timeoutMsExplicit: explicitOverrides.timeoutMsExplicit
      ?? (explicitOverrides.timeoutMs !== undefined || configSettings.timeoutMs !== undefined),
    allowIndexerExecution: execution.allowIndexerExecution,
    allowBuildExecution:
      execution.allowBuildExecution
      && (explicitOverrides.allowBuildExecution ?? configSettings.allowBuildExecution ?? true),
    allowAutoInstall:
      execution.allowAutoInstall
      && (explicitOverrides.autoInstall ?? configSettings.autoInstall ?? true),
    allowedCwdRoots: execution.allowedCwdRoots,
    indexers: mergeScipIndexerRegistry(mergedOverrides),
    indexDir: explicitOverrides.indexDir ?? configSettings.indexDir ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
