/**
 * @module lore-server/tools/diff
 *
 * MCP tool: compare exported symbols between two indexed branches.
 */

import type { Database } from '../../db/read-only.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_diff',
  description:
    'Compare exported symbols between two indexed branches. ' +
    'Returns added, removed, and changed (signature-different) symbols.',
  inputSchema: {
    type: 'object',
    properties: {
      old_branch: {
        type: 'string',
        description: 'The baseline branch to diff from.',
      },
      new_branch: {
        type: 'string',
        description:
          'The target branch to diff to. Defaults to the most recently indexed branch.',
      },
      path_prefix: {
        type: 'string',
        description: 'Limit results to files whose path starts with this prefix.',
      },
      kind: {
        type: 'string',
        description: 'Limit results to symbols of this kind (e.g. "function", "class").',
      },
      limit: {
        type: 'integer',
        description: 'Max entries per result array (default 50, max 500).',
        minimum: 1,
        maximum: 500,
      },
    },
    required: ['old_branch'],
  },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiffArgs {
  old_branch: string;
  new_branch?: string;
  path_prefix?: string;
  kind?: string;
  limit?: number;
}

export interface DiffEntry {
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  signature: string | null;
}

export interface ChangedEntry {
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  old_signature: string | null;
  new_signature: string | null;
}

export interface DiffSummaryCategory {
  total: number;
  shown: number;
  truncated: boolean;
}

export interface DiffResult {
  old_branch: string;
  new_branch: string;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: ChangedEntry[];
  summary: {
    added: DiffSummaryCategory;
    removed: DiffSummaryCategory;
    changed: DiffSummaryCategory;
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Compare exported symbols between two indexed branches. */
export function handler(db: Database.Database, args: DiffArgs): DiffResult {
  const oldBranch = args.old_branch;
  const newBranch = args.new_branch ?? resolveDefaultBranch(db, oldBranch);
  const limit = Math.min(Math.max(1, args.limit ?? 50), 500);

  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];
  // Separate filter clauses for the changed query which uses different aliases
  const changedFilterClauses: string[] = [];
  const changedFilterParams: unknown[] = [];

  if (args.path_prefix) {
    const prefixPattern = escapeLikePrefix(args.path_prefix);
    filterClauses.push('AND r.path LIKE ? ESCAPE \'\\\'');
    filterParams.push(prefixPattern);
    changedFilterClauses.push('AND r_new.path LIKE ? ESCAPE \'\\\'');
    changedFilterParams.push(prefixPattern);
  }
  if (args.kind) {
    filterClauses.push('AND r.kind = ?');
    filterParams.push(args.kind);
    changedFilterClauses.push('AND r_new.kind = ?');
    changedFilterParams.push(args.kind);
  }

  const filters = filterClauses.join(' ');
  const changedFilters = changedFilterClauses.join(' ');

  // CTE that ranks overloaded symbols by ordinal position within each
  // (name, kind, file) group so that line-shift noise is eliminated.
  const rankedCte = `WITH ranked AS (
    SELECT s.id, s.file_id, s.name, s.kind, s.start_line, s.signature,
           f.path, f.branch,
           ROW_NUMBER() OVER (PARTITION BY s.name, s.kind, s.file_id ORDER BY s.start_line) AS ordinal
    FROM symbols s
    JOIN files f ON f.id = s.file_id
    WHERE s.is_exported = 1
  )`;

  // ── True total counts (before truncation) ─────────────────────────────────

  const totalAdded = (db.prepare(
    `${rankedCte}
     SELECT COUNT(*) AS cnt
       FROM ranked r
      WHERE r.branch = ?
        ${filters}
        AND NOT EXISTS (
          SELECT 1
            FROM ranked r2
           WHERE r2.branch = ?
             AND r2.name = r.name
             AND r2.kind = r.kind
             AND r2.path = r.path
             AND r2.ordinal = r.ordinal
        )`,
  ).get(newBranch, ...filterParams, oldBranch) as { cnt: number }).cnt;

  const totalRemoved = (db.prepare(
    `${rankedCte}
     SELECT COUNT(*) AS cnt
       FROM ranked r
      WHERE r.branch = ?
        ${filters}
        AND NOT EXISTS (
          SELECT 1
            FROM ranked r2
           WHERE r2.branch = ?
             AND r2.name = r.name
             AND r2.kind = r.kind
             AND r2.path = r.path
             AND r2.ordinal = r.ordinal
        )`,
  ).get(oldBranch, ...filterParams, newBranch) as { cnt: number }).cnt;

  const totalChanged = (db.prepare(
    `${rankedCte}
     SELECT COUNT(*) AS cnt
       FROM ranked r_new
       JOIN ranked r_old ON r_old.path = r_new.path
                         AND r_old.branch = ?
                         AND r_old.name = r_new.name
                         AND r_old.kind = r_new.kind
                         AND r_old.ordinal = r_new.ordinal
      WHERE r_new.branch = ?
        ${changedFilters}
        AND COALESCE(r_new.signature, '') != COALESCE(r_old.signature, '')`,
  ).get(oldBranch, newBranch, ...changedFilterParams) as { cnt: number }).cnt;

  // ── Truncated result arrays ───────────────────────────────────────────────

  // Added: exported symbols in new_branch not present in old_branch
  const added = db.prepare(
    `${rankedCte}
     SELECT r.name, r.kind, r.path AS file_path, r.start_line, r.signature
       FROM ranked r
      WHERE r.branch = ?
        ${filters}
        AND NOT EXISTS (
          SELECT 1
            FROM ranked r2
           WHERE r2.branch = ?
             AND r2.name = r.name
             AND r2.kind = r.kind
             AND r2.path = r.path
             AND r2.ordinal = r.ordinal
        )
      ORDER BY r.path, r.name
      LIMIT ?`,
  ).all(newBranch, ...filterParams, oldBranch, limit) as DiffEntry[];

  // Removed: exported symbols in old_branch not present in new_branch
  const removed = db.prepare(
    `${rankedCte}
     SELECT r.name, r.kind, r.path AS file_path, r.start_line, r.signature
       FROM ranked r
      WHERE r.branch = ?
        ${filters}
        AND NOT EXISTS (
          SELECT 1
            FROM ranked r2
           WHERE r2.branch = ?
             AND r2.name = r.name
             AND r2.kind = r.kind
             AND r2.path = r.path
             AND r2.ordinal = r.ordinal
        )
      ORDER BY r.path, r.name
      LIMIT ?`,
  ).all(oldBranch, ...filterParams, newBranch, limit) as DiffEntry[];

  // Changed: same name/kind/path/ordinal but different signature across branches
  const changed = db.prepare(
    `${rankedCte}
     SELECT r_new.name,
            r_new.kind,
            r_new.path AS file_path,
            r_new.start_line,
            r_old.signature AS old_signature,
            r_new.signature AS new_signature
       FROM ranked r_new
       JOIN ranked r_old ON r_old.path = r_new.path
                         AND r_old.branch = ?
                         AND r_old.name = r_new.name
                         AND r_old.kind = r_new.kind
                         AND r_old.ordinal = r_new.ordinal
      WHERE r_new.branch = ?
        ${changedFilters}
        AND COALESCE(r_new.signature, '') != COALESCE(r_old.signature, '')
      ORDER BY r_new.path, r_new.name
      LIMIT ?`,
  ).all(oldBranch, newBranch, ...changedFilterParams, limit) as ChangedEntry[];

  return {
    old_branch: oldBranch,
    new_branch: newBranch,
    added,
    removed,
    changed,
    summary: {
      added: { total: totalAdded, shown: added.length, truncated: added.length < totalAdded },
      removed: { total: totalRemoved, shown: removed.length, truncated: removed.length < totalRemoved },
      changed: { total: totalChanged, shown: changed.length, truncated: changed.length < totalChanged },
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the default new_branch by picking the most recently indexed branch
 * from the files table that is different from old_branch.
 */
function resolveDefaultBranch(db: Database.Database, oldBranch: string): string {
  const row = db.prepare(
    `SELECT branch FROM files
      WHERE branch != ?
      ORDER BY indexed_at DESC
      LIMIT 1`,
  ).get(oldBranch) as { branch: string } | undefined;

  if (!row) {
    throw new Error(
      `Cannot resolve new_branch: no other indexed branch found besides '${oldBranch}'. ` +
      'Please specify new_branch explicitly.',
    );
  }
  return row.branch;
}

/** Escape a path prefix for use with LIKE … ESCAPE '\\'. */
function escapeLikePrefix(prefix: string): string {
  const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  return escaped + '%';
}
