/**
 * @module cli/args
 *
 * Shared argument parsing utilities and usage text for the Lore CLI.
 */

import {
  parseValidationProfile,
  type IndexCoverageThresholds,
  type IndexValidationPolicy,
} from '../validation/config.js';
import type { IndexExecutionOptions } from '../execution-policy.js';
import { EXT_TO_LANG, type WalkerConfig } from '../discovery/walker.js';
import { canonicalScopeRequest, type ScipScope } from '../scip/scope.js';

// ─── Usage ────────────────────────────────────────────────────────────────────

export function usage(): never {
  console.error(
    `Usage:
  lore index --root <dir> --db <path> [--include <glob>] [--exclude <glob>] [--language <lang>] [--embeddings|--no-embeddings] [--embedding-model <id>] [--index-deps] [--history] [provider flags] [execution flags]
                         Index a codebase into a knowledge-base SQLite file
  lore doctor --db <path> [--root <dir>] [--validation-profile <profile>] [--json]
                         Validate index completeness, integrity, provenance, and freshness
  lore migrate --db <path> [--json]
                         Explicitly upgrade an existing Lore database schema in place
  lore mcp --root <dir> [--watch|--poll] [walker flags] [execution flags]  Start the Lore MCP server, auto-indexing if no DB exists yet
  lore mcp --db <path> [--root <dir> --watch|--poll] [execution flags]  Start the Lore MCP server with a pre-indexed DB
  lore refresh --db <path> --root <dir> [walker flags] [--embeddings|--no-embeddings] [--embedding-model <id>] [--index-deps] [--history] [provider flags] [execution flags]  Run an incremental index update and exit
  lore refresh --db <path> --root <dir> --watch [--embeddings|--no-embeddings] [--embedding-model <id>] Watch for file changes and refresh automatically
  lore refresh --db <path> --root <dir> --poll [--embeddings|--no-embeddings] [--embedding-model <id>]  Poll for file changes and refresh automatically
  lore hooks --db <path> --root <dir> [--history] [--history-depth <n>] [--history-all] [--lsp|--no-lsp] [--scip|--no-scip] [execution flags]
                         Install git hooks for automatic refresh on commit/merge/checkout/rewrite
  lore analyze --db <path> [--mode <mode>] [--edge-kinds <kind>] [--branch <name>] [--max-lines <n>]
                         Run graph analysis on the knowledge-base (cycles, components, clusters, summary)
  lore install-scip [--language <lang>] [--list]
                         Install SCIP indexers for richer code intelligence (auto-downloads missing indexers)

Options:
  --root <dir>             Root directory to index (required for index, refresh)
  --db <path>              Path to a Lore knowledge-base SQLite file (required for index, refresh; optional for mcp)
  --embedding-model <id>   Embedding model identifier (default: onnx-community/Qwen3-Embedding-0.6B-ONNX)
  --embeddings             Enable embedding generation for index/refresh work
  --no-embeddings          Disable embedding generation, including persisted model reuse
  --index-deps             Legacy TypeScript LSP-startup hint; no dependency crawler is active
  --max-workers <n>        Accepted legacy parse-worker limit; currently unused
  --history                Enable git history ingestion
  --history-depth <n>      Limit commit ingestion to the most recent N commits
  --history-all            Explicitly traverse all refs (already the history default)
  --include <glob>         Glob pattern for files to include (repeatable)
  --exclude <glob>         Glob pattern for paths to exclude (repeatable)
  --language <lang>        Language name to filter by, e.g. typescript (repeatable)
  --watch                  Enable fs-event watch mode (low-latency, may miss events on some platforms)
  --poll                   Enable polling mode (reliable but higher CPU/IO cost)
  --lsp / --no-lsp         Force-enable/disable index-time LSP support (enabled by default)
  --scip / --no-scip       Force-enable/disable index-time SCIP indexing (enabled by default)
  --scip-scope-language <lang>  Host SCIP scope language (repeatable; index/doctor/validate)
  --scip-scope-include <glob>  Host SCIP scope include (repeatable; intersects walker selection)
  --scip-scope-exclude <glob>  Host SCIP scope exclusion (repeatable; no execution grant)
  --allow-subprocess-execution  Allow built-in SCIP indexers and LSP servers (default: off)
  --allow-build-execution  Allow SCIP to run configure/build tools; also permits SCIP indexer execution
  --allow-custom-indexer-commands  Honor custom SCIP command/args/cwd from .lore.config
  --allow-custom-lsp-commands  Honor custom LSP command/args/cwd from .lore.config
  --allow-auto-install     Allow automatic SCIP indexer download/install (default: off)
  --allow-command-cwd <dir>  Add a host-approved custom command cwd root (repeatable)
  --allow-external-build-root <dir>  Approve an out-of-tree compilation/build root (repeatable)
  --validation-profile <profile>  Validation profile: standard, strict, migration-grade
  --required <glob>        Require matching indexed files to contain symbols (repeatable)
  --min-symbol-coverage <rate>  Minimum selected-file symbol coverage from 0 to 1
  --min-call-resolution-rate <rate>  Minimum call resolution rate from 0 to 1
  --min-type-resolution-rate <rate>  Minimum type resolution rate from 0 to 1
  --min-import-resolution-rate <rate>  Minimum import resolution rate from 0 to 1
  --json                   Emit machine-readable JSON (doctor/validate)
  --log-level <level>      Log level: debug, info, warn, error, silent (default: info)
  --log-file <path>        Path to the structured log file (default: lore.log next to the DB)
  --help, -h               Show this help message`,
  );
  process.exit(1);
}

// ─── Strict, schema-driven argument parsing ───────────────────────────────────

export type CliSubcommand =
  | 'index'
  | 'mcp'
  | 'refresh'
  | 'hooks'
  | 'analyze'
  | 'install-scip'
  | 'doctor'
  | 'validate'
  | 'migrate';

interface CliOptionSchema {
  kind: 'boolean' | 'value';
  repeatable?: boolean;
  validate?: (value: string) => string | undefined;
}

interface CliCommandSchema {
  options: Readonly<Record<string, CliOptionSchema>>;
  conflicts?: readonly (readonly string[])[];
}

export interface ParsedCliArgs {
  readonly command: CliSubcommand;
  readonly raw: readonly string[];
  has(name: string): boolean;
  value(name: string): string | undefined;
  values(name: string): readonly string[];
}

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

const booleanOption = Object.freeze({ kind: 'boolean' as const });
const valueOption = Object.freeze({ kind: 'value' as const });
const repeatableValueOption = Object.freeze({ kind: 'value' as const, repeatable: true });

const choices = (...allowed: string[]) => (value: string): string | undefined =>
  allowed.includes(value) ? undefined : `must be one of: ${allowed.join(', ')}`;
const positiveInteger = (value: string): string | undefined =>
  Number.isInteger(Number(value)) && Number(value) > 0 ? undefined : 'must be a positive integer';
const nonNegativeInteger = (value: string): string | undefined =>
  Number.isInteger(Number(value)) && Number(value) >= 0 ? undefined : 'must be a non-negative integer';
const rate = (value: string): string | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? undefined
    : 'must be a number from 0 to 1';
};

const COMMON_OPTIONS = {
  '--help': booleanOption,
  '-h': booleanOption,
  '--log-level': { kind: 'value', validate: choices('debug', 'info', 'warn', 'error', 'silent') },
  '--log-file': valueOption,
} satisfies Record<string, CliOptionSchema>;

const EXECUTION_OPTIONS = {
  '--allow-subprocess-execution': booleanOption,
  '--allow-build-execution': booleanOption,
  '--allow-custom-indexer-commands': booleanOption,
  '--allow-custom-lsp-commands': booleanOption,
  '--allow-auto-install': booleanOption,
  '--allow-command-cwd': repeatableValueOption,
  '--allow-external-build-root': repeatableValueOption,
} satisfies Record<string, CliOptionSchema>;

const WALKER_OPTIONS = {
  '--include': repeatableValueOption,
  '--exclude': repeatableValueOption,
  '--language': repeatableValueOption,
} satisfies Record<string, CliOptionSchema>;

const PROVIDER_OPTIONS = {
  '--lsp': booleanOption,
  '--no-lsp': booleanOption,
  '--scip': booleanOption,
  '--no-scip': booleanOption,
} satisfies Record<string, CliOptionSchema>;

const SCIP_SCOPE_OPTIONS = {
  '--scip-scope-language': repeatableValueOption,
  '--scip-scope-include': repeatableValueOption,
  '--scip-scope-exclude': repeatableValueOption,
} satisfies Record<string, CliOptionSchema>;

const HISTORY_OPTIONS = {
  '--history': booleanOption,
  '--history-depth': { kind: 'value', validate: positiveInteger },
  '--history-all': booleanOption,
} satisfies Record<string, CliOptionSchema>;

const VALIDATION_OPTIONS = {
  '--validation-profile': {
    kind: 'value',
    validate: choices('standard', 'strict', 'migration-grade'),
  },
  '--profile': {
    kind: 'value',
    validate: choices('standard', 'strict', 'migration-grade'),
  },
  '--required': repeatableValueOption,
  '--min-files': { kind: 'value', validate: nonNegativeInteger },
  '--min-symbols': { kind: 'value', validate: nonNegativeInteger },
  '--min-call-refs': { kind: 'value', validate: nonNegativeInteger },
  '--min-type-refs': { kind: 'value', validate: nonNegativeInteger },
  '--min-imports': { kind: 'value', validate: nonNegativeInteger },
  '--min-symbol-coverage': { kind: 'value', validate: rate },
  '--min-call-resolution-rate': { kind: 'value', validate: rate },
  '--min-type-resolution-rate': { kind: 'value', validate: rate },
  '--min-import-resolution-rate': { kind: 'value', validate: rate },
  '--max-symbol-less-files': { kind: 'value', validate: nonNegativeInteger },
  '--max-invalid-spans': { kind: 'value', validate: nonNegativeInteger },
  '--max-duplicate-symbols': { kind: 'value', validate: nonNegativeInteger },
  '--max-unresolved-internal-refs': { kind: 'value', validate: nonNegativeInteger },
  '--max-baseline-age-seconds': { kind: 'value', validate: nonNegativeInteger },
  '--max-dirty-files': { kind: 'value', validate: nonNegativeInteger },
} satisfies Record<string, CliOptionSchema>;

const PROVIDER_CONFLICTS = [
  ['--lsp', '--no-lsp'],
  ['--scip', '--no-scip'],
] as const;

const COMMAND_SCHEMAS: Readonly<Record<CliSubcommand, CliCommandSchema>> = {
  index: {
    options: {
      ...COMMON_OPTIONS,
      ...EXECUTION_OPTIONS,
      ...WALKER_OPTIONS,
      ...SCIP_SCOPE_OPTIONS,
      ...PROVIDER_OPTIONS,
      ...HISTORY_OPTIONS,
      ...VALIDATION_OPTIONS,
      '--root': valueOption,
      '--db': valueOption,
      '--embeddings': booleanOption,
      '--no-embeddings': booleanOption,
      '--embedding-model': valueOption,
      '--index-deps': booleanOption,
      '--max-workers': { kind: 'value', validate: positiveInteger },
    },
    conflicts: [
      ...PROVIDER_CONFLICTS,
      ['--embeddings', '--no-embeddings'],
      ['--embedding-model', '--no-embeddings'],
    ],
  },
  refresh: {
    options: {
      ...COMMON_OPTIONS,
      ...EXECUTION_OPTIONS,
      ...WALKER_OPTIONS,
      ...PROVIDER_OPTIONS,
      ...HISTORY_OPTIONS,
      '--root': valueOption,
      '--db': valueOption,
      '--watch': booleanOption,
      '--poll': booleanOption,
      '--embeddings': booleanOption,
      '--no-embeddings': booleanOption,
      '--embedding-model': valueOption,
      '--index-deps': booleanOption,
    },
    conflicts: [
      ...PROVIDER_CONFLICTS,
      ['--watch', '--poll'],
      ['--embeddings', '--no-embeddings'],
      ['--embedding-model', '--no-embeddings'],
    ],
  },
  mcp: {
    options: {
      ...COMMON_OPTIONS,
      ...EXECUTION_OPTIONS,
      ...WALKER_OPTIONS,
      '--root': valueOption,
      '--db': valueOption,
      '--watch': booleanOption,
      '--poll': booleanOption,
    },
    conflicts: [['--watch', '--poll']],
  },
  hooks: {
    options: {
      ...COMMON_OPTIONS,
      ...EXECUTION_OPTIONS,
      ...PROVIDER_OPTIONS,
      ...HISTORY_OPTIONS,
      '--root': valueOption,
      '--db': valueOption,
    },
    conflicts: PROVIDER_CONFLICTS,
  },
  analyze: {
    options: {
      ...COMMON_OPTIONS,
      '--db': valueOption,
      '--mode': { kind: 'value', validate: choices('cycles', 'components', 'clusters', 'summary') },
      '--edge-kinds': { kind: 'value', validate: choices('call', 'type', 'both') },
      '--branch': valueOption,
      '--max-lines': { kind: 'value', validate: positiveInteger },
    },
  },
  'install-scip': {
    options: {
      ...COMMON_OPTIONS,
      '--language': repeatableValueOption,
      '--list': booleanOption,
    },
  },
  doctor: {
    options: {
      ...COMMON_OPTIONS,
      ...WALKER_OPTIONS,
      ...SCIP_SCOPE_OPTIONS,
      ...VALIDATION_OPTIONS,
      '--db': valueOption,
      '--root': valueOption,
      '--branch': valueOption,
      '--max-samples': { kind: 'value', validate: nonNegativeInteger },
      '--json': booleanOption,
    },
  },
  validate: {
    options: {
      ...COMMON_OPTIONS,
      ...WALKER_OPTIONS,
      ...SCIP_SCOPE_OPTIONS,
      ...VALIDATION_OPTIONS,
      '--db': valueOption,
      '--root': valueOption,
      '--branch': valueOption,
      '--max-samples': { kind: 'value', validate: nonNegativeInteger },
      '--json': booleanOption,
    },
  },
  migrate: {
    options: {
      ...COMMON_OPTIONS,
      '--db': valueOption,
      '--json': booleanOption,
    },
  },
};

/** Parse and validate a complete CLI argv vector, including its subcommand. */
export function parseCliArgs(
  args: readonly string[],
  expectedCommand?: CliSubcommand | readonly CliSubcommand[],
): ParsedCliArgs {
  const command = args[0];
  if (!command || !Object.prototype.hasOwnProperty.call(COMMAND_SCHEMAS, command)) {
    throw new CliArgumentError(command ? `unknown subcommand: ${command}` : 'a subcommand is required');
  }
  const typedCommand = command as CliSubcommand;
  const expected = expectedCommand === undefined
    ? undefined
    : Array.isArray(expectedCommand) ? expectedCommand : [expectedCommand];
  if (expected && !expected.includes(typedCommand)) {
    throw new CliArgumentError(`expected subcommand ${expected.join(' or ')}, received ${typedCommand}`);
  }

  const schema = COMMAND_SCHEMAS[typedCommand];
  const parsed = new Map<string, string[]>();
  for (let index = 1; index < args.length; index++) {
    const token = args[index]!;
    const option = schema.options[token];
    if (!option) {
      throw new CliArgumentError(
        token.startsWith('-') ? `unknown option for ${typedCommand}: ${token}` : `unexpected argument for ${typedCommand}: ${token}`,
      );
    }
    const prior = parsed.get(token);
    if (prior && !option.repeatable) {
      throw new CliArgumentError(`option ${token} may only be provided once`);
    }
    if (option.kind === 'boolean') {
      parsed.set(token, ['true']);
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('-')) {
      throw new CliArgumentError(`option ${token} requires a value`);
    }
    const validationError = option.validate?.(value);
    if (validationError) throw new CliArgumentError(`${token} ${validationError}`);
    if (prior) prior.push(value);
    else parsed.set(token, [value]);
    index++;
  }

  for (const group of schema.conflicts ?? []) {
    const selected = group.filter((name) => parsed.has(name));
    if (selected.length > 1) {
      throw new CliArgumentError(`${selected.join(' and ')} cannot be used together`);
    }
  }

  return {
    command: typedCommand,
    raw: [...args],
    has: (name) => parsed.has(name),
    value: (name) => parsed.get(name)?.[0],
    values: (name) => parsed.get(name) ?? [],
  };
}

type CliArgSource = ParsedCliArgs | readonly string[];

function isParsedCliArgs(args: CliArgSource): args is ParsedCliArgs {
  return typeof (args as Partial<ParsedCliArgs>).has === 'function';
}

function optionValues(args: CliArgSource, name: string): readonly string[] {
  if (isParsedCliArgs(args)) return args.values(name);
  const results: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === name) results.push(args[index + 1]!);
  }
  return results;
}

function optionValue(args: CliArgSource, name: string): string | undefined {
  return optionValues(args, name)[0];
}

function hasOption(args: CliArgSource, name: string): boolean {
  return isParsedCliArgs(args) ? args.has(name) : args.includes(name);
}

export function explicitLspEnabled(args: CliArgSource): boolean | undefined {
  const enabled = hasOption(args, '--lsp');
  const disabled = hasOption(args, '--no-lsp');
  if (enabled && disabled) throw new CliArgumentError('--lsp and --no-lsp cannot be used together');
  return enabled ? true : disabled ? false : undefined;
}

export function explicitScipEnabled(args: CliArgSource): boolean | undefined {
  const enabled = hasOption(args, '--scip');
  const disabled = hasOption(args, '--no-scip');
  if (enabled && disabled) throw new CliArgumentError('--scip and --no-scip cannot be used together');
  return enabled ? true : disabled ? false : undefined;
}

export function explicitBuildExecutionAllowed(args: CliArgSource): boolean | undefined {
  if (hasOption(args, '--allow-build-execution')) return true;
  return undefined;
}

export function scipScopeFromArgs(args: CliArgSource): ScipScope | undefined {
  const languages = optionValues(args, '--scip-scope-language');
  const includeGlobs = optionValues(args, '--scip-scope-include');
  const excludeGlobs = optionValues(args, '--scip-scope-exclude');
  if (languages.length === 0 && includeGlobs.length === 0 && excludeGlobs.length === 0) return undefined;
  if (hasOption(args, '--no-scip')) throw new CliArgumentError('--no-scip cannot be used together with SCIP scope flags');
  try {
    return canonicalScopeRequest({
      languages,
      ...(includeGlobs.length > 0 && { includeGlobs }),
      ...(excludeGlobs.length > 0 && { excludeGlobs }),
    });
  } catch (error) {
    throw new CliArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/** Parse host-trusted execution flags. Repository config never contributes here. */
export function executionOptionsFromArgs(args: CliArgSource): IndexExecutionOptions {
  const allowedCwdRoots = [
    ...optionValues(args, '--allow-command-cwd'),
    ...optionValues(args, '--allow-external-build-root'),
  ];
  return {
    ...(hasOption(args, '--allow-subprocess-execution') && { allowSubprocessExecution: true }),
    ...(hasOption(args, '--allow-build-execution') && { allowBuildExecution: true }),
    ...(hasOption(args, '--allow-custom-indexer-commands') && {
      allowCustomIndexerCommands: true,
    }),
    ...(hasOption(args, '--allow-custom-lsp-commands') && { allowCustomLspCommands: true }),
    ...(hasOption(args, '--allow-auto-install') && { allowAutoInstall: true }),
    ...(allowedCwdRoots.length > 0 && { allowedCwdRoots }),
  };
}

/** Build the exact walker scope shared by index, refresh, watch, poll, and MCP live refresh. */
export function walkerConfigFromArgs(args: CliArgSource, rootDir: string): WalkerConfig {
  const includeGlobs = [...optionValues(args, '--include')];
  const excludeGlobs = [...optionValues(args, '--exclude')];
  const languageNames = optionValues(args, '--language');
  const extensions: string[] = [];
  for (const language of languageNames) {
    const languageExtensions = LANG_TO_EXTS[language];
    if (!languageExtensions) {
      throw new CliArgumentError(
        `unknown language "${language}"; known languages: ${Object.keys(LANG_TO_EXTS).join(', ')}`,
      );
    }
    extensions.push(...languageExtensions);
  }
  return {
    rootDir,
    ...(includeGlobs.length > 0 && { includeGlobs }),
    ...(excludeGlobs.length > 0 && { excludeGlobs }),
    ...(extensions.length > 0 && { extensions: [...new Set(extensions)] }),
  };
}

export interface ValidationArgsOptions {
  /** Always return a policy, even when no validation-specific flag is present. */
  always?: boolean;
  /** Reuse index/doctor --include and --exclude flags as the validation scope. */
  includeScope?: boolean;
}

/** Build explicit validation policy overrides from CLI flags. */
export function validationPolicyFromArgs(
  args: CliArgSource,
  options: ValidationArgsOptions = {},
): IndexValidationPolicy | undefined {
  const profileRaw = optionValue(args, '--validation-profile') ?? optionValue(args, '--profile');
  const requiredGlobs = [...optionValues(args, '--required')];
  const numericFlags: Array<[
    cliName: string,
    policyName: keyof IndexCoverageThresholds,
    kind: 'count' | 'rate',
  ]> = [
    ['--min-files', 'minFiles', 'count'],
    ['--min-symbols', 'minSymbols', 'count'],
    ['--min-call-refs', 'minCallRefs', 'count'],
    ['--min-type-refs', 'minTypeRefs', 'count'],
    ['--min-imports', 'minImports', 'count'],
    ['--min-symbol-coverage', 'minSymbolCoverage', 'rate'],
    ['--min-call-resolution-rate', 'minCallResolutionRate', 'rate'],
    ['--min-type-resolution-rate', 'minTypeResolutionRate', 'rate'],
    ['--min-import-resolution-rate', 'minImportResolutionRate', 'rate'],
    ['--max-symbol-less-files', 'maxSymbolLessFiles', 'count'],
    ['--max-invalid-spans', 'maxInvalidSpans', 'count'],
    ['--max-duplicate-symbols', 'maxDuplicateSymbols', 'count'],
    ['--max-unresolved-internal-refs', 'maxUnresolvedInternalRefs', 'count'],
  ];
  const thresholds: IndexCoverageThresholds = {};
  let hasNumericFlag = false;
  for (const [cliName, policyName, kind] of numericFlags) {
    const raw = optionValue(args, cliName);
    if (raw === undefined) continue;
    const value = Number(raw);
    const valid = kind === 'rate'
      ? Number.isFinite(value) && value >= 0 && value <= 1
      : Number.isInteger(value) && value >= 0;
    if (!valid) {
      throw new Error(`${cliName} must be ${kind === 'rate' ? 'a number from 0 to 1' : 'a non-negative integer'}`);
    }
    thresholds[policyName] = value;
    hasNumericFlag = true;
  }
  const maxBaselineAgeRaw = optionValue(args, '--max-baseline-age-seconds');
  const maxDirtyFilesRaw = optionValue(args, '--max-dirty-files');
  const maxBaselineAgeSeconds = parseOptionalNonNegativeInteger(maxBaselineAgeRaw, '--max-baseline-age-seconds');
  const maxDirtyFiles = parseOptionalNonNegativeInteger(maxDirtyFilesRaw, '--max-dirty-files');
  const requested = options.always === true
    || profileRaw !== undefined
    || requiredGlobs.length > 0
    || hasNumericFlag
    || maxBaselineAgeRaw !== undefined
    || maxDirtyFilesRaw !== undefined;
  if (!requested) return undefined;

  const includeGlobs = options.includeScope ? [...optionValues(args, '--include')] : [];
  const excludeGlobs = options.includeScope ? [...optionValues(args, '--exclude')] : [];
  return {
    ...(profileRaw !== undefined && { profile: parseValidationProfile(profileRaw) }),
    ...(includeGlobs.length > 0 && { includeGlobs }),
    ...(excludeGlobs.length > 0 && { excludeGlobs }),
    ...(requiredGlobs.length > 0 && { requiredGlobs }),
    ...(Object.keys(thresholds).length > 0 && { thresholds }),
    ...(maxBaselineAgeSeconds !== undefined && { maxBaselineAgeSeconds }),
    ...(maxDirtyFiles !== undefined && { maxDirtyFiles }),
  };
}

function parseOptionalNonNegativeInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
/** Language-to-extension map derived from the walker registry to prevent drift. */
export const LANG_TO_EXTS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    [...new Set(Object.values(EXT_TO_LANG))].sort().map((language) => [
      language,
      Object.entries(EXT_TO_LANG)
        .filter(([, candidate]) => candidate === language)
        .map(([extension]) => extension)
        .sort(),
    ]),
  ),
);
