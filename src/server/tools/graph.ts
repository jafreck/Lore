/**
 * @module lore-server/tools/graph
 *
 * MCP tool: query the call graph and import graph.
 *
 * Both queries return adjacency lists so callers can build their own
 * traversals without additional round-trips.
 */

import type { Database } from '../../db/read-only.js';
import { getCoveragePercentBySymbolIds, semanticSearchSymbols } from '../../db/read-only.js';
import type { ResolutionMethod } from '../../resolution/resolution-method.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_graph',
  description:
    'Query call, import, module, inheritance, or type dependency graph edges stored in the knowledge-base index. ' +
    'Set `kind` to "call", "import", "module", "inheritance", or "type_dependency". ' +
    'Use source_id for outbound edges (what does X call?) and target_id for inbound edges (who calls X?). ' +
    'Set depth > 1 to follow transitive edges (e.g., depth=3 returns the full 3-hop blast radius in one call). ' +
    'Set compact=true to omit provenance fields (line numbers, resolution details) and reduce token count. ' +
    'Optionally set mode="semantic" with query_vector to retrieve semantically related symbol/module nodes alongside edges.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['call', 'import', 'module', 'inheritance', 'type_dependency'],
        description:
          '"call" returns symbol → callee edges; "import" returns file → imported-file edges; ' +
          '"module" returns module → imported-module edges; "inheritance" returns symbol → base-symbol edges; ' +
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
      limit: {
        type: 'number',
        description: 'Maximum number of edges to return (default 200).',
      },
      depth: {
        type: 'number',
        description:
          'Traversal depth for transitive closure (default 1, max 5). ' +
          'depth=1 returns direct edges only. depth=N follows edges N hops deep, returning all discovered edges.',
        minimum: 1,
        maximum: 5,
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

type GraphKind = 'call' | 'import' | 'module' | 'inheritance' | 'type_dependency';

export interface GraphArgs {
  kind: GraphKind;
  source_id?: number;
  target_id?: number;
  limit?: number;
  depth?: number;
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
  source_branch: string;
  target_id: number | null;
  target_name: string;
  callee_coverage_percent?: number | null;
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
  source_branch: string;
  target_id: number | null;
  target_name: string;
  callee_coverage_percent?: number | null;
  ref_kind?: string;
}

export interface GraphResult {
  edges: GraphEdge[] | CompactGraphEdge[];
  mode_used: string;
  depth_used?: number;
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
              f_caller.branch AS source_branch,
              sr.callee_id  AS target_id,
              sr.callee_name AS target_name,
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
        ${whereClause}
        LIMIT ?`;

    const edges = db.prepare(sql).all(...params) as GraphEdge[];
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
  } else if (args.kind === 'module') {
    // Module-level: inferred from file_imports + file_modules.
    // NOTE: No writer populates `modules`/`file_modules` — this query returns
    // empty results until a module-detection writer is implemented.
    // The INNER JOIN on file_modules ensures graceful empty results.
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (args.source_id !== undefined) {
      conditions.push('m_src.id = ?');
      params.push(args.source_id);
    }
    if (args.target_id !== undefined) {
      conditions.push('m_dst.id = ?');
      params.push(args.target_id);
    }
    if (args.branch !== undefined) {
      conditions.push('f_src.branch = ?');
      params.push(args.branch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const sql =
      `SELECT DISTINCT
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
              f_src.branch AS source_branch,
              rel.target_symbol_id AS target_id,
              COALESCE(s_dst.name, rel.target_symbol_name) AS target_name,
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
              f_src.branch AS source_branch,
              tr.type_id AS target_id,
              COALESCE(s_dst.name, tr.type_name) AS target_name,
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

function compactEdge(edge: GraphEdge): CompactGraphEdge {
  const compact: CompactGraphEdge = {
    source_id: edge.source_id,
    source_name: edge.source_name,
    source_branch: edge.source_branch,
    target_id: edge.target_id,
    target_name: edge.target_name,
  };
  if (edge.callee_coverage_percent !== undefined) compact.callee_coverage_percent = edge.callee_coverage_percent;
  if (edge.ref_kind !== undefined) compact.ref_kind = edge.ref_kind;
  return compact;
}

/** Return adjacency-list edges from the call graph or import graph. */
export function handler(db: Database.Database, args: GraphArgs): GraphResult {
  const limit = args.limit ?? 200;
  const depth = Math.max(1, Math.min(args.depth ?? 1, 5));
  const compact = args.compact ?? false;

  // Depth-1 fast path (original behaviour)
  if (depth === 1) {
    const edges = getStructuralEdges(db, args, limit);
    return finishResult(db, args, edges, limit, compact, depth);
  }

  // Multi-hop transitive expansion
  const allEdges: GraphEdge[] = [];
  const seenEdgeKeys = new Set<string>();
  // Track frontier IDs for outbound traversal (source_id → target expansion)
  // or inbound traversal (target_id → source expansion)
  const isOutbound = args.source_id !== undefined && args.target_id === undefined;

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
    return { edges: finalEdges, mode_used: 'structural', depth_used: depth };
  }

  const queryVector = args.query_vector;
  if (!queryVector || queryVector.length === 0) {
    return {
      edges: finalEdges,
      semantic_nodes: [],
      mode_used: 'structural (fallback: missing query_vector)',
      depth_used: depth,
    };
  }

  if (!hasVirtualTable(db, 'symbol_embeddings')) {
    return {
      edges: finalEdges,
      semantic_nodes: [],
      mode_used: 'structural (fallback: no embeddings)',
      depth_used: depth,
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
    edges: finalEdges,
    semantic_nodes: [...symbolNodes, ...moduleNodes],
    mode_used: 'semantic',
    depth_used: depth,
  };
}
