/**
 * @module cli/commands/serve-cmd
 *
 * Handler for the `lore mcp` subcommand.
 */

import * as fs from 'node:fs';
import {
  CliArgumentError,
  parseCliArgs,
  usage,
  executionOptionsFromArgs,
  walkerConfigFromArgs,
} from '../args.js';
import type { ResolvedIndexBuilderConfiguration } from '../../indexer/index.js';
import type { LoreLogger } from '../../logger.js';

export async function runServeCommand(args: string[], log: LoreLogger): Promise<void> {
  const parsedArgs = parseCliArgs(args, 'mcp');
  const rootDir = parsedArgs.value('--root');
  let dbPath = parsedArgs.value('--db');

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

  const watchMode = parsedArgs.has('--watch');
  const pollMode = parsedArgs.has('--poll');
  if ((watchMode || pollMode) && !rootDir) {
    throw new CliArgumentError('--root <dir> is required when using --watch or --poll with mcp');
  }

  const execution = executionOptionsFromArgs(parsedArgs);
  const walkerConfig = walkerConfigFromArgs(parsedArgs, rootDir ?? '.');
  let configuration: ResolvedIndexBuilderConfiguration | null = null;
  let indexBuilder: import('../../indexer/index.js').IndexBuilder | null = null;
  if (rootDir) {
    try {
      const { IndexBuilder } = await import('../../indexer/index.js');
      indexBuilder = new IndexBuilder(dbPath, walkerConfig, undefined, { execution });
      configuration = await indexBuilder.resolveConfiguration();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}\n`);
      process.exit(1);
      return;
    }
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
    await indexBuilder!.build();
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
  const { assertLoreSchemaCompatible } = await import('../../db/schema-info.js');
  const { createLoreMcpServer } = await import('../../server/server.js');
  const { getLoreMeta } = await import('../../db/schema.js');

  const db = openReadOnly(dbPath);
  try {
    assertLoreSchemaCompatible(db, 'Lore MCP server');
  } catch (error) {
    db.close();
    throw error;
  }

  // Gather DB stats for startup log
  const totalFiles = (db.prepare('SELECT COUNT(*) AS cnt FROM effective_files').get() as { cnt: number }).cnt;
  const totalSymbols = (db.prepare('SELECT COUNT(*) AS cnt FROM effective_symbols').get() as { cnt: number }).cnt;
  let totalEdges = 0;
  try {
    totalEdges = (db.prepare('SELECT COUNT(*) AS cnt FROM effective_symbol_refs').get() as { cnt: number }).cnt;
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
  const { LoreRuntime } = await import('../../runtime.js');
  const runtime = new LoreRuntime({
    dbPath,
    rootDir: rootDir ?? '.',
    walkerConfig,
    lsp: configuration?.lsp ?? null,
    scip: configuration?.scip ?? null,
    execution,
    history: false,
    indexDependencies: false,
    embeddingModel: modelName ?? undefined,
    refreshMode: (watchMode && rootDir) ? 'watch' : (pollMode && rootDir) ? 'poll' : 'none',
  }, log);

  await runtime.start();
  embedder = runtime.embedder;

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
