/**
 * @module cli/args
 *
 * Shared argument parsing utilities and usage text for the Lore CLI.
 */

// ─── Usage ────────────────────────────────────────────────────────────────────

export function usage(): never {
  console.error(
    `Usage:
  lore index --root <dir> --db <path> [--embeddings] [--embedding-model <id>] [--index-deps] [--history] [--history-depth <n>] [--history-all]
                         Index a codebase into a knowledge-base SQLite file
  lore mcp --root <dir> [--watch|--poll]   Start the Lore MCP server, auto-indexing if no DB exists yet
  lore mcp --db <path> [--root <dir> --watch|--poll]  Start the Lore MCP server with a pre-indexed DB
  lore refresh --db <path> --root <dir> [--index-deps] [--history] [--history-depth <n>] [--history-all]  Run an incremental index update and exit
  lore refresh --db <path> --root <dir> --watch [--embedding-model <id>] Watch for file changes and refresh automatically
  lore refresh --db <path> --root <dir> --poll [--embedding-model <id>]  Poll for file changes and refresh automatically
  lore hooks --db <path> --root <dir> [--history] [--history-depth <n>] [--history-all] [--lsp]
                         Install git hooks for automatic refresh on commit/merge/checkout
  lore analyze --db <path> [--mode <mode>] [--edge-kinds <kind>] [--branch <name>] [--max-lines <n>]
                         Run graph analysis on the knowledge-base (cycles, components, clusters, summary)
  lore install-scip [--language <lang>] [--list]
                         Install SCIP indexers for richer code intelligence (auto-downloads missing indexers)

Options:
  --root <dir>             Root directory to index (required for index, refresh)
  --db <path>              Path to a Lore knowledge-base SQLite file (required for index, refresh; optional for mcp)
  --embedding-model <id>   Embedding model identifier (default: Qwen3-Embedding-0.6B-ONNX)
  --embeddings             Enable embedding generation during indexing (disabled by default)
  --no-embeddings          Disable embedding generation during indexing (default)
  --index-deps             Enable dependency API indexing (disabled by default)
  --max-workers <n>        Maximum number of parse worker threads
  --history                Enable git history ingestion
  --history-depth <n>      Limit commit ingestion to the most recent N commits
  --history-all            Traverse all refs (branches/tags) for history ingestion
  --include <glob>         Glob pattern for files to include (repeatable)
  --exclude <glob>         Glob pattern for paths to exclude (repeatable)
  --language <lang>        Language name to filter by, e.g. typescript (repeatable)
  --watch                  Enable fs-event watch mode (low-latency, may miss events on some platforms)
  --poll                   Enable polling mode (reliable but higher CPU/IO cost)
  --lsp                    Enable index-time LSP enrichment (disabled by default)
  --no-scip                Disable index-time SCIP indexing (enabled by default)
  --log-level <level>      Log level: debug, info, warn, error, silent (default: info)
  --log-file <path>        Path to the structured log file (default: lore.log next to the DB)
  --help, -h               Show this help message`,
  );
  process.exit(1);
}

// ─── Argument helpers ─────────────────────────────────────────────────────────

export function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/** Returns all values provided for a repeatable flag (e.g. --include a --include b → ['a', 'b']). */
export function flags(args: string[], name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) results.push(args[i + 1] as string);
  }
  return results;
}

export function explicitLspEnabled(args: string[]): boolean | undefined {
  if (args.includes('--lsp')) return true;
  return undefined;
}

export function explicitScipEnabled(args: string[]): boolean | undefined {
  if (args.includes('--no-scip')) return false;
  return undefined;
}



// Static reverse map: language name → extensions (mirrors EXT_TO_LANG in walker.ts)
export const LANG_TO_EXTS: Record<string, string[]> = {
  c: ['.c', '.h'],
  rust: ['.rs'],
  python: ['.py'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  go: ['.go'],
  java: ['.java'],
  csharp: ['.cs'],
  ruby: ['.rb'],
  php: ['.php'],
  swift: ['.swift'],
  kotlin: ['.kt', '.kts'],
  scala: ['.scala', '.sc'],
  lua: ['.lua'],
  bash: ['.sh', '.bash', '.zsh'],
  elixir: ['.ex', '.exs'],
  zig: ['.zig'],
  ocaml: ['.ml', '.mli'],
  haskell: ['.hs'],
  julia: ['.jl'],
  elm: ['.elm'],
  objc: ['.m', '.mm'],
};
