/**
 * @module benchmark/tool-providers
 *
 * Builds tool sets for each benchmark arm:
 * - Control:          file read, grep, directory listing
 * - Semantic baseline: control + generic embedding search
 * - Lore-enabled:     control + all Lore MCP tools
 *
 * Stub Lore tools are injected into control/semantic arms so the agent
 * sees the same tool names across all arms (equalized prompting).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openReadOnly } from '../../../src/db/read-only.js';
import type { EmbeddingProvider } from '../../../src/embeddings/embedder.js';
import type { AgentTool } from './types.js';
import type { BenchmarkArm } from './types.js';

// ─── Lore tool names (for stub generation) ────────────────────────────────────

const LORE_TOOL_NAMES = [
  'lore_lookup',
  'lore_search',
  'lore_graph',
  'lore_docs',
  'lore_routes',
  'lore_test_map',
  'lore_snippet',
  'lore_blame',
  'lore_metrics',
  'lore_history',
] as const;

// ─── Base tools (available in all arms) ───────────────────────────────────────

function buildBaseTools(repoPath: string): AgentTool[] {
  return [
    {
      name: 'read_file',
      description: 'Read the contents of a file at the given path (relative to repo root).',
      execute: async (args) => {
        const filePath = String(args['path'] ?? '');
        const absPath = join(repoPath, filePath);
        // Prevent path traversal
        if (!absPath.startsWith(repoPath)) {
          return 'Error: path traversal not allowed';
        }
        try {
          return readFileSync(absPath, 'utf-8');
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
    {
      name: 'grep_search',
      description:
        'Search for a regex pattern across files in the repo. Returns matching lines with file paths and line numbers.',
      execute: async (args) => {
        const pattern = String(args['pattern'] ?? '');
        const includeGlob = args['include'] ? String(args['include']) : undefined;
        try {
          const grepArgs = ['-rn', '--include', includeGlob ?? '*', '-E', pattern, '.'];
          const result = execFileSync('grep', grepArgs, {
            cwd: repoPath,
            maxBuffer: 1024 * 1024,
            timeout: 30_000,
            encoding: 'utf-8',
          });
          // Limit output
          const lines = result.split('\n');
          if (lines.length > 200) {
            return lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more lines)`;
          }
          return result;
        } catch (e: any) {
          if (e.status === 1) return '(no matches)';
          return `Error: ${e.message}`;
        }
      },
    },
    {
      name: 'list_directory',
      description: 'List the contents of a directory (relative to repo root). Returns file and directory names.',
      execute: async (args) => {
        const dirPath = String(args['path'] ?? '.');
        const absPath = join(repoPath, dirPath);
        if (!absPath.startsWith(repoPath)) {
          return 'Error: path traversal not allowed';
        }
        try {
          const entries = readdirSync(absPath, { withFileTypes: true });
          return entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join('\n');
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
    {
      name: 'file_info',
      description: 'Get metadata about a file (size, type).',
      execute: async (args) => {
        const filePath = String(args['path'] ?? '');
        const absPath = join(repoPath, filePath);
        if (!absPath.startsWith(repoPath)) {
          return 'Error: path traversal not allowed';
        }
        try {
          const stat = statSync(absPath);
          return JSON.stringify({
            path: filePath,
            size: stat.size,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            modified: stat.mtime.toISOString(),
          });
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
  ];
}

// ─── Stub Lore tools ──────────────────────────────────────────────────────────

function buildStubLoreTools(): AgentTool[] {
  return LORE_TOOL_NAMES.map((name) => ({
    name,
    description: `(Lore knowledge-base tool) ${name} — structured code intelligence query.`,
    execute: async () => 'not available in this configuration',
  }));
}

// ─── Real Lore tools (backed by DB) ──────────────────────────────────────────

/**
 * Wrap a single tool module into an AgentTool.
 */
function wrapTool(
  name: string,
  description: string,
  handlerFn: (args: Record<string, unknown>) => unknown | Promise<unknown>,
): AgentTool {
  return {
    name,
    description,
    execute: async (args) => {
      try {
        const result = await handlerFn(args);
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  };
}

/**
 * Build real Lore MCP tool wrappers backed by an actual Lore DB.
 * Each tool directly calls the handler from the tool module.
 */
async function buildLoreTools(dbPath: string, embedder?: EmbeddingProvider): Promise<AgentTool[]> {
  const db = openReadOnly(dbPath);

  // Import each tool module individually to preserve type information
  const [
    lookup, search, graph, docs, routes,
    testMap, snippet, blame, metrics,
    history,
  ] = await Promise.all([
    import('../../../src/server/tools/lookup.js'),
    import('../../../src/server/tools/search.js'),
    import('../../../src/server/tools/graph.js'),
    import('../../../src/server/tools/docs.js'),
    import('../../../src/server/tools/routes.js'),
    import('../../../src/server/tools/test-map.js'),
    import('../../../src/server/tools/snippet.js'),
    import('../../../src/server/tools/blame.js'),
    import('../../../src/server/tools/metrics.js'),
    import('../../../src/server/tools/history.js'),
  ]);

  return [
    wrapTool(lookup.toolDef.name, lookup.toolDef.description, (args) => lookup.handler(db, args as any, embedder)),
    wrapTool(search.toolDef.name, search.toolDef.description, (args) => search.handler(db, args as any, embedder)),
    wrapTool(graph.toolDef.name, graph.toolDef.description, (args) => graph.handler(db, args as any)),
    wrapTool(docs.toolDef.name, docs.toolDef.description, (args) => docs.handler(db, args as any)),
    wrapTool(routes.toolDef.name, routes.toolDef.description, (args) => routes.handler(db, args as any)),
    wrapTool(testMap.toolDef.name, testMap.toolDef.description, (args) => testMap.handler(db, args as any)),
    wrapTool(snippet.toolDef.name, snippet.toolDef.description, (args) => snippet.handler(db, args as any)),
    wrapTool(blame.toolDef.name, blame.toolDef.description, (args) => blame.handler(db, args as any)),
    wrapTool(metrics.toolDef.name, metrics.toolDef.description, (args) => metrics.handler(db, args as any)),
    wrapTool(history.toolDef.name, history.toolDef.description, (args) => history.handler(db, args as any)),
  ];
}

// ─── Semantic baseline search tool ────────────────────────────────────────────

/**
 * A simple embedding search tool that acts as the "semantic baseline" arm.
 * Uses Lore's search in semantic-only mode to provide fair comparison.
 */
async function buildSemanticSearchTool(dbPath: string, embedder?: EmbeddingProvider): Promise<AgentTool> {
  const db = openReadOnly(dbPath);
  const searchMod = await import('../../../src/server/tools/search.js');

  return {
    name: 'semantic_search',
    description:
      'Search the codebase using semantic similarity. Returns the most relevant code snippets for a natural language query.',
    execute: async (args) => {
      try {
        const result = await searchMod.handler(db, {
          query: String(args['query'] ?? ''),
          mode: 'semantic' as const,
          limit: Number(args['limit'] ?? 20),
        }, embedder);
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Build the complete tool set for a benchmark arm.
 */
export async function buildToolsForArm(
  arm: BenchmarkArm,
  repoPath: string,
  dbPath?: string,
  embedder?: EmbeddingProvider,
): Promise<AgentTool[]> {
  const baseTools = buildBaseTools(repoPath);

  switch (arm) {
    case 'control':
      return [...baseTools, ...buildStubLoreTools()];

    case 'semantic-baseline': {
      if (!dbPath) throw new Error('semantic-baseline arm requires a Lore DB for embedding search');
      const semanticTool = await buildSemanticSearchTool(dbPath, embedder);
      return [...baseTools, semanticTool, ...buildStubLoreTools()];
    }

    case 'lore-enabled': {
      if (!dbPath) throw new Error('lore-enabled arm requires a Lore DB');
      const loreTools = await buildLoreTools(dbPath, embedder);
      return [...baseTools, ...loreTools];
    }

    default:
      throw new Error(`Unknown arm: ${arm}`);
  }
}
