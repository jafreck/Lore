/**
 * @module cli/commands/serve-cmd
 *
 * Handler for the `lore mcp` subcommand.
 */

import * as fs from 'node:fs';
import { flag, usage } from '../args.js';
import type { LoreLogger } from '../../logger.js';

export async function runServeCommand(args: string[], log: LoreLogger): Promise<void> {
  const rootDir = flag(args, '--root');
  let dbPath = flag(args, '--db');

  if (!dbPath && !rootDir) {
    console.error('Error: --root <dir> or --db <path> is required for the mcp subcommand.\n');
    usage();
    return;
  }

  // When --root is given without --db, derive a default DB path.
  if (!dbPath) {
    const { join } = await import('node:path');
    dbPath = join(rootDir!, '.lore', 'lore.db');
  }

  // Auto-index if the DB does not exist and we have a root directory.
  if (!fs.existsSync(dbPath) && rootDir) {
    log.startup('auto-indexing before mcp start', { dbPath, rootDir });
    process.stderr.write(
      JSON.stringify({ level: 'info', source: 'cli', message: 'auto-indexing repository', rootDir, dbPath }) + '\n',
    );
    const { join } = await import('node:path');
    const dir = join(dbPath, '..');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const { IndexBuilder } = await import('../../indexer/index.js');
    const builder = new IndexBuilder(dbPath, { rootDir });
    await builder.build();
    log.startup('auto-index complete', { dbPath });
  } else if (!fs.existsSync(dbPath)) {
    console.error(`Error: database file not found: ${dbPath}\nProvide --root <dir> to auto-index, or create the DB first with \`lore index\`.\n`);
    process.exit(1);
    return;
  }

  log.startup('mcp server initializing', { dbPath });

  // Dynamically import so tree-shaking keeps the MCP server out of the
  // library entry point for consumers who only need the indexer.
  const { StdioServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/stdio.js'
  );

  const { openReadOnly } = await import('../../db/read-only.js');
  const { createLoreMcpServer } = await import('../../server/server.js');
  const { getLoreMeta } = await import('../../db/schema.js');

  const db = openReadOnly(dbPath);

  // Gather DB stats for startup log
  const totalFiles = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
  const totalSymbols = (db.prepare('SELECT COUNT(*) AS cnt FROM symbols').get() as { cnt: number }).cnt;
  let totalEdges = 0;
  try {
    totalEdges = (db.prepare('SELECT COUNT(*) AS cnt FROM symbol_refs').get() as { cnt: number }).cnt;
  } catch { /* table may not exist */ }
  let commitCount: number | undefined;
  try {
    commitCount = (db.prepare('SELECT COUNT(*) AS cnt FROM commits').get() as { cnt: number }).cnt;
  } catch { /* commits table may not exist */ }
  const dbSizeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : undefined;

  // Build optional embedder from model recorded at index time.
  let embedder: import('../../embeddings/embedder.js').EmbeddingProvider | undefined;
  const modelName = getLoreMeta(db, 'embedding_model') as string | undefined;

  // ── Optional live-index watcher/poller (shares the same embedder) ────
  const watchMode = args.includes('--watch');
  const pollMode = args.includes('--poll');

  const { LoreRuntime } = await import('../../runtime.js');
  const runtime = new LoreRuntime({
    dbPath,
    rootDir: rootDir ?? '.',
    walkerConfig: { rootDir: rootDir ?? '.' },
    lsp: null,
    scip: null,
    history: false,
    indexDependencies: false,
    embeddingModel: modelName ?? undefined,
    refreshMode: (watchMode && rootDir) ? 'watch' : (pollMode && rootDir) ? 'poll' : 'none',
  }, log);

  await runtime.start();
  embedder = runtime.embedder;

  if ((watchMode || pollMode) && !rootDir) {
    log.warn('startup', '--root <dir> is required when using --watch or --poll with mcp; live indexing disabled');
  }

  log.startup('db stats', {
    dbPath,
    dbSizeBytes,
    embeddingModel: modelName ?? null,
    embeddingReady: !!embedder,
    totalFiles,
    totalSymbols,
    totalEdges,
    commitCount,
  });

  const server = await createLoreMcpServer(db, dbPath, embedder, { logger: log });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.startup('mcp server ready', { transport: 'stdio' });

  // Signal readiness on stderr so parent processes can detect it.
  process.stderr.write('READY\n');

  runtime.installSignalHandlers();
}
