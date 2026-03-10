/**
 * @module lore-server/tools/graph-analysis
 *
 * MCP tool: run graph analysis primitives (symbol cycles, connected
 * components, symbol clustering, codebase summary).
 */

import type { Database } from '../db.js';
import {
  detectSymbolCycles,
  findConnectedComponents,
  clusterSymbols,
  buildCodebaseSummary,
} from '../../indexer/graph-analysis.js';
import type {
  EdgeKind,
  SymbolCluster,
  CodebaseSummary,
} from '../../indexer/graph-analysis.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_analyze',
  description:
    'Run graph analysis on the knowledge-base. Supports four modes: ' +
    '"cycles" (symbol-level strongly connected components / mutual recursion), ' +
    '"components" (connected components at file or symbol level), ' +
    '"clusters" (partition symbol graph into bounded-size coherent chunks), ' +
    '"summary" (condensed codebase dependency overview with modules, SCCs, and components).',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['cycles', 'components', 'clusters', 'summary'],
        description:
          'Analysis mode. "cycles": symbol-level SCC detection; "components": connected components; ' +
          '"clusters": bounded-size symbol clustering; "summary": full codebase summary.',
      },
      edge_kinds: {
        type: 'string',
        enum: ['call', 'type', 'both'],
        description: 'Which edge types to traverse. Default: "both".',
      },
      scope: {
        type: 'string',
        enum: ['file', 'symbol'],
        description: 'Scope for components mode. Default: "symbol".',
      },
      branch: {
        type: 'string',
        description: 'Optional branch filter.',
      },
      max_lines: {
        type: 'number',
        description: 'Maximum lines per cluster/module (for clusters and summary modes). Default: 500.',
        minimum: 1,
      },
    },
    required: ['mode'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface AnalyzeArgs {
  mode: 'cycles' | 'components' | 'clusters' | 'summary';
  edge_kinds?: EdgeKind;
  scope?: 'file' | 'symbol';
  branch?: string;
  max_lines?: number;
}

export type AnalyzeResult =
  | { mode: 'cycles'; sccs: number[][] }
  | { mode: 'components'; components: number[][] }
  | { mode: 'clusters'; clusters: SymbolCluster[] }
  | { mode: 'summary'; summary: CodebaseSummary };

export function handler(db: Database.Database, args: AnalyzeArgs): AnalyzeResult {
  const opts = {
    edgeKinds: args.edge_kinds ?? 'both' as EdgeKind,
    branch: args.branch,
  };

  switch (args.mode) {
    case 'cycles':
      return { mode: 'cycles', sccs: detectSymbolCycles(db, opts) };

    case 'components':
      return {
        mode: 'components',
        components: findConnectedComponents(db, {
          ...opts,
          scope: args.scope ?? 'symbol',
        }),
      };

    case 'clusters':
      return {
        mode: 'clusters',
        clusters: clusterSymbols(db, {
          ...opts,
          maxLinesPerCluster: args.max_lines,
        }),
      };

    case 'summary':
      return {
        mode: 'summary',
        summary: buildCodebaseSummary(db, {
          ...opts,
          maxLinesPerModule: args.max_lines,
        }),
      };
  }
}
