/**
 * @module lore-server/server
 *
 * Knowledge-base MCP server.
 *
 * Exports `createLoreMcpServer()` for use by `LoreServerProcess` (HTTP transport)
 * and retains a standalone CLI entry point for development/debugging.
 *
 * MCP tools exposed:
 *   lore_lookup    — symbol / file lookup
 *   lore_graph     — call / import graph queries
 *   lore_search    — structural, semantic, and fused search
 *   lore_docs      — indexed documentation list/get/search
 *   lore_test_map  — source-file to mapped-test lookup
 *   lore_snippet   — source-code snippet extraction
 *   lore_blame     — git blame metadata for file lines
 *   lore_metrics   — aggregate code metrics
 *   lore_history   — git commit history queries
 *   lore_diff      — exported symbol diff between branches
 *
 * Standalone usage:
 *   node dist/lore-server/server.js --db <path-to-lore.db>
 *   tsx src/lore-server/server.ts --db <path-to-lore.db>
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import {
  openReadOnly,
  type Database,
} from '../db/read-only.js';
import { getLoreMeta } from '../db/schema.js';
import { LazyEmbeddingProvider, type EmbeddingProvider } from '../embeddings/embedder.js';
import { getLogger, type LoreLogger } from '../logger.js';
import type { SearchObserver } from './tools/search.js';
import { buildToolModules, registerTools, type ToolModule } from './tool-registry.js';
import * as lookup from './tools/lookup.js';
import * as graph from './tools/graph.js';
import * as search from './tools/search.js';
import * as docsMod from './tools/docs.js';
import * as testMap from './tools/test-map.js';
import * as snippet from './tools/snippet.js';
import * as blame from './tools/blame.js';
import * as metrics from './tools/metrics.js';
import * as history from './tools/history.js';
import * as diff from './tools/diff.js';
import * as trace from './tools/trace.js';
import * as structure from './tools/structure.js';

// ─── Server options ───────────────────────────────────────────────────────────

/** Optional configuration for `createLoreMcpServer`. */
export interface LoreServerOptions {
  /** Callback invoked after every `lore_search` call with query/mode/latency/result metadata. */
  searchObserver?: SearchObserver;
  /** Logger instance. Falls back to the global logger when omitted. */
  logger?: LoreLogger;
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and return a fully-configured `McpServer` with all Lore tools registered.
 *
 * @param db       Read-only SQLite connection to the knowledge-base.
 * @param dbPath   Path to the DB file, needed by write tools for write access.
 * @param embedder Optional live embedding provider for semantic/fused search.
 * @param options  Optional server configuration (e.g. search observer).
 */
export function createLoreMcpServer(
  db: Database.Database,
  dbPath: string,
  embedder?: EmbeddingProvider,
  options?: LoreServerOptions,
): McpServer {
  const log = options?.logger ?? getLogger();

  const server = new McpServer(
    { name: 'lore-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // The tool modules are built synchronously from eagerly-imported tool files
  // at startup, then registered via the data-driven registry loop.
  // NOTE: `buildToolModules()` is async but only because it uses dynamic
  // imports.  The synchronous variant `createLoreMcpServerAsync()` should be
  // preferred for new code.  For backward-compat we register eagerly here
  // using a self-invoking async helper that blocks the server from being
  // ready until registration completes.
  //
  // However, McpServer.tool() is synchronous, so we need to register modules
  // synchronously.  We import tool modules eagerly at module scope instead.
  const toolModules = buildToolModulesSync();
  registerTools(server, toolModules, { db, dbPath, embedder, searchObserver: options?.searchObserver, logger: log });

  return server;
}

/**
 * Async version of `createLoreMcpServer` that properly awaits dynamic tool
 * module imports.  Preferred for new call-sites.
 */
export async function createLoreMcpServerAsync(
  db: Database.Database,
  dbPath: string,
  embedder?: EmbeddingProvider,
  options?: LoreServerOptions,
): Promise<McpServer> {
  const log = options?.logger ?? getLogger();

  const server = new McpServer(
    { name: 'lore-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const toolModules = await buildToolModules();
  registerTools(server, toolModules, { db, dbPath, embedder, searchObserver: options?.searchObserver, logger: log });

  return server;
}

// ─── Synchronous tool module builder ──────────────────────────────────────────

/**
 * Eagerly import all tool modules and build the registration list.
 * Used by the synchronous `createLoreMcpServer()` for backward compatibility.
 */
function buildToolModulesSync(): ToolModule[] {
  return [
    { def: lookup.toolDef, handlerFactory: (deps) => (args) => lookup.handler(deps.db, args, deps.embedder) },
    { def: graph.toolDef, handlerFactory: (deps) => (args) => graph.handler(deps.db, args) },
    { def: search.toolDef, handlerFactory: (deps) => (args) => search.handler(deps.db, args, deps.embedder, deps.searchObserver) },
    { def: docsMod.toolDef, handlerFactory: (deps) => (args) => docsMod.handler(deps.db, args, deps.embedder) },
    { def: testMap.toolDef, handlerFactory: (deps) => (args) => testMap.handler(deps.db, args) },
    { def: snippet.toolDef, handlerFactory: (deps) => (args) => snippet.handler(deps.db, args) },
    { def: blame.toolDef, handlerFactory: (deps) => (args) => blame.handler(deps.db, args) },
    { def: metrics.toolDef, handlerFactory: (deps) => (args) => metrics.handler(deps.db, args ?? {}) },
    { def: history.toolDef, handlerFactory: (deps) => (args) => history.handler(deps.db, args, deps.embedder) },
    { def: diff.toolDef, handlerFactory: (deps) => (args) => diff.handler(deps.db, args) },
    { def: trace.toolDef, handlerFactory: (deps) => (args) => trace.handler(deps.db, args) },
    { def: structure.toolDef, handlerFactory: (deps) => (args) => structure.handler(deps.db, args) },
  ];
}

// ─── Embedding helper ─────────────────────────────────────────────────────────

/**
 * Read the embedding model stored in `lore_meta` at index time and create a
 * `LazyEmbeddingProvider` for it.  The model is only downloaded and loaded
 * when the first semantic search is performed.
 *
 * Returns `undefined` when no embedding model is recorded in the database.
 */
async function buildEmbedder(db: Database.Database): Promise<EmbeddingProvider | undefined> {
  const modelName = getLoreMeta(db, 'embedding_model');
  if (!modelName) return undefined;

  return new LazyEmbeddingProvider(modelName);
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(): { dbPath: string } {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  if (dbIdx === -1 || !args[dbIdx + 1]) {
    console.error('Usage: lore-server --db <path>');
    process.exit(1);
  }
  return { dbPath: args[dbIdx + 1]! };
}

// ─── Main (standalone CLI) ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dbPath } = parseArgs();

  const db = openReadOnly(dbPath);
  const embedder = await buildEmbedder(db);

  const server = createLoreMcpServer(db, dbPath, embedder);

  // Connect via stdio transport (standalone/debug mode).
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Signal readiness to the parent process over stderr.
  process.stderr.write('READY\n');
}

// Only run when executed as a standalone script, not when imported as a module.
// Use realpathSync to handle macOS /var → /private/var symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('Lore server fatal error:', err);
    process.exit(1);
  });
}
