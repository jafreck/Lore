/**
 * @module lore-server/tools/graph
 *
 * MCP tool: query the call graph and import graph.
 *
 * Both queries return adjacency lists so callers can build their own
 * traversals without additional round-trips.
 */

import type { Database } from '../../db/read-only.js';
import { semanticSearchSymbols } from '../../db/read-only.js';
import type { ResolutionMethod } from '../../resolution/resolution-method.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_graph',
  description:
    'Query call, import, inheritance, or type dependency graph edges stored in the knowledge-base index. ' +
    'Set `kind` to "call", "import", "inheritance", or "type_dependency". ' +
    'Use source_id for outbound edges (what does X call?) and target_id for inbound edges (who calls X?). ' +
    'Automatically follows transitive edges up to 5 hops. ' +
    'The returned edges are authoritative — do NOT re-read source files to verify them. ' +
    'Set compact=true to omit provenance fields (line numbers, resolution details) and reduce token count. ' +
    'Optionally set mode="semantic" with query_vector to retrieve semantically related symbol/module nodes alongside edges.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['call', 'import', 'inheritance', 'type_dependency'],
        description:
          '"call" returns symbol → callee edges; "import" returns file → imported-file edges; ' +
          '"inheritance" returns symbol → base-symbol edges; ' +
          '"type_dependency" returns symbol → referenced-type edges.',
      },
      source_id: {
        type: 'number',
        description:
          'Optional. If provided, only edges whose source matches this id are returned (outbound edges).',
      },
      target_id: {
        type: 'number',
        description:
          'Optional. If provided, only edges whose target matches this id are returned (inbound edges). ' +
          'For kind="call": find all callers of a symbol. For kind="import": find all importers of a file. ' +
          'For kind="inheritance": find all classes that extend/implement a base. ' +
          'For kind="type_dependency": find all symbols that reference a type.',
      },
      compact: {
        type: 'boolean',
        description:
          'If true, omit provenance fields (line, character, resolution_method, definition_path/line/character) ' +
          'from edge records. IDs and names are preserved for follow-up queries. Default false.',
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

type GraphKind = 'call' | 'import' | 'inheritance' | 'type_dependency';

export interface GraphArgs {
  kind: GraphKind;
  source_id?: number;
  target_id?: number;

  compact?: boolean;
  branch?: string;
  mode?: 'structural' | 'semantic';
  query_vector?: number[];
  semantic_limit?: number;
  semantic_max_distance?: number;
}

export interface GraphEdge {
  source_id: number | null;
  source_name: string;
  source_parent_symbol_id?: number | null;
  source_parent_name?: string | null;
  source_file_path?: string | null;
  source_branch: string;
  target_id: number | null;
  target_name: string;
  target_file_path?: string | null;
  ref_kind?: string;
  line?: number;
  character?: number | null;
  resolution_method?: ResolutionMethod;
  definition_path?: string | null;
  definition_line?: number | null;
  definition_character?: number | null;
}

export interface CompactGraphEdge {
  source_id: number | null;
  source_name: string;
  source_parent_symbol_id?: number | null;
  source_parent_name?: string | null;
  source_file_path?: string | null;
  source_branch: string;
  target_id: number | null;
  target_name: string;
  target_file_path?: string | null;
  ref_kind?: string;
}

export interface GraphResult {
  edges: GraphEdge[] | CompactGraphEdge[];
  mode_used: string;
  depth_used?: number;
  truncated?: boolean;
  semantic_nodes?: GraphSemanticNode[];
}

export interface GraphSemanticNode {
  node_type: 'symbol';
  id: number;
  name: string;
  branch: string;
  score: number;
  kind: string;
  file_path?: string;
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
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (args.source_id !== undefined) {
      conditions.push('sr.caller_id = ?');
      params.push(args.source_id);
    }
    if (args.target_id !== undefined) {
      conditions.push('sr.callee_id = ?');
      params.push(args.target_id);
    }
    if (args.branch !== undefined) {
      conditions.push('f_caller.branch = ?');
      params.push(args.branch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const sql =
      `SELECT sr.caller_id  AS source_id,
              s_caller.name AS source_name,
              s_caller.parent_symbol_id AS source_parent_symbol_id,
              sp_caller.name AS source_parent_name,
              f_caller.path AS source_file_path,
              f_caller.branch AS source_branch,
              sr.callee_id  AS target_id,
              sr.callee_name AS target_name,
              sr.definition_path AS target_file_path,
              sr.call_kind  AS call_kind,
              sr.call_line + 1 AS line,
              CASE
                WHEN sr.call_character IS NULL THEN NULL
                ELSE sr.call_character + 1
              END AS character,
              sr.resolution_method AS resolution_method,
              sr.definition_path AS definition_path,
              sr.definition_line AS definition_line,
              sr.definition_character AS definition_character
         FROM symbol_refs sr
         JOIN symbols s_caller ON s_caller.id = sr.caller_id
         JOIN files f_caller ON f_caller.id = s_caller.file_id
         LEFT JOIN symbols sp_caller ON sp_caller.id = s_caller.parent_symbol_id
        ${whereClause}
        LIMIT ?`;

    const edges = db.prepare(sql).all(...params) as GraphEdge[];
    return edges;
  } else if (args.kind === 'import') {
    // File-level: file_imports rows
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (args.source_id !== undefined) {
      conditions.push('fi.file_id = ?');
      params.push(args.source_id);
    }
    if (args.target_id !== undefined) {
      conditions.push('fi.resolved_id = ?');
      params.push(args.target_id);
    }
    if (args.branch !== undefined) {
      conditions.push('f_src.branch = ?');
      params.push(args.branch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const sql =
      `SELECT fi.file_id   AS source_id,
              f_src.path   AS source_name,
              f_src.branch AS source_branch,
              fi.resolved_id AS target_id,
              COALESCE(f_dst.path, fi.raw_import) AS target_name
         FROM file_imports fi
         JOIN files f_src ON f_src.id = fi.file_id
         LEFT JOIN files f_dst ON f_dst.id = fi.resolved_id
        ${whereClause}
        LIMIT ?`;

    const edges = db.prepare(sql).all(...params) as GraphEdge[];

    return edges;
  } else if (args.kind === 'inheritance') {
    // Symbol-level inheritance edges (e.g., class extends, implements)
    const conditions: string[] = ["rel.relationship_type IN ('extends', 'implements')"];
    const params: Array<string | number> = [];

    if (args.source_id !== undefined) {
      conditions.push('rel.source_symbol_id = ?');
      params.push(args.source_id);
    }
    if (args.target_id !== undefined) {
      conditions.push('rel.target_symbol_id = ?');
      params.push(args.target_id);
    }
    if (args.branch !== undefined) {
      conditions.push('f_src.branch = ?');
      params.push(args.branch);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    params.push(limit);

    const sql =
      `SELECT rel.source_symbol_id AS source_id,
              s_src.name AS source_name,
              f_src.path AS source_file_path,
              f_src.branch AS source_branch,
              rel.target_symbol_id AS target_id,
              COALESCE(s_dst.name, rel.target_symbol_name) AS target_name,
              rel.definition_path AS target_file_path,
              rel.line + 1 AS line,
              CASE
                WHEN rel.character IS NULL THEN NULL
                ELSE rel.character + 1
              END AS character,
              rel.resolution_method AS resolution_method,
              rel.definition_path AS definition_path,
              rel.definition_line AS definition_line,
              rel.definition_character AS definition_character
         FROM symbol_relationships rel
         JOIN symbols s_src ON s_src.id = rel.source_symbol_id
         JOIN files f_src ON f_src.id = s_src.file_id
         LEFT JOIN symbols s_dst ON s_dst.id = rel.target_symbol_id
        ${whereClause}
        LIMIT ?`;

    const edges = db.prepare(sql).all(...params) as GraphEdge[];

    return edges;
  } else {
    // type_dependency: symbol → referenced type edges
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (args.source_id !== undefined) {
      conditions.push('tr.symbol_id = ?');
      params.push(args.source_id);
    }
    if (args.target_id !== undefined) {
      conditions.push('tr.type_id = ?');
      params.push(args.target_id);
    }
    if (args.branch !== undefined) {
      conditions.push('f_src.branch = ?');
      params.push(args.branch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const sql =
      `SELECT tr.symbol_id AS source_id,
              COALESCE(s_src.name, '') AS source_name,
              f_src.path AS source_file_path,
              f_src.branch AS source_branch,
              tr.type_id AS target_id,
              COALESCE(s_dst.name, tr.type_name) AS target_name,
              tr.definition_path AS target_file_path,
              tr.ref_kind AS ref_kind,
              tr.ref_line + 1 AS line,
              CASE
                WHEN tr.ref_character IS NULL THEN NULL
                ELSE tr.ref_character + 1
              END AS character,
              tr.resolution_method AS resolution_method,
              tr.definition_path AS definition_path,
              tr.definition_line AS definition_line,
              tr.definition_character AS definition_character
         FROM type_refs tr
         JOIN files f_src ON f_src.id = tr.file_id
         LEFT JOIN symbols s_src ON s_src.id = tr.symbol_id
         LEFT JOIN symbols s_dst ON s_dst.id = tr.type_id
        ${whereClause}
        LIMIT ?`;

    const edges = db.prepare(sql).all(...params) as GraphEdge[];

    return edges;
  }
}

function compactEdge(edge: GraphEdge): CompactGraphEdge {
  const compact: CompactGraphEdge = {
    source_id: edge.source_id,
    source_name: edge.source_name,
    source_branch: edge.source_branch,
    target_id: edge.target_id,
    target_name: edge.target_name,
  };
  if (edge.source_parent_symbol_id != null) compact.source_parent_symbol_id = edge.source_parent_symbol_id;
  if (edge.source_parent_name != null) compact.source_parent_name = edge.source_parent_name;
  if (edge.source_file_path != null) compact.source_file_path = edge.source_file_path;
  if (edge.target_file_path != null) compact.target_file_path = edge.target_file_path;
  if (edge.ref_kind !== undefined) compact.ref_kind = edge.ref_kind;
  return compact;
}

const INTERNAL_LIMIT = 1000;

/** Return adjacency-list edges from the call graph or import graph. */
export function handler(db: Database.Database, args: GraphArgs): GraphResult {
  const limit = INTERNAL_LIMIT;
  const depth = 5;
  const compact = args.compact ?? false;

  // Point-to-point: when both source_id and target_id are provided, query
  // direct edges between the two and return immediately (no multi-hop).
  if (args.source_id !== undefined && args.target_id !== undefined) {
    const edges = getStructuralEdges(db, args, limit);
    return finishResult(db, args, edges, limit, compact, depth);
  }

  // Multi-hop transitive expansion
  const allEdges: GraphEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  // Track frontier IDs for outbound traversal (source_id → target expansion)
  // or inbound traversal (target_id → source expansion)
  const isOutbound = args.source_id !== undefined;

  let frontier: number[];
  if (isOutbound) {
    frontier = [args.source_id!];
  } else if (args.target_id !== undefined) {
    frontier = [args.target_id];
  } else {
    // No anchor → just run one hop with the given limit
    const edges = getStructuralEdges(db, args, limit);
    return finishResult(db, args, edges, limit, compact, depth);
  }

  for (let hop = 0; hop < depth && frontier.length > 0 && allEdges.length < limit; hop++) {
    const hopArgs: GraphArgs = {
      kind: args.kind,
      branch: args.branch,
    };
    // Query each frontier ID
    const hopEdges: GraphEdge[] = [];
    for (const id of frontier) {
      if (isOutbound) {
        hopArgs.source_id = id;
      } else {
        hopArgs.target_id = id;
      }
      const remaining = limit - allEdges.length - hopEdges.length;
      if (remaining <= 0) break;
      const edges = getStructuralEdges(db, hopArgs, remaining);
      hopEdges.push(...edges);
    }

    // Deduplicate edges
    const nextFrontier: number[] = [];
    for (const edge of hopEdges) {
      const key = `${edge.source_id}:${edge.target_id}:${edge.source_name}:${edge.target_name}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      allEdges.push(edge);
      // Expand in the traversal direction
      const nextId = isOutbound ? edge.target_id : edge.source_id;
      if (nextId !== null) {
        nextFrontier.push(nextId);
      }
    }
    frontier = nextFrontier;
  }

  return finishResult(db, args, allEdges, limit, compact, depth);
}

function finishResult(
  db: Database.Database,
  args: GraphArgs,
  edges: GraphEdge[],
  limit: number,
  compact: boolean,
  depth: number,
): GraphResult {
  const mode = args.mode ?? 'structural';
  const finalEdges = compact ? edges.map(compactEdge) : edges;

  if (mode !== 'semantic') {
    return { edges: finalEdges, mode_used: 'structural', depth_used: depth, truncated: edges.length >= limit };
  }

  const queryVector = args.query_vector;
  if (!queryVector || queryVector.length === 0) {
    return {
      edges: finalEdges,
      semantic_nodes: [],
      mode_used: 'structural (fallback: missing query_vector)',
      depth_used: depth,
      truncated: edges.length >= limit,
    };
  }

  if (!hasVirtualTable(db, 'symbol_embeddings')) {
    return {
      edges: finalEdges,
      semantic_nodes: [],
      mode_used: 'structural (fallback: no embeddings)',
      depth_used: depth,
      truncated: edges.length >= limit,
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

  return {
    edges: finalEdges,
    semantic_nodes: symbolNodes,
    mode_used: 'semantic',
    depth_used: depth,
    truncated: edges.length >= limit,
  };
}
