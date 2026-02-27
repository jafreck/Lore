#!/usr/bin/env node
/**
 * @module cli
 *
 * Lore CLI — unified entry point for indexing and the MCP server.
 *
 * Usage:
 *   lore index --root <dir> --db <path> [--embedding-model <id>]
 *                              Index a codebase into a knowledge-base file.
 *   lore mcp --db <path>                        Start the knowledge-base MCP server (stdio transport).
 *   lore refresh --db <path> --root <dir>       Run an incremental index update and exit.
 *   lore refresh --db <path> --root <dir> --watch  Watch for changes and refresh automatically.
 *   lore refresh --db <path> --root <dir> --poll   Poll for changes and refresh automatically.
 */

import * as fs from 'node:fs';

// ─── Argument helpers ─────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    `Usage:
  lore index --root <dir> --db <path> [--embedding-model <id>]
                         Index a codebase into a knowledge-base SQLite file
  lore mcp --db <path>                          Start the KB MCP server (stdio transport)
  lore refresh --db <path> --root <dir>         Run an incremental index update and exit
  lore refresh --db <path> --root <dir> --watch Watch for file changes and refresh automatically
  lore refresh --db <path> --root <dir> --poll  Poll for file changes and refresh automatically

Options:
  --root <dir>             Root directory to index (required for index, refresh)
  --db <path>              Path to a Lore knowledge-base SQLite file (required for index, mcp, refresh)
  --embedding-model <id>   Embedding model identifier (default: Qwen/Qwen3-Embedding-4B)
  --include <glob>         Glob pattern for files to include (repeatable)
  --exclude <glob>         Glob pattern for paths to exclude (repeatable)
  --language <lang>        Language name to filter by, e.g. typescript (repeatable)
  --watch                  Enable fs-event watch mode (low-latency, may miss events on some platforms)
  --poll                   Enable polling mode (reliable but higher CPU/IO cost)
  --help, -h               Show this help message`,
  );
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/** Returns all values provided for a repeatable flag (e.g. --include a --include b → ['a', 'b']). */
function flags(args: string[], name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) results.push(args[i + 1] as string);
  }
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    usage();
  }

  const subcommand = args[0];

  if (subcommand === 'index') {
    const rootDir = flag(args, '--root');
    const dbPath = flag(args, '--db');
    if (!rootDir) {
      console.error('Error: --root <dir> is required for the index subcommand.\n');
      usage();
    }
    if (!dbPath) {
      console.error('Error: --db <path> is required for the index subcommand.\n');
      usage();
    }
    const embeddingModel = flag(args, '--embedding-model');
    const includeGlobs = flags(args, '--include');
    const excludeGlobs = flags(args, '--exclude');
    const languageNames = flags(args, '--language');

    // Static reverse map: language name → extensions (mirrors EXT_TO_LANG in walker.ts)
    const LANG_TO_EXTS: Record<string, string[]> = {
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
      dart: ['.dart'],
      ocaml: ['.ml', '.mli'],
      haskell: ['.hs'],
      julia: ['.jl'],
      elm: ['.elm'],
      objc: ['.m', '.mm'],
    };

    // Resolve --language names to extensions
    let extensions: string[] | undefined;
    if (languageNames.length > 0) {
      extensions = [];
      for (const lang of languageNames) {
        const exts = LANG_TO_EXTS[lang];
        if (!exts) {
          console.error(`Error: unknown language "${lang}". Known languages: ${Object.keys(LANG_TO_EXTS).sort().join(', ')}\n`);
          process.exit(1);
        }
        extensions.push(...exts);
      }
    }

    const { IndexBuilder } = await import('./indexer/index.js');

    const builder = new IndexBuilder(
      dbPath,
      {
        rootDir,
        ...(includeGlobs.length > 0 && { includeGlobs }),
        ...(excludeGlobs.length > 0 && { excludeGlobs }),
        ...(extensions && { extensions }),
      },
      undefined,
      embeddingModel,
    );
    await builder.build();
  } else if (subcommand === 'mcp') {
    const dbPath = flag(args, '--db');
    if (!dbPath) {
      console.error('Error: --db <path> is required for the mcp subcommand.\n');
      usage();
    }

    // Dynamically import so tree-shaking keeps the MCP server out of the
    // library entry point for consumers who only need the indexer.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/stdio.js'
    );

    const { openReadOnly } = await import('./kb-server/db.js');
    const { createKbMcpServer } = await import('./kb-server/server.js');
    const { getKbMeta } = await import('./indexer/db.js');
    const {
      SentenceTransformersProvider,
    } = await import('./indexer/embedder.js');

    const db = openReadOnly(dbPath);

    // Build optional embedder from model recorded at index time.
    let embedder: import('./indexer/embedder.js').EmbeddingProvider | undefined;
    const modelName = getKbMeta(db, 'embedding_model') as string | undefined;
    if (modelName) {
      const provider = new SentenceTransformersProvider(modelName);
      try {
        await provider.init();
        embedder = provider;
      } catch {
        try {
          await provider.dispose();
        } catch {
          /* ignore */
        }
      }
    }

    const server = createKbMcpServer(db, dbPath, embedder);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Signal readiness on stderr so parent processes can detect it.
    process.stderr.write('READY\n');
  } else if (subcommand === 'refresh') {
    const dbPath = flag(args, '--db');
    const rootDir = flag(args, '--root');

    if (!dbPath || !rootDir) {
      console.error('Error: --db <path> and --root <dir> are required for the refresh subcommand.\n');
      usage();
    }

    const watchMode = args.includes('--watch');
    const pollMode = args.includes('--poll');

    const walkerConfig = { rootDir };

    if (watchMode) {
      const { FileWatcher } = await import('./indexer/watcher.js');
      const watcher = new FileWatcher(dbPath, walkerConfig);
      watcher.start();
      process.stderr.write(
        JSON.stringify({ level: 'info', source: 'cli', message: 'watch mode started', rootDir }) + '\n',
      );
      // Keep the process alive until interrupted
      process.on('SIGINT', () => { watcher.stop(); process.exit(0); });
      process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });
    } else if (pollMode) {
      const { FilePoller } = await import('./indexer/poller.js');
      const poller = new FilePoller(dbPath, walkerConfig);
      poller.start();
      process.stderr.write(
        JSON.stringify({ level: 'info', source: 'cli', message: 'poll mode started', rootDir }) + '\n',
      );
      // Keep the process alive until interrupted
      process.on('SIGINT', () => { poller.stop(); process.exit(0); });
      process.on('SIGTERM', () => { poller.stop(); process.exit(0); });
    } else {
      // Manual refresh: full build if DB doesn't exist yet, otherwise incremental update
      const { IndexBuilder } = await import('./indexer/index.js');
      const builder = new IndexBuilder(dbPath, walkerConfig);

      const dbExists = fs.existsSync(dbPath);
      if (dbExists) {
        const { walkFiles } = await import('./indexer/walker.js');
        const files = await walkFiles(walkerConfig);
        const changedPaths = files.map(f => f.path);
        await builder.update(changedPaths);
      } else {
        await builder.build();
      }

      process.stderr.write(
        JSON.stringify({ level: 'info', source: 'cli', message: 'refresh complete', rootDir }) + '\n',
      );
    }
  } else {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    usage();
  }
}

main().catch((err) => {
  console.error('lore: fatal error:', err);
  process.exit(1);
});
