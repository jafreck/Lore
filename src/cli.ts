#!/usr/bin/env node
/**
 * @module cli
 *
 * Lore CLI — unified entry point for indexing and the MCP server.
 *
 * Usage:
 *   lore index --root <dir> --db <path> [--branch <name>]
 *                              Index a codebase into a Lore knowledge-base SQLite file.
 *   lore mcp --db <path>           Start the knowledge-base MCP server (stdio transport).
 *   lore mcp --db <path> --sse     Start the MCP server with SSE/HTTP transport.
 */

import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ─── Argument helpers ─────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    `Usage:
  lore index --root <dir> --db <path> [--branch <name>]
                             Index a codebase into the knowledge-base
  lore mcp --db <path>      Start the KB MCP server (stdio transport)

Options:
  --root <dir>     Root directory to index (required for index)
  --db <path>      Path to a Lore knowledge-base SQLite file (required)
  --branch <name>  Git branch name to tag indexed rows (default: current HEAD)
  --help, -h       Show this help message`,
  );
  process.exit(1);
}

/** Resolve the current git HEAD branch name, falling back to 'HEAD'. */
function currentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'HEAD';
  }
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
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

    const branch = flag(args, '--branch') ?? currentBranch();

    const { IndexBuilder } = await import('./indexer/index.js');
    const builder = new IndexBuilder(dbPath, { rootDir, branch });
    await builder.build();
    console.error(`lore: indexed ${rootDir} → ${dbPath} (branch: ${branch})`);
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
  } else {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    usage();
  }
}

main().catch((err) => {
  console.error('lore: fatal error:', err);
  process.exit(1);
});
