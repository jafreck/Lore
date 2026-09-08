/** LSP settings resolution with host-only execution capability gates. */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  resolveIndexExecutionPolicy,
  type IndexExecutionOptions,
} from '../execution-policy.js';
import {
  type LspServerRegistry,
  type LspServerRegistryOverrides,
  mergeLspServerRegistry,
  SUPPORTED_LANGUAGES,
} from './registry.js';

export const DEFAULT_LSP_ENABLED = true;
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_LSP_SUPPLEMENTATION_MAX_FILES = 500;
export const DEFAULT_LSP_SUPPLEMENTATION_FILE_CONCURRENCY = 4;

export interface LspSupplementationSettings {
  maxFiles: number;
  fileConcurrency: number;
  /** Require a complete plan; in particular, fail instead of truncating at maxFiles. */
  strict: boolean;
}

export interface EffectiveLspSettings {
  enabled: boolean;
  requestTimeoutMs: number;
  /** Host-authorized permission to start configured language servers. */
  allowServerExecution: boolean;
  /** Additional host-approved roots for custom command working directories. */
  allowedCwdRoots: readonly string[];
  servers: LspServerRegistry;
  /** Optional for compatibility with programmatic callers that construct settings directly. */
  supplementation?: LspSupplementationSettings;
}

export interface LspSettingsOverrides {
  enabled?: boolean;
  requestTimeoutMs?: number;
  servers?: LspServerRegistryOverrides;
  supplementation?: Partial<LspSupplementationSettings>;
}

const ServerOverrideSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()
  .refine((value) =>
    value.command !== undefined || value.args !== undefined || value.cwd !== undefined, {
    message: 'must provide at least one of "command", "args", or "cwd"',
  });

const LspSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    servers: z.record(z.string(), ServerOverrideSchema).optional(),
    supplementation: z.object({
      maxFiles: z.number().int().positive().optional(),
      fileConcurrency: z.number().int().min(1).max(64).optional(),
      strict: z.boolean().optional(),
    }).strict().optional(),
  })
  .strict();

export function loadLspSettingsFromLoreConfig(rootDir: string): LspSettingsOverrides {
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
  if (!Object.prototype.hasOwnProperty.call(parsedConfig, 'lsp')) {
    return {};
  }

  const lspParse = LspSchema.safeParse(parsedConfig.lsp);
  if (!lspParse.success) {
    const issue = lspParse.error.issues[0];
    throw new Error(`Invalid .lore.config lsp settings: ${issue?.path.join('.') ?? 'lsp'} ${issue?.message ?? 'invalid value'}`);
  }

  const lsp = lspParse.data;
  if (lsp.servers) {
    for (const language of Object.keys(lsp.servers)) {
      if (!SUPPORTED_LANGUAGES.includes(language)) {
        throw new Error(`Invalid .lore.config lsp settings: unsupported language "${language}"`);
      }
    }
  }

  return {
    ...(lsp.enabled !== undefined && { enabled: lsp.enabled }),
    ...(lsp.timeoutMs !== undefined && { requestTimeoutMs: lsp.timeoutMs }),
    ...(lsp.servers && { servers: lsp.servers }),
    ...(lsp.supplementation && { supplementation: lsp.supplementation }),
  };
}

export function resolveEffectiveLspSettings(
  configSettings: LspSettingsOverrides = {},
  explicitOverrides: LspSettingsOverrides = {},
  trustedExecution: IndexExecutionOptions = {},
): EffectiveLspSettings {
  const execution = resolveIndexExecutionPolicy(trustedExecution);
  // Deep-merge per-language server overrides so that e.g. overriding only
  // `args` doesn't discard the config file's `command`.
  // Repository command/argument/cwd requests cannot become executable unless
  // the host explicitly authorizes custom LSP commands.
  const configServers = execution.allowCustomLspCommands
    ? (configSettings.servers ?? {})
    : {};
  const overrideServers = execution.allowCustomLspCommands
    ? (explicitOverrides.servers ?? {})
    : {};
  const mergedServerOverrides: LspServerRegistryOverrides = { ...configServers };
  for (const [lang, override] of Object.entries(overrideServers)) {
    const existing = mergedServerOverrides[lang];
    if (existing && override) {
      mergedServerOverrides[lang] = {
        command: override.command ?? existing.command,
        args: override.args ?? existing.args,
        ...(override.cwd !== undefined
          ? { cwd: override.cwd }
          : existing.cwd !== undefined
            ? { cwd: existing.cwd }
            : {}),
      };
    } else {
      mergedServerOverrides[lang] = override;
    }
  }
  const mergedServers = mergeLspServerRegistry(mergedServerOverrides);
  const supplementation: LspSupplementationSettings = {
    maxFiles:
      explicitOverrides.supplementation?.maxFiles
      ?? configSettings.supplementation?.maxFiles
      ?? DEFAULT_LSP_SUPPLEMENTATION_MAX_FILES,
    fileConcurrency:
      explicitOverrides.supplementation?.fileConcurrency
      ?? configSettings.supplementation?.fileConcurrency
      ?? DEFAULT_LSP_SUPPLEMENTATION_FILE_CONCURRENCY,
    strict:
      explicitOverrides.supplementation?.strict
      ?? configSettings.supplementation?.strict
      ?? false,
  };

  return {
    enabled: explicitOverrides.enabled ?? configSettings.enabled ?? DEFAULT_LSP_ENABLED,
    requestTimeoutMs:
      explicitOverrides.requestTimeoutMs
      ?? configSettings.requestTimeoutMs
      ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    allowServerExecution: execution.allowLspExecution,
    allowedCwdRoots: execution.allowedCwdRoots,
    servers: mergedServers,
    supplementation,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
