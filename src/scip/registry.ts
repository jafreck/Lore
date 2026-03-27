/**
 * @module indexer/scip/registry
 *
 * Maps Lore language names to SCIP indexer commands.
 *
 * Each entry describes how to invoke the SCIP indexer for a given language,
 * including the command, arguments, and the output file name.  Not every
 * language Lore supports has a SCIP indexer — those without one fall back
 * to LSP enrichment (and ultimately to tree-sitter-only resolution).
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScipIndexerCommand {
  /** Executable name (resolved on PATH). */
  command: string;
  /**
   * Arguments template.  The placeholder `{output}` is replaced with the
   * desired output file path at invocation time.
   */
  args: string[];
  /** Working-directory relative to the project root (default: project root). */
  cwd?: string;
}

export interface ResolvedScipIndexerCommand extends ScipIndexerCommand {
  language: string;
  available: boolean;
  resolvedPath: string | null;
}

export type ScipIndexerRegistry = Record<string, ScipIndexerCommand>;
export type ScipIndexerRegistryOverrides = Partial<Record<string, Partial<ScipIndexerCommand>>>;

// ─── Default registry ─────────────────────────────────────────────────────────

/**
 * Languages with known, actively-maintained SCIP indexers.
 *
 * | Language group          | Indexer             |
 * |-------------------------|---------------------|
 * | TypeScript              | scip-typescript     |
 * | Python                  | scip-python         |
 * | Java, Scala, Kotlin     | scip-java           |
 * | Rust                    | rust-analyzer scip  |
 * | C, C++                  | scip-clang          |
 * | C#                      | scip-dotnet         |
 * | Ruby                    | scip-ruby           |
 * | PHP                     | scip-php            |
 * | Go                      | scip-go             |
 * | Dart                    | scip-dart           |
 */
export const DEFAULT_SCIP_INDEXER_REGISTRY: ScipIndexerRegistry = {
  typescript: { command: 'scip-typescript', args: ['index', '--output', '{output}'] },
  python:     { command: 'scip-python',     args: ['index', '.', '--project-name', 'project', '--output', '{output}'] },
  java:       { command: 'scip-java',       args: ['index', '--output', '{output}'] },
  scala:      { command: 'scip-java',       args: ['index', '--output', '{output}'] },
  kotlin:     { command: 'scip-java',       args: ['index', '--output', '{output}'] },
  rust:       { command: 'rust-analyzer',   args: ['scip', '.'] },
  c:          { command: 'scip-clang',      args: ['--compdb-path={compdb}', '--index-output-path={output}'] },
  cpp:        { command: 'scip-clang',      args: ['--compdb-path={compdb}', '--index-output-path={output}'] },
  csharp:     { command: 'scip-dotnet',     args: ['index', '.', '--output', '{output}'] },
  ruby:       { command: 'scip-ruby',       args: ['--output', '{output}'] },
  php:        { command: 'scip-php',        args: ['index', '--output', '{output}'] },
  go:         { command: 'scip-go',         args: [] },
  dart:       { command: 'scip-dart',       args: ['index', '--output', '{output}'] },
};

/** Set of languages that have a SCIP indexer in the default registry. */
export const SCIP_SUPPORTED_LANGUAGES = new Set(Object.keys(DEFAULT_SCIP_INDEXER_REGISTRY));

// ─── Registry helpers ─────────────────────────────────────────────────────────

export function getDefaultScipIndexerRegistry(): ScipIndexerRegistry {
  const cloned: ScipIndexerRegistry = {};
  for (const [lang, cmd] of Object.entries(DEFAULT_SCIP_INDEXER_REGISTRY)) {
    cloned[lang] = { command: cmd.command, args: [...cmd.args], ...(cmd.cwd && { cwd: cmd.cwd }) };
  }
  return cloned;
}

export function mergeScipIndexerRegistry(overrides: ScipIndexerRegistryOverrides = {}): ScipIndexerRegistry {
  const merged = getDefaultScipIndexerRegistry();
  for (const [lang, override] of Object.entries(overrides)) {
    if (!override) continue;
    const base = merged[lang];
    if (base) {
      merged[lang] = {
        command: override.command ?? base.command,
        args: override.args ?? base.args,
        ...(override.cwd !== undefined ? { cwd: override.cwd } : base.cwd ? { cwd: base.cwd } : {}),
      };
    } else {
      // Allow adding indexers for languages not in the default registry.
      if (override.command && override.args) {
        merged[lang] = { command: override.command, args: override.args, ...(override.cwd && { cwd: override.cwd }) };
      }
    }
  }
  return merged;
}

export function resolveScipIndexerRegistry(
  registry: ScipIndexerRegistry = DEFAULT_SCIP_INDEXER_REGISTRY,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ResolvedScipIndexerCommand> {
  const resolved: Record<string, ResolvedScipIndexerCommand> = {};
  // Deduplicate commands that share the same executable (e.g., scip-java for java/scala/kotlin).
  const resolveCache = new Map<string, string | null>();

  for (const [lang, cmd] of Object.entries(registry)) {
    let resolvedPath = resolveCache.get(cmd.command);
    if (resolvedPath === undefined) {
      resolvedPath = resolveExecutableOnPath(cmd.command, env);
      resolveCache.set(cmd.command, resolvedPath);
    }
    resolved[lang] = {
      language: lang,
      command: cmd.command,
      args: [...cmd.args],
      ...(cmd.cwd && { cwd: cmd.cwd }),
      available: resolvedPath !== null,
      resolvedPath,
    };
  }
  return resolved;
}

// ─── PATH resolution (shared with LSP registry pattern) ──────────────────────

/** Directory where Lore stores managed SCIP indexer binaries. */
function getLoreBinDir(): string {
  return join(homedir(), '.lore', 'bin');
}

/**
 * Resolve an npm-bundled binary (e.g. scip-typescript shipped as an npm dep).
 * Checks node_modules/.bin relative to the Lore package root.
 */
function resolveNpmBundledBinary(command: string): string | null {
  // Lore package root is two levels up from dist/scip/
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin', command),
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command.trim()) return null;

  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    return isExecutable(command) ? command : null;
  }

  // 1. Check Lore managed bin directory (~/.lore/bin/)
  const loreBin = join(getLoreBinDir(), command);
  if (isExecutable(loreBin)) return loreBin;

  // 2. Check npm-bundled binaries (node_modules/.bin/)
  const npmBin = resolveNpmBundledBinary(command);
  if (npmBin) return npmBin;

  // 3. Check system PATH
  const pathValue = env.PATH ?? '';
  if (!pathValue) return null;

  const pathEntries = pathValue.split(delimiter).filter((e) => e.length > 0);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((e) => e.length > 0)
    : [''];

  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = join(entry, process.platform === 'win32' ? `${command}${ext}` : command);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
