import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { SUPPORTED_PARSER_LANGUAGES } from '../parsing/parser.js';

export interface LspServerCommand {
  command: string;
  args: string[];
}

export interface ResolvedLspServerCommand extends LspServerCommand {
  language: string;
  available: boolean;
  resolvedPath: string | null;
}

export type LspServerRegistry = Record<string, LspServerCommand>;
export type LspServerRegistryOverrides = Partial<Record<string, Partial<LspServerCommand>>>;

export const DEFAULT_LSP_SERVER_REGISTRY: LspServerRegistry = {
  c: { command: 'clangd', args: [] },
  rust: { command: 'rust-analyzer', args: [] },
  python: { command: 'pyright-langserver', args: ['--stdio'] },
  cpp: { command: 'clangd', args: [] },
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  javascript: { command: 'typescript-language-server', args: ['--stdio'] },
  go: { command: 'gopls', args: [] },
  java: { command: 'jdtls', args: [] },
  csharp: { command: 'csharp-ls', args: [] },
  ruby: { command: 'solargraph', args: ['stdio'] },
  php: { command: 'intelephense', args: ['--stdio'] },
  swift: { command: 'sourcekit-lsp', args: [] },
  kotlin: { command: 'kotlin-language-server', args: [] },
  scala: { command: 'metals', args: [] },
  lua: { command: 'lua-language-server', args: [] },
  bash: { command: 'bash-language-server', args: ['start'] },
  elixir: { command: 'elixir-ls', args: [] },
  zig: { command: 'zls', args: [] },
  ocaml: { command: 'ocamllsp', args: [] },
  haskell: { command: 'haskell-language-server-wrapper', args: ['--lsp'] },
  julia: {
    command: 'julia',
    args: ['--startup-file=no', '--history-file=no', '--quiet', '--eval', 'using LanguageServer, SymbolServer; runserver()'],
  },
  elm: { command: 'elm-language-server', args: [] },
  objc: { command: 'clangd', args: [] },
};

export function getDefaultLspServerRegistry(): LspServerRegistry {
  return cloneRegistry(DEFAULT_LSP_SERVER_REGISTRY);
}

export function mergeLspServerRegistry(overrides: LspServerRegistryOverrides = {}): LspServerRegistry {
  const merged = getDefaultLspServerRegistry();

  for (const [language, override] of Object.entries(overrides)) {
    if (!override) continue;
    const base = merged[language];
    if (!base) {
      throw new Error(`Unsupported LSP language override "${language}"`);
    }
    merged[language] = {
      command: override.command ?? base.command,
      args: override.args ?? base.args,
    };
  }

  return merged;
}

export function resolveExecutableOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command.trim()) return null;

  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    return isExecutable(command) ? command : null;
  }

  const pathValue = env.PATH ?? '';
  if (!pathValue) return null;

  const pathEntries = pathValue.split(delimiter).filter((entry) => entry.length > 0);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((entry) => entry.length > 0)
    : [''];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, process.platform === 'win32' ? `${command}${extension}` : command);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function resolveLspServerRegistry(
  registry: LspServerRegistry = DEFAULT_LSP_SERVER_REGISTRY,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ResolvedLspServerCommand> {
  const resolvedEntries: Record<string, ResolvedLspServerCommand> = {};
  for (const [language, config] of Object.entries(registry)) {
    const resolvedPath = resolveExecutableOnPath(config.command, env);
    resolvedEntries[language] = {
      language,
      command: config.command,
      args: [...config.args],
      available: resolvedPath !== null,
      resolvedPath,
    };
  }
  return resolvedEntries;
}

export function getMissingLanguageServerCommands(
  registry: LspServerRegistry = DEFAULT_LSP_SERVER_REGISTRY,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.values(resolveLspServerRegistry(registry, env))
    .filter((entry) => !entry.available)
    .map((entry) => entry.language)
    .sort();
}

export function hasCompleteLanguageCoverage(registry: LspServerRegistry = DEFAULT_LSP_SERVER_REGISTRY): boolean {
  const languages = Object.keys(registry).sort();
  return JSON.stringify(languages) === JSON.stringify([...SUPPORTED_PARSER_LANGUAGES].sort());
}

function cloneRegistry(registry: LspServerRegistry): LspServerRegistry {
  const cloned: LspServerRegistry = {};
  for (const [language, command] of Object.entries(registry)) {
    cloned[language] = {
      command: command.command,
      args: [...command.args],
    };
  }
  return cloned;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
