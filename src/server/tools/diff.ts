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
  signature: string | null;
}

export interface ChangedEntry {
  name: string;
  kind: string;
  file_path: string;
  old_signature: string | null;
  new_signature: string | null;
}

export interface DiffResult {
  old_branch: string;
  new_branch: string;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: ChangedEntry[];
  summary: {
    added_count: number;
    removed_count: number;
    changed_count: number;
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
    filterClauses.push('AND f.path LIKE ? ESCAPE \'\\\'');
    filterParams.push(prefixPattern);
    changedFilterClauses.push('AND f_new.path LIKE ? ESCAPE \'\\\'');
    changedFilterParams.push(prefixPattern);
  }
  if (args.kind) {
    filterClauses.push('AND s.kind = ?');
    filterParams.push(args.kind);
    changedFilterClauses.push('AND s_new.kind = ?');
    changedFilterParams.push(args.kind);
  }

  const filters = filterClauses.join(' ');
  const changedFilters = changedFilterClauses.join(' ');

  // Added: exported symbols in new_branch not present in old_branch
  const added = db.prepare(
    `SELECT s.name, s.kind, f.path AS file_path, s.signature
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.branch = ?
        AND s.is_exported = 1
        ${filters}
        AND NOT EXISTS (
          SELECT 1
            FROM symbols s2
            JOIN files f2 ON f2.id = s2.file_id
           WHERE f2.branch = ?
             AND s2.name = s.name
             AND s2.kind = s.kind
             AND f2.path = f.path
             AND s2.is_exported = 1
        )
      ORDER BY f.path, s.name
      LIMIT ?`,
  ).all(newBranch, ...filterParams, oldBranch, limit) as DiffEntry[];

  // Removed: exported symbols in old_branch not present in new_branch
  const removed = db.prepare(
    `SELECT s.name, s.kind, f.path AS file_path, s.signature
       FROM symbols s
       JOIN files f ON f.id = s.file_id
      WHERE f.branch = ?
        AND s.is_exported = 1
        ${filters}
        AND NOT EXISTS (
          SELECT 1
            FROM symbols s2
            JOIN files f2 ON f2.id = s2.file_id
           WHERE f2.branch = ?
             AND s2.name = s.name
             AND s2.kind = s.kind
             AND f2.path = f.path
             AND s2.is_exported = 1
        )
      ORDER BY f.path, s.name
      LIMIT ?`,
  ).all(oldBranch, ...filterParams, newBranch, limit) as DiffEntry[];

  // Changed: same name/kind/path but different signature across branches
  const changed = db.prepare(
    `SELECT s_new.name,
            s_new.kind,
            f_new.path AS file_path,
            s_old.signature AS old_signature,
            s_new.signature AS new_signature
       FROM symbols s_new
       JOIN files f_new ON f_new.id = s_new.file_id
       JOIN files f_old ON f_old.path = f_new.path AND f_old.branch = ?
       JOIN symbols s_old ON s_old.file_id = f_old.id
                         AND s_old.name = s_new.name
                         AND s_old.kind = s_new.kind
                         AND s_old.is_exported = 1
      WHERE f_new.branch = ?
        AND s_new.is_exported = 1
        ${changedFilters}
        AND COALESCE(s_new.signature, '') != COALESCE(s_old.signature, '')
      ORDER BY f_new.path, s_new.name
      LIMIT ?`,
  ).all(oldBranch, newBranch, ...changedFilterParams, limit) as ChangedEntry[];

  return {
    old_branch: oldBranch,
    new_branch: newBranch,
    added,
    removed,
    changed,
    summary: {
      added_count: added.length,
      removed_count: removed.length,
      changed_count: changed.length,
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
