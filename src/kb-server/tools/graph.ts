/**
 * @module kb-server/tools/graph
 *
 * MCP tool: query the call graph and import graph.
 *
 * Both queries return adjacency lists so callers can build their own
 * traversals without additional round-trips.
 */

import type { Database } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'kb_graph',
  description:
    'Query the call graph or import graph stored in the knowledge-base index. ' +
    'Set `kind` to "call" for symbol-level call edges or "import" for file-level import edges. ' +
    'Optionally filter by a source node id.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['call', 'import'],
        description: '"call" returns symbol → callee edges; "import" returns file → imported-file edges.',
      },
      source_id: {
        type: 'number',
        description:
          'Optional. If provided, only edges whose source matches this id are returned.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of edges to return (default 200).',
      },
    },
    required: ['kind'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface GraphArgs {
  kind: 'call' | 'import';
  source_id?: number;
  limit?: number;
  branch?: string;
}

export interface GraphEdge {
  source_id: number;
  source_name: string;
  source_branch: string;
  target_id: number | null;
  target_name: string;
}

export interface GraphResult {
  edges: GraphEdge[];
}

/** Return adjacency-list edges from the call graph or import graph. */
export function handler(db: Database.Database, args: GraphArgs): GraphResult {
  const limit = args.limit ?? 200;

  if (args.kind === 'call') {
    // Symbol-level: symbol_refs rows
    const hasFilter = args.source_id !== undefined;
    const branchClause = args.branch !== undefined ? ' AND f_caller.branch = ?' : '';
    const sql = hasFilter
      ? `SELECT sr.caller_id  AS source_id,
                s_caller.name AS source_name,
                f_caller.branch AS source_branch,
                sr.callee_id  AS target_id,
                sr.callee_name AS target_name
           FROM symbol_refs sr
           JOIN symbols s_caller ON s_caller.id = sr.caller_id
           JOIN files f_caller ON f_caller.id = s_caller.file_id
          WHERE sr.caller_id = ?${branchClause}
          LIMIT ?`
      : `SELECT sr.caller_id  AS source_id,
                s_caller.name AS source_name,
                f_caller.branch AS source_branch,
                sr.callee_id  AS target_id,
                sr.callee_name AS target_name
           FROM symbol_refs sr
           JOIN symbols s_caller ON s_caller.id = sr.caller_id
           JOIN files f_caller ON f_caller.id = s_caller.file_id
          WHERE 1=1${branchClause}
          LIMIT ?`;

    const edgeParams = hasFilter
      ? (args.branch !== undefined ? [args.source_id, args.branch, limit] : [args.source_id, limit])
      : (args.branch !== undefined ? [args.branch, limit] : [limit]);
    const edges = db.prepare(sql).all(...edgeParams) as GraphEdge[];

    return { edges };
  } else {
    // File-level: file_imports rows
    const hasFilter = args.source_id !== undefined;
    const branchClause = args.branch !== undefined ? ' AND f_src.branch = ?' : '';
    const sql = hasFilter
      ? `SELECT fi.file_id   AS source_id,
                f_src.path   AS source_name,
                f_src.branch AS source_branch,
                fi.resolved_id AS target_id,
                COALESCE(f_dst.path, fi.raw_import) AS target_name
           FROM file_imports fi
           JOIN files f_src ON f_src.id = fi.file_id
           LEFT JOIN files f_dst ON f_dst.id = fi.resolved_id
          WHERE fi.file_id = ?${branchClause}
          LIMIT ?`
      : `SELECT fi.file_id   AS source_id,
                f_src.path   AS source_name,
                f_src.branch AS source_branch,
                fi.resolved_id AS target_id,
                COALESCE(f_dst.path, fi.raw_import) AS target_name
           FROM file_imports fi
           JOIN files f_src ON f_src.id = fi.file_id
           LEFT JOIN files f_dst ON f_dst.id = fi.resolved_id
          WHERE 1=1${branchClause}
          LIMIT ?`;

    const edgeParams = hasFilter
      ? (args.branch !== undefined ? [args.source_id, args.branch, limit] : [args.source_id, limit])
      : (args.branch !== undefined ? [args.branch, limit] : [limit]);
    const edges = db.prepare(sql).all(...edgeParams) as GraphEdge[];

    return { edges };
  }
}
