import type { EffectiveLspSettings } from '../../src/lsp/config.js';
import type { EffectiveScipSettings } from '../../src/scip/config.js';

export function effectiveScipSettings(
  overrides: Partial<EffectiveScipSettings> = {},
): EffectiveScipSettings {
  return {
    enabled: true,
    timeoutMs: 120_000,
    allowIndexerExecution: false,
    allowBuildExecution: false,
    allowAutoInstall: false,
    allowedCwdRoots: [],
    indexers: {},
    indexDir: null,
    ...overrides,
  };
}

export function effectiveLspSettings(
  overrides: Partial<EffectiveLspSettings> = {},
): EffectiveLspSettings {
  return {
    enabled: true,
    requestTimeoutMs: 1_000,
    allowServerExecution: false,
    allowedCwdRoots: [],
    servers: {},
    ...overrides,
  };
}
