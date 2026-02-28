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
  line_count: number | null;
  param_count: number | null;
  cyclomatic: number | null;
  max_nesting: number | null;
}

function hasSymbolMetricsTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'symbol_metrics' LIMIT 1")
    .get() as { ok: number } | undefined;
  return row?.ok === 1;
}

/** Fetch a single symbol by primary key.  Returns `undefined` if not found. */
export function getSymbolById(db: Database.Database, id: number): SymbolRow | undefined {
  if (hasSymbolMetricsTable(db)) {
    return db
      .prepare(
        'SELECT s.*, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting FROM symbols s LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id WHERE s.id = ?'
      )
      .get(id) as SymbolRow | undefined;
  }
  return db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
}

/** Fetch all symbols whose name matches the given string (case-insensitive). */
export function getSymbolsByName(db: Database.Database, name: string, branch?: string): SymbolRow[] {
  const includeMetrics = hasSymbolMetricsTable(db);
  if (branch !== undefined) {
    return db
      .prepare(
        includeMetrics
          ? 'SELECT s.*, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting FROM symbols s JOIN files f ON s.file_id = f.id LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id WHERE s.name = ? COLLATE NOCASE AND f.branch = ?'
          : 'SELECT s.* FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ? COLLATE NOCASE AND f.branch = ?'
      )
      .all(name, branch) as SymbolRow[];
  }
  return db
    .prepare(
      includeMetrics
        ? 'SELECT s.*, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting FROM symbols s LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id WHERE s.name = ? COLLATE NOCASE'
        : 'SELECT * FROM symbols WHERE name = ? COLLATE NOCASE'
    )
    .all(name) as SymbolRow[];
}

/** Return all symbols, optionally limited to `limit` rows. */
export function listSymbols(db: Database.Database, limit = 100, branch?: string): SymbolRow[] {
  const includeMetrics = hasSymbolMetricsTable(db);
  if (branch !== undefined) {
    return db
      .prepare(
        includeMetrics
          ? 'SELECT s.*, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting FROM symbols s JOIN files f ON s.file_id = f.id LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id WHERE f.branch = ? LIMIT ?'
          : 'SELECT s.* FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.branch = ? LIMIT ?'
      )
      .all(branch, limit) as SymbolRow[];
  }
  return db
    .prepare(
      includeMetrics
        ? 'SELECT s.*, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting FROM symbols s LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id LIMIT ?'
        : 'SELECT * FROM symbols LIMIT ?'
    )
    .all(limit) as SymbolRow[];
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

// ─── Route helpers ────────────────────────────────────────────────────────────

export interface ApiRouteRow {
  method: string;
  path: string;
  handler: string;
  file: string;
  line: number;
  framework: string;
}

export interface ListApiRoutesArgs {
  method?: string;
  pathPrefix?: string;
  framework?: string;
}

export function listApiRoutes(db: Database.Database, args: ListApiRoutesArgs = {}): ApiRouteRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (args.method !== undefined) {
    clauses.push('ar.method = ? COLLATE NOCASE');
    params.push(args.method);
  }
  if (args.pathPrefix !== undefined) {
    clauses.push('ar.path LIKE ?');
    params.push(`${args.pathPrefix}%`);
  }
  if (args.framework !== undefined) {
    clauses.push('ar.framework = ? COLLATE NOCASE');
    params.push(args.framework);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT ar.method,
              ar.path,
              ar.handler_name AS handler,
              f.path AS file,
              ar.line,
              ar.framework
         FROM api_routes ar
         JOIN files f ON f.id = ar.file_id
         ${where}
         ORDER BY ar.method, ar.path, f.path`,
    )
    .all(...params) as ApiRouteRow[];
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

export interface CommitStatsFilters {
  since?: string;
  until?: string;
  author?: string;
  limit?: number;
}

export interface CommitCadenceRow {
  bucket: string;
  commits: number;
}

export interface CommitSizeRow {
  sha: string;
  author: string;
  author_email: string;
  timestamp: number;
  insertions: number;
  deletions: number;
}

export interface CommitChurnFileRow {
  file_path: string;
  commit_count: number;
  total_insertions: number;
  total_deletions: number;
  total_churn: number;
}

export interface CommitAuthorStatsRow {
  author: string;
  author_email: string;
  commit_count: number;
  total_insertions: number;
  total_deletions: number;
  total_churn: number;
}

export interface CommitMessagePrefixRow {
  prefix: string;
  count: number;
}

export interface CommitScheduleRow {
  day_of_week: number;
  hour_of_day: number;
  commits: number;
}

export interface CommitBranchActivityRow {
  ref_name: string;
  ref_type: string;
  commits: number;
}

const DEFAULT_STATS_LIMIT = 20;
const MAX_STATS_LIMIT = 200;

function clampStatsLimit(limit?: number): number {
  if (limit == null) return DEFAULT_STATS_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_STATS_LIMIT);
}

function isoDateToUnixSeconds(value: string | undefined, endOfDay: boolean): number | undefined {
  if (!value) return undefined;
  const hasTime = value.includes('T');
  const normalized = hasTime ? value : `${value}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`;
  const millis = Date.parse(normalized);
  if (Number.isNaN(millis)) return undefined;
  return Math.floor(millis / 1000);
}

function buildCommitStatsWhere(filters: CommitStatsFilters): { where: string; params: Array<string | number> } {
  const params: Array<string | number> = [];
  const conditions: string[] = [];

  const sinceTs = isoDateToUnixSeconds(filters.since, false);
  if (sinceTs != null) {
    conditions.push('c.timestamp >= ?');
    params.push(sinceTs);
  }

  const untilTs = isoDateToUnixSeconds(filters.until, true);
  if (untilTs != null) {
    conditions.push('c.timestamp <= ?');
    params.push(untilTs);
  }

  if (filters.author?.trim()) {
    const pattern = `%${filters.author.trim()}%`;
    conditions.push('(c.author LIKE ? OR c.author_email LIKE ?)');
    params.push(pattern, pattern);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
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

export function listCommitCadence(
  db: Database.Database,
  granularity: 'day' | 'week' | 'month',
  filters: CommitStatsFilters = {},
): CommitCadenceRow[] {
  const bucketExpr =
    granularity === 'month'
      ? "strftime('%Y-%m', c.timestamp, 'unixepoch')"
      : granularity === 'week'
        ? "strftime('%Y-W%W', c.timestamp, 'unixepoch')"
        : "strftime('%Y-%m-%d', c.timestamp, 'unixepoch')";
  const { where, params } = buildCommitStatsWhere(filters);
  return db
    .prepare(
      `SELECT ${bucketExpr} AS bucket, COUNT(*) AS commits
       FROM commits c
       ${where}
       GROUP BY bucket
       ORDER BY bucket ASC`,
    )
    .all(...params) as CommitCadenceRow[];
}

export function listCommitSizes(db: Database.Database, filters: CommitStatsFilters = {}): CommitSizeRow[] {
  const { where, params } = buildCommitStatsWhere(filters);
  const limit = clampStatsLimit(filters.limit);
  return db
    .prepare(
      `SELECT c.sha, c.author, c.author_email, c.timestamp,
              COALESCE(SUM(COALESCE(cf.insertions, 0)), 0) AS insertions,
              COALESCE(SUM(COALESCE(cf.deletions, 0)), 0) AS deletions
       FROM commits c
       LEFT JOIN commit_files cf ON cf.commit_sha = c.sha
       ${where}
       GROUP BY c.sha, c.author, c.author_email, c.timestamp
       ORDER BY c.timestamp DESC, c.sha ASC
       LIMIT ?`,
    )
    .all(...params, limit) as CommitSizeRow[];
}

export function listCommitChurnByFile(
  db: Database.Database,
  filters: CommitStatsFilters = {},
): CommitChurnFileRow[] {
  const { where, params } = buildCommitStatsWhere(filters);
  const limit = clampStatsLimit(filters.limit);
  return db
    .prepare(
      `SELECT cf.file_path,
              COUNT(DISTINCT c.sha) AS commit_count,
              COALESCE(SUM(COALESCE(cf.insertions, 0)), 0) AS total_insertions,
              COALESCE(SUM(COALESCE(cf.deletions, 0)), 0) AS total_deletions,
              COALESCE(SUM(COALESCE(cf.insertions, 0) + COALESCE(cf.deletions, 0)), 0) AS total_churn
       FROM commits c
       JOIN commit_files cf ON cf.commit_sha = c.sha
       ${where}
       GROUP BY cf.file_path
       ORDER BY total_churn DESC, commit_count DESC, cf.file_path ASC
       LIMIT ?`,
    )
    .all(...params, limit) as CommitChurnFileRow[];
}

export function listCommitAuthorStats(
  db: Database.Database,
  filters: CommitStatsFilters = {},
): CommitAuthorStatsRow[] {
  const { where, params } = buildCommitStatsWhere(filters);
  const limit = clampStatsLimit(filters.limit);
  return db
    .prepare(
      `SELECT c.author, c.author_email,
              COUNT(DISTINCT c.sha) AS commit_count,
              COALESCE(SUM(COALESCE(cf.insertions, 0)), 0) AS total_insertions,
              COALESCE(SUM(COALESCE(cf.deletions, 0)), 0) AS total_deletions,
              COALESCE(SUM(COALESCE(cf.insertions, 0) + COALESCE(cf.deletions, 0)), 0) AS total_churn
       FROM commits c
       LEFT JOIN commit_files cf ON cf.commit_sha = c.sha
       ${where}
       GROUP BY c.author, c.author_email
       ORDER BY commit_count DESC, total_churn DESC, c.author ASC
       LIMIT ?`,
    )
    .all(...params, limit) as CommitAuthorStatsRow[];
}

export function listCommitMessagePrefixes(
  db: Database.Database,
  filters: CommitStatsFilters = {},
): CommitMessagePrefixRow[] {
  const { where, params } = buildCommitStatsWhere(filters);
  const limit = clampStatsLimit(filters.limit);
  return db
    .prepare(
      `SELECT LOWER(
                CASE
                  WHEN instr(c.message, ':') > 0 THEN substr(c.message, 1, instr(c.message, ':'))
                  ELSE '(other)'
                END
              ) AS prefix,
              COUNT(*) AS count
       FROM commits c
       ${where}
       GROUP BY prefix
       ORDER BY count DESC, prefix ASC
       LIMIT ?`,
    )
    .all(...params, limit) as CommitMessagePrefixRow[];
}

export function listCommitSchedule(
  db: Database.Database,
  filters: CommitStatsFilters = {},
): CommitScheduleRow[] {
  const { where, params } = buildCommitStatsWhere(filters);
  return db
    .prepare(
      `SELECT CAST(strftime('%w', c.timestamp, 'unixepoch') AS INTEGER) AS day_of_week,
              CAST(strftime('%H', c.timestamp, 'unixepoch') AS INTEGER) AS hour_of_day,
              COUNT(*) AS commits
       FROM commits c
       ${where}
       GROUP BY day_of_week, hour_of_day
       ORDER BY day_of_week ASC, hour_of_day ASC`,
    )
    .all(...params) as CommitScheduleRow[];
}

export function listCommitBranchActivity(
  db: Database.Database,
  filters: CommitStatsFilters = {},
): CommitBranchActivityRow[] {
  const { where, params } = buildCommitStatsWhere(filters);
  const limit = clampStatsLimit(filters.limit);
  try {
    return db
      .prepare(
        `SELECT cr.ref_name, cr.ref_type, COUNT(DISTINCT c.sha) AS commits
         FROM commits c
         JOIN commit_refs cr ON cr.commit_sha = c.sha
         ${where}
         GROUP BY cr.ref_name, cr.ref_type
         ORDER BY commits DESC, cr.ref_name ASC
         LIMIT ?`,
      )
      .all(...params, limit) as CommitBranchActivityRow[];
  } catch {
    return [];
  }
}
