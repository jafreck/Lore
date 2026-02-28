/**
 * @module kb-server/db
 *
 * Read-only SQLite connection wrapper for the KB MCP server.
 * All MCP tool files use `openReadOnly()` to open the knowledge-base database.
 */

import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);

// Re-export the Database type so callers don't need to import better-sqlite3 directly.
export type { Database };

// ─── Connection helpers ───────────────────────────────────────────────────────

/**
 * Opens the knowledge-base database at `path` in read-only mode.
 * Foreign-key enforcement is enabled for consistency.
 */
export function openReadOnly(path: string): Database.Database {
  const db = new Database(path, { readonly: true });
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension so vec0 virtual tables (symbol_embeddings) can
  // be queried for semantic / fused search.
  try {
    const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
    sqliteVec.load(db);
  } catch {
    // sqlite-vec not available — vec0 tables won't be queryable.
  }

  return db;
}

// ─── Symbol helpers ───────────────────────────────────────────────────────────

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
  doc_comment: string | null;
}

/** Fetch a single symbol by primary key.  Returns `undefined` if not found. */
export function getSymbolById(db: Database.Database, id: number): SymbolRow | undefined {
  return db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
}

/** Fetch all symbols whose name matches the given string (case-insensitive). */
export function getSymbolsByName(db: Database.Database, name: string, branch?: string): SymbolRow[] {
  if (branch !== undefined) {
    return db
      .prepare(
        'SELECT s.* FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? COLLATE NOCASE AND f.branch = ?'
      )
      .all(name, branch) as SymbolRow[];
  }
  return db
    .prepare('SELECT * FROM symbols WHERE name = ? COLLATE NOCASE')
    .all(name) as SymbolRow[];
}

/** Return all symbols, optionally limited to `limit` rows. */
export function listSymbols(db: Database.Database, limit = 100, branch?: string): SymbolRow[] {
  if (branch !== undefined) {
    return db
      .prepare(
        'SELECT s.* FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.branch = ? LIMIT ?'
      )
      .all(branch, limit) as SymbolRow[];
  }
  return db.prepare('SELECT * FROM symbols LIMIT ?').all(limit) as SymbolRow[];
}

// ─── File helpers ─────────────────────────────────────────────────────────────

export interface FileRow {
  id: number;
  path: string;
  branch: string;
  language: string;
  size_bytes: number;
  last_hash: string | null;
  indexed_at: number;
}

/** Fetch a single file row by primary key. */
export function getFileById(db: Database.Database, id: number, branch?: string): FileRow | undefined {
  if (branch !== undefined) {
    return db.prepare('SELECT * FROM files WHERE id = ? AND branch = ?').get(id, branch) as FileRow | undefined;
  }
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

/** Fetch a single file row by its path. */
export function getFileByPath(db: Database.Database, path: string, branch?: string): FileRow | undefined {
  if (branch !== undefined) {
    return db.prepare('SELECT * FROM files WHERE path = ? AND branch = ?').get(path, branch) as FileRow | undefined;
  }
  return db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
}

/** Return all indexed files, optionally limited to `limit` rows. */
export function listFiles(db: Database.Database, limit = 100, branch?: string): FileRow[] {
  if (branch !== undefined) {
    return db.prepare('SELECT * FROM files WHERE branch = ? LIMIT ?').all(branch, limit) as FileRow[];
  }
  return db.prepare('SELECT * FROM files LIMIT ?').all(limit) as FileRow[];
}

// ─── Annotation helpers ───────────────────────────────────────────────────────

export interface AnnotationRow {
  file_path: string;
  line: number;
  kind: string;
  text: string;
  symbol_name: string | null;
  symbol_kind: string | null;
}

/** Return annotations filtered by kind, with optional path filter and row limit. */
export function listAnnotations(
  db: Database.Database,
  kind: string,
  path?: string,
  limit = 20,
): AnnotationRow[] {
  if (path !== undefined) {
    return db
      .prepare(
        `SELECT f.path AS file_path,
                a.line,
                a.kind,
                a.text,
                s.name AS symbol_name,
                s.kind AS symbol_kind
           FROM annotations a
           JOIN files f ON f.id = a.file_id
      LEFT JOIN symbols s ON s.id = a.symbol_id
          WHERE a.kind = ? AND f.path = ?
          ORDER BY a.line ASC, a.id ASC
          LIMIT ?`,
      )
      .all(kind, path, limit) as AnnotationRow[];
  }

  return db
    .prepare(
      `SELECT f.path AS file_path,
              a.line,
              a.kind,
              a.text,
              s.name AS symbol_name,
              s.kind AS symbol_kind
         FROM annotations a
         JOIN files f ON f.id = a.file_id
    LEFT JOIN symbols s ON s.id = a.symbol_id
        WHERE a.kind = ?
        ORDER BY f.path ASC, a.line ASC, a.id ASC
        LIMIT ?`,
    )
    .all(kind, limit) as AnnotationRow[];
}

// ─── Commit helpers ───────────────────────────────────────────────────────────

export interface CommitRow {
  sha: string;
  author: string;
  author_email: string;
  timestamp: number;
  message: string;
  parents: string;
}

export interface CommitFileRow {
  commit_sha: string;
  file_path: string;
  change_type: string;
  insertions: number | null;
  deletions: number | null;
}

export interface CommitRefRow {
  commit_sha: string;
  ref_name: string;
  ref_type: string;
}

function expandRenamePathVariants(path: string): string[] {
  if (!path.includes('=>')) {
    return [path];
  }

  const braceMatch = path.match(/^(.*)\{([^{}]+)\s=>\s([^{}]+)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, oldSegment, newSegment, suffix] = braceMatch;
    return [`${prefix}${oldSegment}${suffix}`, `${prefix}${newSegment}${suffix}`];
  }

  const split = path.split(/\s=>\s/, 2);
  if (split.length === 2 && split[0] && split[1]) {
    return [split[0].trim(), split[1].trim()];
  }

  return [path];
}

/** Fetch a single commit by its SHA (full or prefix match). */
export function getCommitBySha(db: Database.Database, sha: string): CommitRow | undefined {
  return db
    .prepare('SELECT * FROM commits WHERE sha = ? OR sha LIKE ? LIMIT 1')
    .get(sha, `${sha}%`) as CommitRow | undefined;
}

/** Return the most recent commits ordered by timestamp DESC, limited to `limit` rows. */
export function listRecentCommits(db: Database.Database, limit = 50): CommitRow[] {
  return db
    .prepare('SELECT * FROM commits ORDER BY timestamp DESC, sha ASC LIMIT ?')
    .all(limit) as CommitRow[];
}

/** Return commits that touched the given file path, ordered by timestamp DESC. */
export function listCommitsByFile(db: Database.Database, filePath: string, limit = 50): CommitRow[] {
  const touchedRows = db
    .prepare(
      `SELECT DISTINCT commit_sha, file_path
       FROM commit_files
       WHERE file_path = ? OR file_path LIKE '%=>%'`,
    )
    .all(filePath) as Array<{ commit_sha: string; file_path: string }>;

  const matchingShas = Array.from(
    new Set(
      touchedRows
        .filter((row) => expandRenamePathVariants(row.file_path).includes(filePath))
        .map((row) => row.commit_sha),
    ),
  );

  if (matchingShas.length === 0) {
    return [];
  }

  const placeholders = matchingShas.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT c.* FROM commits c
       WHERE c.sha IN (${placeholders})
       ORDER BY c.timestamp DESC, c.sha ASC
       LIMIT ?`,
    )
    .all(...matchingShas, limit) as CommitRow[];
}

/** Return commits filtered by author name or email, ordered by timestamp DESC. */
export function listCommitsByAuthor(db: Database.Database, author: string, limit = 50): CommitRow[] {
  const pattern = `%${author}%`;
  return db
    .prepare(
      `SELECT * FROM commits
       WHERE author LIKE ? OR author_email LIKE ?
       ORDER BY timestamp DESC, sha ASC
       LIMIT ?`,
    )
    .all(pattern, pattern, limit) as CommitRow[];
}

/** Return all files touched by a given commit SHA. */
export function listCommitFiles(db: Database.Database, commitSha: string): CommitFileRow[] {
  return db
    .prepare('SELECT * FROM commit_files WHERE commit_sha = ?')
    .all(commitSha) as CommitFileRow[];
}

/** Return refs (branches/tags) that currently point to the given commit SHA. */
export function listCommitRefs(db: Database.Database, commitSha: string): CommitRefRow[] {
  try {
    return db
      .prepare('SELECT * FROM commit_refs WHERE commit_sha = ? ORDER BY ref_type ASC, ref_name ASC')
      .all(commitSha) as CommitRefRow[];
  } catch {
    return [];
  }
}

/** Return commits associated with a branch/tag ref name or prefix. */
export function listCommitsByRef(db: Database.Database, refQuery: string, limit = 50): CommitRow[] {
  const exact = refQuery;
  const wildcard = `%${refQuery}%`;
  try {
    if (!refQuery) {
      return db
        .prepare(
          `SELECT DISTINCT c.* FROM commits c
           JOIN commit_refs cr ON cr.commit_sha = c.sha
           ORDER BY c.timestamp DESC, c.sha ASC
           LIMIT ?`,
        )
        .all(limit) as CommitRow[];
    }
    return db
      .prepare(
        `SELECT DISTINCT c.* FROM commits c
         JOIN commit_refs cr ON cr.commit_sha = c.sha
         WHERE cr.ref_name = ? OR cr.ref_name LIKE ?
         ORDER BY c.timestamp DESC, c.sha ASC
         LIMIT ?`,
      )
      .all(exact, wildcard, limit) as CommitRow[];
  } catch {
    return [];
  }
}
