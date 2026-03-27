/**
 * @module lore-server/db
 *
 * Read-only SQLite connection wrapper for the Lore MCP server.
 * All MCP tool files use `openReadOnly()` to open the knowledge-base database.
 */

import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);

// Re-export the Database type so callers don't need to import better-sqlite3 directly.
export type { Database };

/** Escape SQL LIKE wildcard characters (`%` and `_`) so they match literally. */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[%_]/g, (ch) => `\\${ch}`);
}

/** Hard ceiling applied to all result-set limits to prevent OOM on unbounded queries. */
const MAX_RESULT_LIMIT = 10_000;

/**
 * Clamp a caller-supplied limit to the hard ceiling.
 * When no limit is given, `defaultLimit` is used (default: 1 000).
 */
function clampLimit(limit: number | undefined, defaultLimit = 1000): number {
  if (limit === undefined) return defaultLimit;
  return Math.min(Math.max(1, limit), MAX_RESULT_LIMIT);
}

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

// ─── Freshness metadata ───────────────────────────────────────────────────────

/** Freshness info describing the data source for a query result. */
export interface FreshnessInfo {
  /** 'baseline' = all data from last full SCIP build.
      'mixed'    = some files use overlay data.
      'overlay'  = all queried files have overlay data. */
  source: 'baseline' | 'mixed' | 'overlay';
  /** Seconds since the baseline was last rebuilt. */
  baseline_age_s: number;
  /** Number of dirty files in the index. */
  dirty_file_count: number;
}

/**
 * Compute freshness metadata for the current database state.
 * Call this to include with MCP tool responses.
 */
export function getFreshness(db: Database.Database): FreshnessInfo {
  let dirtyCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM dirty_files').get() as { cnt: number } | undefined;
    dirtyCount = row?.cnt ?? 0;
  } catch {
    // dirty_files table may not exist in old databases
  }

  let baselineAgeS = 0;
  try {
    const row = db.prepare(
      "SELECT MAX(indexed_at) AS latest FROM files WHERE layer = 'baseline'",
    ).get() as { latest: number | null } | undefined;
    if (row?.latest) {
      baselineAgeS = Math.max(0, Math.floor(Date.now() / 1000) - row.latest);
    }
  } catch {
    // layer column may not exist in old databases
  }

  const source: FreshnessInfo['source'] = dirtyCount === 0 ? 'baseline' : 'mixed';
  return { source, baseline_age_s: baselineAgeS, dirty_file_count: dirtyCount };
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
  resolved_type_signature?: string | null;
  resolved_return_type?: string | null;
  definition_uri?: string | null;
  definition_path?: string | null;
  is_exported?: number | null;
  parent_symbol_id?: number | null;
  parent_name?: string | null;
  file_path?: string | null;
  file_branch?: string | null;
}

export interface SymbolRangeLookupOptions {
  path?: string;
  branch?: string;
}

export interface SymbolRangeMatch {
  symbol_id: number;
  symbol_name: string;
  symbol_kind: string;
  file_id: number;
  file_path: string;
  branch: string;
  start_line: number;
  end_line: number;
}

export type SymbolRangeResolution =
  | {
    outcome: 'resolved';
    match: SymbolRangeMatch;
  }
  | {
    outcome: 'missing';
    symbol: string;
    path?: string;
    branch?: string;
  }
  | {
    outcome: 'ambiguous';
    symbol: string;
    path?: string;
    branch?: string;
    candidates: SymbolRangeMatch[];
  };

export type SymbolMatchMode = 'exact' | 'prefix' | 'contains';

export interface SymbolLookupOptions {
  branch?: string;
  matchMode?: SymbolMatchMode;
  kind?: string;
  pathPrefix?: string;
  language?: string;
}

export interface ListSymbolsOptions {
  branch?: string;
  kind?: string;
  pathPrefix?: string;
  language?: string;
  limit?: number;
  offset?: number;
}

/** Fetch a single symbol by primary key.  Returns `undefined` if not found. */
export function getSymbolById(db: Database.Database, id: number): SymbolRow | undefined {
  return db
    .prepare(
      'SELECT s.*, sp.name AS parent_name, f.path AS file_path, f.branch AS file_branch, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting FROM symbols s JOIN files f ON f.id = s.file_id LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id WHERE s.id = ?'
    )
    .get(id) as SymbolRow | undefined;
}

function normalizeSymbolLookupOptions(branchOrOptions?: string | SymbolLookupOptions): SymbolLookupOptions {
  if (typeof branchOrOptions === 'string') {
    return { branch: branchOrOptions };
  }
  return branchOrOptions ?? {};
}

/** List symbol range candidates with optional path/branch filters for disambiguation. */
export function listSymbolRangesByName(
  db: Database.Database,
  name: string,
  options: SymbolRangeLookupOptions = {},
): SymbolRangeMatch[] {
  const where = ['s.name = ? COLLATE NOCASE'];
  const params: Array<string | number> = [name];

  if (options.path !== undefined) {
    where.push('f.path = ?');
    params.push(options.path);
  }
  if (options.branch !== undefined) {
    where.push('f.branch = ?');
    params.push(options.branch);
  }

  return db
    .prepare(
      `SELECT s.id AS symbol_id,
              s.name AS symbol_name,
              s.kind AS symbol_kind,
              s.file_id,
              f.path AS file_path,
              f.branch,
              s.start_line,
              s.end_line
         FROM symbols s
         JOIN files f ON f.id = s.file_id
        WHERE ${where.join(' AND ')}
        ORDER BY f.path ASC, f.branch ASC, s.start_line ASC, s.end_line ASC, s.id ASC`,
    )
    .all(...params) as SymbolRangeMatch[];
}

/**
 * Resolve a symbol name to a concrete file and line range.
 * Returns deterministic ambiguity details instead of selecting an arbitrary match.
 */
export function resolveSymbolRangeByName(
  db: Database.Database,
  name: string,
  options: SymbolRangeLookupOptions = {},
): SymbolRangeResolution {
  const candidates = listSymbolRangesByName(db, name, options);
  if (candidates.length === 1) {
    const match = candidates[0];
    if (!match) {
      throw new Error('Expected a single symbol range candidate.');
    }
    return { outcome: 'resolved', match };
  }
  if (candidates.length === 0) {
    return {
      outcome: 'missing',
      symbol: name,
      path: options.path,
      branch: options.branch,
    };
  }
  return {
    outcome: 'ambiguous',
    symbol: name,
    path: options.path,
    branch: options.branch,
    candidates,
  };
}

function buildNameMatch(name: string, mode: SymbolMatchMode): { clause: string; value: string } {
  if (mode === 'prefix') {
    return { clause: `s.name LIKE ? ESCAPE '\\' COLLATE NOCASE`, value: `${escapeLikeWildcards(name)}%` };
  }
  if (mode === 'contains') {
    return { clause: `s.name LIKE ? ESCAPE '\\' COLLATE NOCASE`, value: `%${escapeLikeWildcards(name)}%` };
  }
  return { clause: 's.name = ? COLLATE NOCASE', value: name };
}

function applySymbolFilters(where: string[], params: Array<string | number>, options: SymbolLookupOptions): void {
  if (options.branch !== undefined) {
    where.push('f.branch = ?');
    params.push(options.branch);
  }
  if (options.kind !== undefined) {
    where.push('s.kind = ?');
    params.push(options.kind);
  }
  if (options.pathPrefix !== undefined) {
    where.push(`f.path LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLikeWildcards(options.pathPrefix)}%`);
  }
  if (options.language !== undefined) {
    where.push('f.language = ?');
    params.push(options.language);
  }
}

/** Fetch all symbols whose name matches the given string using the requested match mode. */
export function getSymbolsByName(db: Database.Database, name: string, branch?: string): SymbolRow[];
export function getSymbolsByName(db: Database.Database, name: string, options?: SymbolLookupOptions): SymbolRow[];
export function getSymbolsByName(
  db: Database.Database,
  name: string,
  branchOrOptions?: string | SymbolLookupOptions,
): SymbolRow[] {
  const options = normalizeSymbolLookupOptions(branchOrOptions);
  const matchMode = options.matchMode ?? 'exact';
  const { clause, value } = buildNameMatch(name, matchMode);
  const where: string[] = [clause];
  const params: Array<string | number> = [value];
  applySymbolFilters(where, params, options);

  return db
    .prepare(
      `SELECT s.*, sp.name AS parent_name, f.path AS file_path, f.branch AS file_branch, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id
       LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id
       WHERE ${where.join(' AND ')}`,
    )
    .all(...params) as SymbolRow[];
}

/** Return symbols with optional filters and pagination controls. */
export function listSymbols(db: Database.Database, limit?: number, branch?: string): SymbolRow[];
export function listSymbols(db: Database.Database, options?: ListSymbolsOptions): SymbolRow[];
export function listSymbols(
  db: Database.Database,
  limitOrOptions: number | ListSymbolsOptions = 100,
  branch?: string,
): SymbolRow[] {
  const options: ListSymbolsOptions = typeof limitOrOptions === 'number'
    ? { limit: limitOrOptions, branch }
    : (limitOrOptions ?? {});
  const where: string[] = [];
  const params: Array<string | number> = [];
  applySymbolFilters(where, params, options);
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  params.push(limit, offset);

  return db
    .prepare(
      `SELECT s.*, sp.name AS parent_name, f.path AS file_path, f.branch AS file_branch, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id
       LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as SymbolRow[];
}

export interface SemanticSearchSymbolsArgs {
  queryVector: number[];
  branch?: string;
  limit?: number;
}

export interface SemanticSymbolRow extends SymbolRow {
  file_path: string;
  file_branch: string;
  score: number;
}

/** Search symbols by embedding distance with optional branch filtering. */
export function semanticSearchSymbols(
  db: Database.Database,
  args: SemanticSearchSymbolsArgs,
): SemanticSymbolRow[] {
  if (args.queryVector.length === 0) return [];

  const limit = Math.max(1, Math.floor(args.limit ?? 20));
  const where: string[] = ['se.embedding MATCH ?', 'se.k = ?'];
  const params: Array<string | number> = [JSON.stringify(args.queryVector), limit];

  if (args.branch !== undefined) {
    where.push('f.branch = ?');
    params.push(args.branch);
  }

  return db
    .prepare(
      `SELECT s.*, sp.name AS parent_name, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting,
              f.path AS file_path,
              f.branch AS file_branch,
              distance AS score
         FROM symbol_embeddings se
         JOIN symbols s ON s.rowid = se.rowid
         JOIN files f ON f.id = s.file_id
         LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id
         LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id
        WHERE ${where.join(' AND ')}
        ORDER BY distance ASC,
                 f.path ASC,
                 f.branch ASC,
                 s.name COLLATE NOCASE ASC,
                 s.kind ASC,
                 s.start_line ASC,
                 s.end_line ASC,
                 s.id ASC`,
    )
    .all(...params) as SemanticSymbolRow[];
}

export interface ExternalSymbolRow {
  id: number;
  dependency_ecosystem: string;
  source_type: string;
  source_ref: string;
  package_name: string;
  package_version: string | null;
  symbol_name: string;
  symbol_kind: string;
  signature: string;
  doc_comment: string | null;
  resolved_type_signature: string | null;
  resolved_return_type: string | null;
  definition_uri: string | null;
  definition_path: string | null;
}

const EXTERNAL_SYMBOL_COLUMNS = `id, dependency_ecosystem, source_type, source_ref,
  package_name, package_version, symbol_name, symbol_kind, signature, doc_comment,
  resolved_type_signature, resolved_return_type, definition_uri, definition_path`;

/** Fetch external symbols whose exported name exactly matches (case-insensitive). */
export function getExternalSymbolsByName(
  db: Database.Database,
  name: string,
): ExternalSymbolRow[] {
  return db
    .prepare(
      `SELECT ${EXTERNAL_SYMBOL_COLUMNS}
         FROM external_symbols
         WHERE symbol_name = ? COLLATE NOCASE
         ORDER BY dependency_ecosystem ASC, package_name ASC, package_version ASC, symbol_kind ASC, signature ASC`,
    )
    .all(name) as ExternalSymbolRow[];
}

/** Fetch external symbols whose exported name contains the query fragment. */
export function searchExternalSymbolsByName(
  db: Database.Database,
  nameQuery: string,
  limit = 100,
): ExternalSymbolRow[] {
  return db
    .prepare(
      `SELECT ${EXTERNAL_SYMBOL_COLUMNS}
         FROM external_symbols
         WHERE symbol_name LIKE ? ESCAPE '\\' COLLATE NOCASE
         ORDER BY dependency_ecosystem ASC, package_name ASC, package_version ASC, symbol_kind ASC, signature ASC
         LIMIT ?`,
    )
    .all(`%${escapeLikeWildcards(nameQuery)}%`, limit) as ExternalSymbolRow[];
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

/**
 * Return all indexed files, optionally filtered and paginated.
 *
 * A hard cap of {@link MAX_RESULT_LIMIT} is applied even when no explicit
 * `limit` is passed, using a default of 1 000 rows to prevent unbounded
 * result sets from consuming excessive memory.  Pass an explicit `limit`
 * to retrieve a different number of rows (still subject to the hard cap).
 */
export function listFiles(db: Database.Database, limit?: number, branch?: string): FileRow[] {
  const effectiveLimit = clampLimit(limit);
  if (branch !== undefined) {
    return db.prepare('SELECT * FROM files WHERE branch = ? LIMIT ?').all(branch, effectiveLimit) as FileRow[];
  }
  return db.prepare('SELECT * FROM files LIMIT ?').all(effectiveLimit) as FileRow[];
}

/** Return indexed files matching an exact path or directory prefix. */
export function listFilesByPathPrefix(
  db: Database.Database,
  pathPrefix: string,
  branch?: string,
  limit = 1000,
): FileRow[] {
  const trimmed = pathPrefix.trim();
  if (!trimmed) return [];
  const normalized = trimmed.endsWith('/') && trimmed.length > 1 ? trimmed.slice(0, -1) : trimmed;
  const likePattern = normalized === '/' ? '/%' : `${escapeLikeWildcards(normalized)}/%`;
  if (branch !== undefined) {
    return db
      .prepare(
        `SELECT * FROM files
         WHERE branch = ? AND (path = ? OR path LIKE ? ESCAPE '\\')
         ORDER BY path ASC, branch ASC
         LIMIT ?`,
      )
      .all(branch, normalized, likePattern, limit) as FileRow[];
  }
  return db
    .prepare(
      `SELECT * FROM files
       WHERE path = ? OR path LIKE ? ESCAPE '\\'
       ORDER BY path ASC, branch ASC
       LIMIT ?`,
    )
    .all(normalized, likePattern, limit) as FileRow[];
}

// ─── Resolved call-graph edges ────────────────────────────────────────────────

export interface ResolvedEdge {
  ref_id: number;
  caller_id: number;
  caller_name: string;
  caller_kind: string;
  caller_file_id: number;
  caller_file_path: string;
  callee_id: number | null;
  callee_name: string;
  callee_kind: string | null;
  callee_file_id: number | null;
  callee_file_path: string | null;
  call_line: number;
  call_character: number | null;
  call_kind: string;
  resolution_method: string;
}

export interface ListResolvedEdgesOptions {
  /** Only include edges where `callee_id` is resolved (non-NULL). Default: false. */
  resolvedOnly?: boolean;
  /** Restrict to edges whose caller belongs to this file. */
  fileId?: number;
  /** Filter by caller branch. */
  branch?: string;
  /** Allowlist of resolution methods to include. When set, only edges whose
   *  `resolution_method` is in this list are returned. */
  methods?: string[];
  /** Maximum rows to return. Default: 100 000. */
  limit?: number;
}

/**
 * Returns pre-resolved call-graph edges from `symbol_refs`, joining through
 * `symbols` and `files` to denormalize caller/callee metadata.
 *
 * Consumers get a ready-to-use edge list without needing to re-resolve
 * `callee_name` by hand.  The query:
 *
 *  - Prefers `callee_id` when populated (LSP-resolved or name-resolved)
 *  - Includes `resolution_method` so callers can filter by confidence
 *  - Optionally restricts to a single file (file-scoped queries)
 *  - Defaults to a high limit (100 000) to avoid silent truncation
 */
export function listResolvedEdges(
  db: Database.Database,
  options: ListResolvedEdgesOptions = {},
): ResolvedEdge[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.resolvedOnly) {
    where.push('sr.callee_id IS NOT NULL');
  }
  if (options.fileId !== undefined) {
    where.push('sr.file_id = ?');
    params.push(options.fileId);
  }
  if (options.branch !== undefined) {
    where.push('f_caller.branch = ?');
    params.push(options.branch);
  }
  if (options.methods !== undefined && options.methods.length > 0) {
    const ph = options.methods.map(() => '?').join(', ');
    where.push(`sr.resolution_method IN (${ph})`);
    params.push(...options.methods);
  }

  const limit = options.limit ?? 100_000;
  params.push(limit);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT sr.id          AS ref_id,
              sr.caller_id,
              s_caller.name  AS caller_name,
              s_caller.kind  AS caller_kind,
              s_caller.file_id AS caller_file_id,
              f_caller.path  AS caller_file_path,
              sr.callee_id,
              sr.callee_name,
              s_callee.kind  AS callee_kind,
              s_callee.file_id AS callee_file_id,
              f_callee.path  AS callee_file_path,
              sr.call_line,
              sr.call_character,
              sr.call_kind,
              sr.resolution_method
         FROM symbol_refs sr
         JOIN symbols s_caller  ON s_caller.id = sr.caller_id
         JOIN files   f_caller  ON f_caller.id = s_caller.file_id
         LEFT JOIN symbols s_callee ON s_callee.id = sr.callee_id
         LEFT JOIN files   f_callee ON f_callee.id = s_callee.file_id
         ${whereClause}
         ORDER BY sr.caller_id ASC, sr.call_line ASC
         LIMIT ?`,
    )
    .all(...params) as ResolvedEdge[];
}

// ─── Type-ref edges ───────────────────────────────────────────────────────────

export interface TypeRefEdge {
  ref_id: number;
  symbol_id: number | null;
  symbol_name: string | null;
  symbol_kind: string | null;
  symbol_file_id: number | null;
  symbol_file_path: string | null;
  type_id: number | null;
  type_name: string;
  type_name_bare: string;
  type_kind: string | null;
  type_file_id: number | null;
  type_file_path: string | null;
  ref_kind: string;
  ref_line: number;
  ref_character: number | null;
  resolution_method: string;
}

export interface ListTypeRefsOptions {
  /** Only include edges where `type_id` is resolved (non-NULL). Default: false. */
  resolvedOnly?: boolean;
  /** Restrict to edges from this file. */
  fileId?: number;
  /** Filter by branch. */
  branch?: string;
  /** Allowlist of resolution methods to include. */
  methods?: string[];
  /** Maximum rows to return. Default: 100 000. */
  limit?: number;
}

/**
 * Returns type-reference edges from `type_refs`, joining through
 * `symbols` and `files` to denormalize source/target metadata.
 */
export function listTypeRefs(
  db: Database.Database,
  options: ListTypeRefsOptions = {},
): TypeRefEdge[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.resolvedOnly) {
    where.push('tr.type_id IS NOT NULL');
  }
  if (options.fileId !== undefined) {
    where.push('tr.file_id = ?');
    params.push(options.fileId);
  }
  if (options.branch !== undefined) {
    where.push('f_src.branch = ?');
    params.push(options.branch);
  }
  if (options.methods !== undefined && options.methods.length > 0) {
    const ph = options.methods.map(() => '?').join(', ');
    where.push(`tr.resolution_method IN (${ph})`);
    params.push(...options.methods);
  }

  const limit = options.limit ?? 100_000;
  params.push(limit);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT tr.id           AS ref_id,
              tr.symbol_id,
              s_src.name      AS symbol_name,
              s_src.kind      AS symbol_kind,
              s_src.file_id   AS symbol_file_id,
              f_src.path      AS symbol_file_path,
              tr.type_id,
              tr.type_name,
              tr.type_name_bare,
              s_dst.kind      AS type_kind,
              s_dst.file_id   AS type_file_id,
              f_dst.path      AS type_file_path,
              tr.ref_kind,
              tr.ref_line,
              tr.ref_character,
              tr.resolution_method
         FROM type_refs tr
         JOIN files f_src ON f_src.id = tr.file_id
         LEFT JOIN symbols s_src ON s_src.id = tr.symbol_id
         LEFT JOIN symbols s_dst ON s_dst.id = tr.type_id
         LEFT JOIN files   f_dst ON f_dst.id = s_dst.file_id
         ${whereClause}
         ORDER BY tr.file_id ASC, tr.ref_line ASC
         LIMIT ?`,
    )
    .all(...params) as TypeRefEdge[];
}

// ─── Symbol-relationship edges ────────────────────────────────────────────────

export interface SymbolRelationshipEdge {
  ref_id: number;
  source_symbol_id: number | null;
  source_name: string | null;
  source_kind: string | null;
  source_file_id: number | null;
  source_file_path: string | null;
  target_symbol_id: number | null;
  target_symbol_name: string;
  target_kind: string | null;
  target_file_id: number | null;
  target_file_path: string | null;
  relationship_type: string;
  line: number;
  character: number | null;
  resolution_method: string;
}

export interface ListSymbolRelationshipsOptions {
  /** Only include edges where `target_symbol_id` is resolved (non-NULL). Default: false. */
  resolvedOnly?: boolean;
  /** Restrict to edges from this file. */
  fileId?: number;
  /** Filter by branch. */
  branch?: string;
  /** Filter by relationship type (e.g. 'extends', 'implements'). */
  relationshipType?: string;
  /** Allowlist of resolution methods to include. */
  methods?: string[];
  /** Maximum rows to return. Default: 100 000. */
  limit?: number;
}

/**
 * Returns symbol-relationship edges (extends, implements, etc.) from
 * `symbol_relationships`, joining through `symbols` and `files`.
 */
export function listSymbolRelationships(
  db: Database.Database,
  options: ListSymbolRelationshipsOptions = {},
): SymbolRelationshipEdge[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.resolvedOnly) {
    where.push('rel.target_symbol_id IS NOT NULL');
  }
  if (options.fileId !== undefined) {
    where.push('rel.file_id = ?');
    params.push(options.fileId);
  }
  if (options.branch !== undefined) {
    where.push('f_src.branch = ?');
    params.push(options.branch);
  }
  if (options.relationshipType !== undefined) {
    where.push('rel.relationship_type = ?');
    params.push(options.relationshipType);
  }
  if (options.methods !== undefined && options.methods.length > 0) {
    const ph = options.methods.map(() => '?').join(', ');
    where.push(`rel.resolution_method IN (${ph})`);
    params.push(...options.methods);
  }

  const limit = options.limit ?? 100_000;
  params.push(limit);

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT rel.id               AS ref_id,
              rel.source_symbol_id,
              s_src.name           AS source_name,
              s_src.kind           AS source_kind,
              s_src.file_id        AS source_file_id,
              f_src.path           AS source_file_path,
              rel.target_symbol_id,
              rel.target_symbol_name,
              s_dst.kind           AS target_kind,
              s_dst.file_id        AS target_file_id,
              f_dst.path           AS target_file_path,
              rel.relationship_type,
              rel.line,
              rel.character,
              rel.resolution_method
         FROM symbol_relationships rel
         JOIN files f_src ON f_src.id = rel.file_id
         LEFT JOIN symbols s_src ON s_src.id = rel.source_symbol_id
         LEFT JOIN symbols s_dst ON s_dst.id = rel.target_symbol_id
         LEFT JOIN files   f_dst ON f_dst.id = s_dst.file_id
         ${whereClause}
         ORDER BY rel.file_id ASC, rel.line ASC
         LIMIT ?`,
    )
    .all(...params) as SymbolRelationshipEdge[];
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

function hasCommitEmbeddingsTable(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'commit_embeddings' LIMIT 1",
    )
    .get() as { ok: number } | undefined;
  return row?.ok === 1;
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

/** Fetch a single commit by its SHA (full or prefix match). */
export function getCommitBySha(db: Database.Database, sha: string): CommitRow | undefined {
  return db
    .prepare(`SELECT * FROM commits WHERE sha = ? OR sha LIKE ? ESCAPE '\\' LIMIT 1`)
    .get(sha, `${escapeLikeWildcards(sha)}%`) as CommitRow | undefined;
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
