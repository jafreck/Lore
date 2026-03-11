import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type LspServerRegistry,
  type LspServerRegistryOverrides,
  mergeLspServerRegistry,
} from './registry.js';
import { SUPPORTED_PARSER_LANGUAGES } from '../parsing/parser.js';

export const DEFAULT_LSP_ENABLED = false;
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 5000;

export interface EffectiveLspSettings {
  enabled: boolean;
  requestTimeoutMs: number;
  servers: LspServerRegistry;
}

export interface LspSettingsOverrides {
  enabled?: boolean;
  requestTimeoutMs?: number;
  servers?: LspServerRegistryOverrides;
}

const ServerOverrideSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
  })
  .strict()
  .refine((value) => value.command !== undefined || value.args !== undefined, {
    message: 'must provide at least one of "command" or "args"',
  });

const LspSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
    servers: z.record(z.string(), ServerOverrideSchema).optional(),
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
      if (!SUPPORTED_PARSER_LANGUAGES.includes(language)) {
        throw new Error(`Invalid .lore.config lsp settings: unsupported language "${language}"`);
      }
    }
  }

  return {
    ...(lsp.enabled !== undefined && { enabled: lsp.enabled }),
    ...(lsp.timeoutMs !== undefined && { requestTimeoutMs: lsp.timeoutMs }),
    ...(lsp.servers && { servers: lsp.servers }),
  };
}

export function resolveEffectiveLspSettings(
  configSettings: LspSettingsOverrides = {},
  explicitOverrides: LspSettingsOverrides = {},
): EffectiveLspSettings {
  // Deep-merge per-language server overrides so that e.g. overriding only
  // `args` doesn't discard the config file's `command`.
  const configServers = configSettings.servers ?? {};
  const overrideServers = explicitOverrides.servers ?? {};
  const mergedServerOverrides: LspServerRegistryOverrides = { ...configServers };
  for (const [lang, override] of Object.entries(overrideServers)) {
    const existing = mergedServerOverrides[lang];
    if (existing && override) {
      mergedServerOverrides[lang] = {
        command: override.command ?? existing.command,
        args: override.args ?? existing.args,
      };
    } else {
      mergedServerOverrides[lang] = override;
    }
  }
  const mergedServers = mergeLspServerRegistry(mergedServerOverrides);

  return {
    enabled: explicitOverrides.enabled ?? configSettings.enabled ?? DEFAULT_LSP_ENABLED,
    requestTimeoutMs:
      explicitOverrides.requestTimeoutMs
      ?? configSettings.requestTimeoutMs
      ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    servers: mergedServers,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
