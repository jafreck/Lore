/**
 * @module kb-server/server
 *
 * Knowledge-base MCP server.
 *
 * Exports `createKbMcpServer()` for use by `KbServerProcess` (HTTP transport)
 * and retains a standalone CLI entry point for development/debugging.
 *
 * MCP tools exposed:
 *   kb_lookup    — symbol / file lookup
 *   kb_graph     — call / import graph queries
 *   kb_search    — structural, semantic, and fused search
 *   kb_docs      — indexed documentation list/get/search
 *   kb_test_map  — source-file to mapped-test lookup
 *   kb_snippet   — source-code snippet extraction
 *   kb_blame     — git blame metadata for file lines
 *   kb_metrics   — aggregate code metrics
 *   kb_writeback — LLM summary write-back
 *   kb_history   — git commit history queries
 *
 * Standalone usage:
 *   node dist/kb-server/server.js --db <path-to-kb.db>
 *   tsx src/kb-server/server.ts --db <path-to-kb.db>
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import {
  listCommitAuthorStats,
  listCommitBranchActivity,
  listCommitCadence,
  listCommitChurnByFile,
  listCommitMessagePrefixes,
  listCommitSchedule,
  listCommitSizes,
  openReadOnly,
  type Database,
} from './db.js';
import { getKbMeta } from '../indexer/db.js';
import { SentenceTransformersProvider, type EmbeddingProvider } from '../indexer/embedder.js';
import * as lookup from './tools/lookup.js';
import * as graph from './tools/graph.js';
import * as search from './tools/search.js';
import type { SearchObserver } from './tools/search.js';
import * as docs from './tools/docs.js';
import * as testMap from './tools/test-map.js';
import * as snippet from './tools/snippet.js';
import * as blame from './tools/blame.js';
import * as metrics from './tools/metrics.js';
import * as coverage from './tools/coverage.js';
import * as writeback from './tools/writeback.js';
import * as history from './tools/history.js';

type CommitStatsMetric =
  | 'cadence'
  | 'size'
  | 'churn'
  | 'authors'
  | 'messages'
  | 'schedule'
  | 'branches';

interface CommitStatsArgs {
  metric: CommitStatsMetric;
  limit?: number;
  since?: string;
  until?: string;
  author?: string;
}

function handleCommitStats(db: Database.Database, args: CommitStatsArgs): unknown {
  const filters = {
    limit: args.limit,
    since: args.since,
    until: args.until,
    author: args.author,
  };
  switch (args.metric) {
    case 'cadence':
      return {
        metric: args.metric,
        day: listCommitCadence(db, 'day', filters),
        week: listCommitCadence(db, 'week', filters),
        month: listCommitCadence(db, 'month', filters),
      };
    case 'size':
      return { metric: args.metric, commits: listCommitSizes(db, filters) };
    case 'churn':
      return { metric: args.metric, files: listCommitChurnByFile(db, filters) };
    case 'authors':
      return { metric: args.metric, authors: listCommitAuthorStats(db, filters) };
    case 'messages':
      return { metric: args.metric, prefixes: listCommitMessagePrefixes(db, filters) };
    case 'schedule':
      return { metric: args.metric, buckets: listCommitSchedule(db, filters) };
    case 'branches':
      return { metric: args.metric, refs: listCommitBranchActivity(db, filters) };
  }
}

// ─── Server options ───────────────────────────────────────────────────────────

/** Optional configuration for `createKbMcpServer`. */
export interface KbServerOptions {
  /** Callback invoked after every `kb_search` call with query/mode/latency/result metadata. */
  searchObserver?: SearchObserver;
}

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and return a fully-configured `McpServer` with all KB tools registered.
 *
 * @param db       Read-only SQLite connection to the knowledge-base.
 * @param dbPath   Path to the DB file, needed by `kb_writeback` for write access.
 * @param embedder Optional live embedding provider for semantic/fused search.
 * @param options  Optional server configuration (e.g. search observer).
 */
export function createKbMcpServer(
  db: Database.Database,
  dbPath: string,
  embedder?: EmbeddingProvider,
  options?: KbServerOptions,
): McpServer {
  const server = new McpServer(
    { name: 'lore-kb-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ── kb_lookup ──────────────────────────────────────────────────────────────
  server.tool(
    lookup.toolDef.name,
    lookup.toolDef.description,
    {
      kind: z.enum(['symbol', 'file']).describe('Whether to look up a symbol or a file.'),
      query: z.string().describe('Symbol name or file path to look up (includes persisted enrichment metadata when available).'),
      branch: z.string().optional().describe('Optional branch to filter results.'),
      match_mode: z
        .enum(['exact', 'prefix', 'contains'])
        .optional()
        .describe('For kind="symbol": symbol-name match mode (default "exact").'),
      symbol_kind: z.string().optional().describe('For kind="symbol": optional symbol kind filter.'),
      path_prefix: z.string().optional().describe('For kind="symbol": optional indexed file-path prefix filter.'),
      language: z.string().optional().describe('For kind="symbol": optional indexed file language filter.'),
      limit: z.number().int().nonnegative().optional().describe('For kind="symbol" with empty query: maximum rows to return.'),
      offset: z.number().int().nonnegative().optional().describe('For kind="symbol" with empty query: rows to skip before returning results.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(lookup.handler(db, args)) }],
    }),
  );

  // ── kb_graph ───────────────────────────────────────────────────────────────
  server.tool(
    graph.toolDef.name,
    graph.toolDef.description,
    {
      kind: z
        .enum(['call', 'import', 'module', 'inheritance'])
        .describe('"call", "import", "module", or "inheritance" graph edges.'),
      source_id: z.number().optional().describe('Filter edges by source node id.'),
      limit: z.number().optional().describe('Max edges to return (default 200).'),
      branch: z.string().optional().describe('Optional branch to filter edges.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(graph.handler(db, args)) }],
    }),
  );

  // ── kb_search ──────────────────────────────────────────────────────────────
  server.tool(
    search.toolDef.name,
    search.toolDef.description,
    {
      query: z.string().describe('Search query.'),
      mode: z
        .enum(['structural', 'semantic', 'fused'])
        .optional()
        .describe('Search mode (default: structural).'),
      limit: z.number().optional().describe('Max results (default 20).'),
      branch: z.string().optional().describe('Optional branch to filter results. Query-time retrieval uses SQLite-only persisted data.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(await search.handler(db, args, embedder, options?.searchObserver)) }],
    }),
  );

  // ── kb_docs ────────────────────────────────────────────────────────────────
  server.tool(
    docs.toolDef.name,
    docs.toolDef.description,
    {
      action: z
        .enum(['list', 'get', 'search'])
        .describe('Docs operation mode: list docs, get a doc by path, or search sections.'),
      path: z.string().optional().describe('Optional doc path filter (required for exact get).'),
      query: z.string().optional().describe('Search query text for action="search".'),
      kind: z.string().optional().describe('Optional single doc kind filter.'),
      kinds: z.array(z.string()).optional().describe('Optional doc kind filter list.'),
      include_sections: z
        .boolean()
        .optional()
        .describe('For action="get", include section/chunk rows (default true).'),
      section_index: z.number().int().optional().describe('Optional section index filter.'),
      limit: z.number().optional().describe('Max rows to return (defaults depend on action).'),
      branch: z.string().optional().describe('Optional branch to filter docs.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(docs.handler(db, args)) }],
    }),
  );

  // ── kb_test_map ─────────────────────────────────────────────────────────────
  server.tool(
    testMap.toolDef.name,
    testMap.toolDef.description,
    {
      source_path: z.string().describe('Source file path to resolve mapped test files for.'),
      branch: z.string().optional().describe('Optional branch to constrain mappings.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(testMap.handler(db, args)) }],
    }),
  );

  // ── kb_snippet ─────────────────────────────────────────────────────────────
  server.tool(
    snippet.toolDef.name,
    snippet.toolDef.description,
    {
      path: z.string().describe('Absolute file path as stored in the index.'),
      start_line: z.number().optional().describe('First line (1-based, inclusive).'),
      end_line: z.number().optional().describe('Last line (1-based, inclusive).'),
      branch: z.string().optional().describe('Optional branch to disambiguate the file path.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(snippet.handler(db, args)) }],
    }),
  );

  // ── kb_metrics ─────────────────────────────────────────────────────────────
  server.tool(
    metrics.toolDef.name,
    metrics.toolDef.description,
    {},
    async (_args) => ({
      content: [{ type: 'text', text: JSON.stringify(metrics.handler(db, {})) }],
    }),
  );

  // ── kb_coverage ────────────────────────────────────────────────────────────
  server.tool(
    coverage.toolDef.name,
    coverage.toolDef.description,
    {
      symbol_id: z.number().optional().describe('Optional symbol id to fetch exact coverage for.'),
      symbol_name: z.string().optional().describe('Optional symbol name filter (case-insensitive).'),
      path: z.string().optional().describe('Optional file path filter.'),
      branch: z.string().optional().describe('Optional branch filter.'),
      limit: z.number().optional().describe('Maximum symbols to return (default 50).'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(coverage.handler(db, args)) }],
    }),
  );

  // ── kb_blame ───────────────────────────────────────────────────────────────
  server.tool(
    blame.toolDef.name,
    blame.toolDef.description,
    {
      path: z.string().describe('Absolute file path as stored in the index.'),
      line: z.number().optional().describe('Single line to blame (1-based).'),
      start_line: z.number().optional().describe('Range start line (1-based).'),
      end_line: z.number().optional().describe('Range end line (1-based).'),
      ref: z.string().optional().describe('Git ref to blame against (default HEAD).'),
      branch: z.string().optional().describe('Optional branch to disambiguate indexed file path.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(blame.handler(db, args)) }],
    }),
  );

  // ── kb_writeback ───────────────────────────────────────────────────────────
  server.tool(
    writeback.toolDef.name,
    writeback.toolDef.description,
    {
      symbol_id: z.number().describe('Symbol id to attach the summary to.'),
      summary: z.string().describe('Natural-language summary text.'),
      model: z.string().describe('Model identifier that generated the summary.'),
      branch: z.string().optional().describe('Optional branch to validate the symbol belongs to.'),
    },
    async (args) => ({
      content: [
        { type: 'text', text: JSON.stringify(writeback.handler(dbPath, args)) },
      ],
    }),
  );

  // ── kb_history ─────────────────────────────────────────────────────────────
  server.tool(
    history.toolDef.name,
    history.toolDef.description,
    {
      mode: z
        .enum(['file', 'commit', 'author', 'ref', 'recent'])
        .describe('Query mode: file, commit, author, ref, or recent.'),
      query: z.string().optional().describe('File path, commit SHA, author name/email, or ref.'),
      limit: z.number().optional().describe('Max results (default 20, max 200).'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(history.handler(db, args)) }],
    }),
  );

  // ── kb_commit_stats ────────────────────────────────────────────────────────
  server.tool(
    'kb_commit_stats',
    'Return git commit analytics for a selected metric.',
    {
      metric: z
        .enum(['cadence', 'size', 'churn', 'authors', 'messages', 'schedule', 'branches'])
        .describe('Analytics metric to compute.'),
      limit: z.number().optional().describe('Max rows for top-N metrics (default 20, max 200).'),
      since: z.string().optional().describe('Optional ISO date lower bound (inclusive).'),
      until: z.string().optional().describe('Optional ISO date upper bound (inclusive).'),
      author: z.string().optional().describe('Optional author name/email substring filter.'),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(handleCommitStats(db, args)) }],
    }),
  );

  return server;
}

// ─── Embedding helper ─────────────────────────────────────────────────────────

/**
 * Read the embedding model stored in `kb_meta` at index time and spin up a
 * `SentenceTransformersProvider` instance for it.  Returns `undefined` when no
 * embedding model is recorded in the database.
 */
async function buildEmbedder(db: Database.Database): Promise<EmbeddingProvider | undefined> {
  const modelName = getKbMeta(db, 'embedding_model');
  if (!modelName) return undefined;

  const provider = new SentenceTransformersProvider(modelName);
  try {
    await provider.init();
    return provider;
  } catch {
    // Model not available — fall back to structural search only.
    try { await provider.dispose(); } catch { /* ignore */ }
    return undefined;
  }
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(): { dbPath: string } {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  if (dbIdx === -1 || !args[dbIdx + 1]) {
    console.error('Usage: kb-server --db <path>');
    process.exit(1);
  }
  return { dbPath: args[dbIdx + 1]! };
}

// ─── Main (standalone CLI) ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { dbPath } = parseArgs();

  const db = openReadOnly(dbPath);
  const embedder = await buildEmbedder(db);

  const server = createKbMcpServer(db, dbPath, embedder);

  // Connect via stdio transport (standalone/debug mode).
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Signal readiness to the parent process over stderr.
  process.stderr.write('READY\n');
}

// Only run when executed as a standalone script, not when imported as a module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('KB server fatal error:', err);
    process.exit(1);
  });
}
