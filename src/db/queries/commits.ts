/**
 * @module lore-server/db/queries/commits
 *
 * Commit history and statistics queries.
 */

import type Database from 'better-sqlite3';
import { escapeLikeWildcards, hasCommitEmbeddingsTable } from './helpers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Private helpers ──────────────────────────────────────────────────────────

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
    const pattern = `%${escapeLikeWildcards(filters.author.trim())}%`;
    conditions.push(`(c.author LIKE ? ESCAPE '\\' OR c.author_email LIKE ? ESCAPE '\\')`);
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

// ─── Public API ───────────────────────────────────────────────────────────────

/** Fetch a single commit by its SHA (full or prefix match). */
export function getCommitBySha(db: Database.Database, sha: string): CommitRow | undefined {
  // Exact match first
  const exact = db.prepare('SELECT * FROM commits WHERE sha = ?').get(sha);
  if (exact) return exact as CommitRow;

  // Prefix match — check for ambiguity
  const prefixMatches = db
    .prepare(
      `SELECT * FROM commits WHERE sha LIKE ? ESCAPE '\\' ORDER BY sha ASC LIMIT 2`,
    )
    .all(`${escapeLikeWildcards(sha)}%`);

  if (prefixMatches.length === 1) return prefixMatches[0] as CommitRow;
  if (prefixMatches.length > 1) return undefined; // Ambiguous prefix
  return undefined; // No match
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
  const pattern = `%${escapeLikeWildcards(author)}%`;
  return db
    .prepare(
      `SELECT * FROM commits
       WHERE author LIKE ? ESCAPE '\\' OR author_email LIKE ? ESCAPE '\\'
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
  return db
    .prepare('SELECT * FROM commit_refs WHERE commit_sha = ? ORDER BY ref_type ASC, ref_name ASC')
    .all(commitSha) as CommitRefRow[];
}

/** Return commits associated with a branch/tag ref name or prefix. */
export function listCommitsByRef(db: Database.Database, refQuery: string, limit = 50): CommitRow[] {
  const exact = refQuery;
  const wildcard = `%${escapeLikeWildcards(refQuery)}%`;
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
       WHERE cr.ref_name = ? OR cr.ref_name LIKE ? ESCAPE '\\'
       ORDER BY c.timestamp DESC, c.sha ASC
       LIMIT ?`,
    )
    .all(exact, wildcard, limit) as CommitRow[];
}

/** Whether commit semantic vectors are queryable and contain at least one row. */
export function hasCommitEmbeddings(db: Database.Database): boolean {
  if (!hasCommitEmbeddingsTable(db)) {
    return false;
  }
  try {
    const row = db.prepare('SELECT 1 AS ok FROM commit_embeddings LIMIT 1').get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

/** Return commits ranked by commit-message vector distance (ascending). */
export function listCommitsBySemanticQuery(
  db: Database.Database,
  queryVector: number[],
  limit = 50,
): CommitRow[] {
  if (queryVector.length === 0 || !hasCommitEmbeddings(db)) {
    return [];
  }

  return db
    .prepare(
      `SELECT c.*
         FROM commit_embeddings ce
         JOIN commits c ON c.rowid = ce.rowid
        WHERE ce.embedding MATCH ?
          AND k = ?
        ORDER BY distance, c.timestamp DESC, c.sha ASC`,
    )
    .all(JSON.stringify(queryVector), limit) as CommitRow[];
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
  const limit = clampStatsLimit(filters.limit);
  return db
    .prepare(
      `SELECT ${bucketExpr} AS bucket, COUNT(*) AS commits
       FROM commits c
       ${where}
       GROUP BY bucket
       ORDER BY bucket ASC
       LIMIT ?`,
    )
    .all(...params, limit) as CommitCadenceRow[];
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
}
