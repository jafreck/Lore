/**
 * @module lore-server/tools/cohesion
 *
 * MCP tool: rank directories by module cohesion — the ratio of internal
 * coupling to external coupling.  Uses Robert Martin's instability metric
 * alongside a simple cohesion ratio.
 */

import type { Database } from '../../db/read-only.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_cohesion',
  description:
    'Rank directories by module cohesion — the ratio of internal symbol references to external ones. ' +
    'Use depth to control directory grouping granularity and limit to cap results. ' +
    'Directories are ordered by cohesion ascending (lowest cohesion first).',
  inputSchema: {
    type: 'object',
    properties: {
      depth: {
        type: 'integer',
        minimum: 1,
        description: 'Number of path segments to group directories by (default 2).',
      },
      limit: {
        type: 'number',
        description: 'Max directories to return (default 20, max 200).',
      },
    },
    required: [],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface CohesionArgs {
  depth?: number;
  limit?: number;
}

export interface DirectoryCohesion {
  directory: string;
  file_count: number;
  internal_edges: number;
  external_inbound: number;
  external_outbound: number;
  cohesion: number;
  instability: number;
}

export interface CohesionResult {
  directories: DirectoryCohesion[];
}

/**
 * Truncate a file path to the first `depth` segments.
 * E.g. depth=2 turns "src/server/tools/graph.ts" into "src/server".
 */
function truncateToDepth(filePath: string, depth: number): string {
  const parts = filePath.split('/');
  return parts.slice(0, depth).join('/');
}

/** Rank directories by module cohesion. */
export function handler(db: Database.Database, args: CohesionArgs): CohesionResult {
  const depth = Math.max(1, args.depth ?? 2);
  const limit = Math.min(Math.max(1, args.limit ?? 20), 200);

  // Fetch all resolved edges with their caller/callee file paths.
  const rows = db
    .prepare(
      `SELECT f_caller.path AS caller_path,
              f_callee.path AS callee_path
         FROM symbol_refs sr
         JOIN symbols s_caller ON s_caller.id = sr.caller_id
         JOIN files f_caller   ON f_caller.id = s_caller.file_id
         JOIN symbols s_callee ON s_callee.id = sr.callee_id
         JOIN files f_callee   ON f_callee.id = s_callee.file_id
        WHERE sr.callee_id IS NOT NULL`,
    )
    .all() as Array<{ caller_path: string; callee_path: string }>;

  // Accumulate per-directory counters.
  const dirMap = new Map<
    string,
    { internal: number; inbound: number; outbound: number; files: Set<string> }
  >();

  function getOrCreate(dir: string) {
    let entry = dirMap.get(dir);
    if (!entry) {
      entry = { internal: 0, inbound: 0, outbound: 0, files: new Set() };
      dirMap.set(dir, entry);
    }
    return entry;
  }

  for (const row of rows) {
    const callerDir = truncateToDepth(row.caller_path, depth);
    const calleeDir = truncateToDepth(row.callee_path, depth);

    const callerEntry = getOrCreate(callerDir);
    callerEntry.files.add(row.caller_path);

    const calleeEntry = getOrCreate(calleeDir);
    calleeEntry.files.add(row.callee_path);

    if (callerDir === calleeDir) {
      callerEntry.internal++;
    } else {
      callerEntry.outbound++;
      calleeEntry.inbound++;
    }
  }

  // Build result entries, excluding directories with zero total edges.
  const directories: DirectoryCohesion[] = [];

  for (const [dir, data] of dirMap) {
    const totalEdges = data.internal + data.inbound + data.outbound;
    if (totalEdges === 0) continue;

    const cohesionDenom = data.internal + data.outbound;
    const instabilityDenom = data.inbound + data.outbound;

    directories.push({
      directory: dir,
      file_count: data.files.size,
      internal_edges: data.internal,
      external_inbound: data.inbound,
      external_outbound: data.outbound,
      cohesion: cohesionDenom > 0 ? data.internal / cohesionDenom : 0,
      instability: instabilityDenom > 0 ? data.outbound / instabilityDenom : 0,
    });
  }

  // Sort by cohesion ascending (worst first).
  directories.sort((a, b) => a.cohesion - b.cohesion);

  return { directories: directories.slice(0, limit) };
}
