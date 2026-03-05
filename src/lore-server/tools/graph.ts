/**
 * @module lore-server/tools/graph
 *
 * MCP tool: query the call graph and import graph.
 *
 * Both queries return adjacency lists so callers can build their own
 * traversals without additional round-trips.
 */

import type { Database } from '../db.js';
import { getCoveragePercentBySymbolIds, semanticSearchSymbols } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_graph',
  description:
    'Query call, import, module, or inheritance graph edges stored in the knowledge-base index. ' +
    'Set `kind` to "call", "import", "module", or "inheritance". ' +
    'Optionally set mode="semantic" with query_vector to retrieve semantically related symbol/module nodes alongside edges.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['call', 'import', 'module', 'inheritance'],
        description:
          '"call" returns symbol → callee edges; "import" returns file → imported-file edges; ' +
          '"module" returns module → imported-module edges; "inheritance" returns symbol → base-symbol edges.',
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
      branch: {
        type: 'string',
        description: 'Optional branch name to filter edges by source branch.',
      },
      mode: {
        type: 'string',
        enum: ['structural', 'semantic'],
        description: 'Query mode. "structural" (default) returns edges only; "semantic" also returns related nodes.',
      },
      query_vector: {
        type: 'array',
        items: { type: 'number' },
        description: 'Embedding vector used by semantic mode to find related nodes.',
      },
      semantic_limit: {
        type: 'number',
        description: 'Maximum semantic related nodes to evaluate (default min(limit, 20)).',
      },
      semantic_max_distance: {
        type: 'number',
        description: 'Optional maximum embedding distance threshold for semantic matches.',
      },
    },
    required: ['kind'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

type GraphKind = 'call' | 'import' | 'module' | 'inheritance';

export interface GraphArgs {
  kind: GraphKind;
  source_id?: number;
  limit?: number;
  branch?: string;
  mode?: 'structural' | 'semantic';
  query_vector?: number[];
  semantic_limit?: number;
  semantic_max_distance?: number;
}

export interface GraphEdge {
  source_id: number;
  source_name: string;
  source_branch: string;
  target_id: number | null;
  target_name: string;
  callee_coverage_percent?: number | null;
}

export interface GraphResult {
  edges: GraphEdge[];
  mode_used: string;
  semantic_nodes?: GraphSemanticNode[];
}

export interface GraphSemanticNode {
  node_type: 'symbol' | 'module';
  id: number;
  name: string;
  branch: string;
  score: number;
  kind: string;
  file_path?: string;
}

interface ModuleMappingRow {
  symbol_id: number;
  module_id: number;
  module_name: string;
  module_kind: string;
  source_branch: string;
}

function hasVirtualTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ? LIMIT 1",
    )
    .get(name) as { present: number } | undefined;
  return row?.present === 1;
}

function getStructuralEdges(
  db: Database.Database,
  args: GraphArgs,
  limit: number,
): GraphEdge[] {
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
    const calleeIds = Array.from(
      new Set(edges.map((edge) => edge.target_id).filter((id): id is number => id !== null)),
    );
    const coverageBySymbolId = getCoveragePercentBySymbolIds(db, calleeIds, args.branch);
    const edgesWithCoverage = edges.map((edge) => ({
      ...edge,
      callee_coverage_percent:
        edge.target_id !== null ? (coverageBySymbolId.get(edge.target_id) ?? null) : null,
    }));

    return edgesWithCoverage;
  } else if (args.kind === 'import') {
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

    return edges;
  } else if (args.kind === 'module') {
    // Module-level: inferred from file_imports + file_modules
    const hasFilter = args.source_id !== undefined;
    const branchClause = args.branch !== undefined ? ' AND f_src.branch = ?' : '';
    const sql = hasFilter
      ? `SELECT DISTINCT
                 m_src.id AS source_id,
                 m_src.name AS source_name,
                 f_src.branch AS source_branch,
                 m_dst.id AS target_id,
                 COALESCE(m_dst.name, fi.raw_import) AS target_name
            FROM file_imports fi
            JOIN files f_src ON f_src.id = fi.file_id
            JOIN file_modules fm_src ON fm_src.file_id = f_src.id
            JOIN modules m_src ON m_src.id = fm_src.module_id
            LEFT JOIN files f_dst ON f_dst.id = fi.resolved_id
            LEFT JOIN file_modules fm_dst ON fm_dst.file_id = f_dst.id
            LEFT JOIN modules m_dst ON m_dst.id = fm_dst.module_id
           WHERE m_src.id = ?${branchClause}
           LIMIT ?`
      : `SELECT DISTINCT
                 m_src.id AS source_id,
                 m_src.name AS source_name,
                 f_src.branch AS source_branch,
                 m_dst.id AS target_id,
                 COALESCE(m_dst.name, fi.raw_import) AS target_name
            FROM file_imports fi
            JOIN files f_src ON f_src.id = fi.file_id
            JOIN file_modules fm_src ON fm_src.file_id = f_src.id
            JOIN modules m_src ON m_src.id = fm_src.module_id
            LEFT JOIN files f_dst ON f_dst.id = fi.resolved_id
            LEFT JOIN file_modules fm_dst ON fm_dst.file_id = f_dst.id
            LEFT JOIN modules m_dst ON m_dst.id = fm_dst.module_id
           WHERE 1=1${branchClause}
           LIMIT ?`;

    const edgeParams = hasFilter
      ? (args.branch !== undefined ? [args.source_id, args.branch, limit] : [args.source_id, limit])
      : (args.branch !== undefined ? [args.branch, limit] : [limit]);
    const edges = db.prepare(sql).all(...edgeParams) as GraphEdge[];

    return edges;
  } else {
    // Symbol-level inheritance edges (e.g., class extends)
    const hasFilter = args.source_id !== undefined;
    const branchClause = args.branch !== undefined ? ' AND f_src.branch = ?' : '';
    const sql = hasFilter
      ? `SELECT rel.source_symbol_id AS source_id,
                s_src.name AS source_name,
                f_src.branch AS source_branch,
                rel.target_symbol_id AS target_id,
                COALESCE(s_dst.name, rel.target_symbol_name) AS target_name
           FROM symbol_relationships rel
           JOIN symbols s_src ON s_src.id = rel.source_symbol_id
           JOIN files f_src ON f_src.id = s_src.file_id
           LEFT JOIN symbols s_dst ON s_dst.id = rel.target_symbol_id
          WHERE rel.relationship_type = 'extends'
            AND rel.source_symbol_id = ?${branchClause}
          LIMIT ?`
      : `SELECT rel.source_symbol_id AS source_id,
                s_src.name AS source_name,
                f_src.branch AS source_branch,
                rel.target_symbol_id AS target_id,
                COALESCE(s_dst.name, rel.target_symbol_name) AS target_name
           FROM symbol_relationships rel
           JOIN symbols s_src ON s_src.id = rel.source_symbol_id
           JOIN files f_src ON f_src.id = s_src.file_id
           LEFT JOIN symbols s_dst ON s_dst.id = rel.target_symbol_id
          WHERE rel.relationship_type = 'extends'${branchClause}
          LIMIT ?`;

    const edgeParams = hasFilter
      ? (args.branch !== undefined ? [args.source_id, args.branch, limit] : [args.source_id, limit])
      : (args.branch !== undefined ? [args.branch, limit] : [limit]);
    const edges = db.prepare(sql).all(...edgeParams) as GraphEdge[];

    return edges;
  }
}

function getSemanticModuleMappings(
  db: Database.Database,
  symbolIds: number[],
): ModuleMappingRow[] {
  if (symbolIds.length === 0) {
    return [];
  }

  const placeholders = symbolIds.map(() => '?').join(', ');
  return db.prepare(
    `SELECT s.id AS symbol_id,
            m.id AS module_id,
            m.name AS module_name,
            m.kind AS module_kind,
            f.branch AS source_branch
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN file_modules fm ON fm.file_id = f.id
       JOIN modules m ON m.id = fm.module_id
      WHERE s.id IN (${placeholders})`,
  ).all(...symbolIds) as ModuleMappingRow[];
}

/** Return adjacency-list edges from the call graph or import graph. */
export function handler(db: Database.Database, args: GraphArgs): GraphResult {
  const limit = args.limit ?? 200;
  const edges = getStructuralEdges(db, args, limit);
  const mode = args.mode ?? 'structural';

  if (mode !== 'semantic') {
    return { edges, mode_used: 'structural' };
  }

  const queryVector = args.query_vector;
  if (!queryVector || queryVector.length === 0) {
    return {
      edges,
      semantic_nodes: [],
      mode_used: 'structural (fallback: missing query_vector)',
    };
  }

  if (!hasVirtualTable(db, 'symbol_embeddings')) {
    return {
      edges,
      semantic_nodes: [],
      mode_used: 'structural (fallback: no embeddings)',
    };
  }

  const semanticLimit = Math.max(1, Math.floor(args.semantic_limit ?? Math.min(limit, 20)));
  const maxDistance = args.semantic_max_distance;
  const symbolRows = semanticSearchSymbols(db, {
    queryVector,
    branch: args.branch,
    limit: semanticLimit,
  });
  const filteredSymbols = maxDistance === undefined
    ? symbolRows
    : symbolRows.filter((row) => row.score <= maxDistance);

  const symbolNodes: GraphSemanticNode[] = filteredSymbols.map((row) => ({
    node_type: 'symbol',
    id: row.id,
    name: row.name,
    branch: row.file_branch,
    score: row.score,
    kind: row.kind,
    file_path: row.file_path,
  }));

  const scoreBySymbolId = new Map(filteredSymbols.map((row) => [row.id, row.score]));
  const moduleNodesByKey = new Map<string, GraphSemanticNode>();
  const moduleMappings = getSemanticModuleMappings(db, Array.from(scoreBySymbolId.keys()));
  for (const mapping of moduleMappings) {
    const symbolScore = scoreBySymbolId.get(mapping.symbol_id);
    if (symbolScore === undefined) {
      continue;
    }
    const moduleKey = `${mapping.module_id}:${mapping.source_branch}`;
    const existing = moduleNodesByKey.get(moduleKey);
    if (!existing || symbolScore < existing.score) {
      moduleNodesByKey.set(moduleKey, {
        node_type: 'module',
        id: mapping.module_id,
        name: mapping.module_name,
        branch: mapping.source_branch,
        score: symbolScore,
        kind: mapping.module_kind,
      });
    }
  }

  const moduleNodes = Array.from(moduleNodesByKey.values()).sort((a, b) =>
    a.score - b.score
    || a.branch.localeCompare(b.branch)
    || a.name.localeCompare(b.name)
    || a.id - b.id);

  return {
    edges,
    semantic_nodes: [...symbolNodes, ...moduleNodes],
    mode_used: 'semantic',
  };
}
