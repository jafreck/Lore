/**
 * @module lore-server/db/queries/symbols
 *
 * Symbol lookup, listing, and range resolution queries.
 */

import type Database from 'better-sqlite3';
import { escapeLikeWildcards, filesTable, symbolsTable } from './helpers.js';

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Private helpers ──────────────────────────────────────────────────────────

function normalizeSymbolLookupOptions(branchOrOptions?: string | SymbolLookupOptions): SymbolLookupOptions {
  if (typeof branchOrOptions === 'string') {
    return { branch: branchOrOptions };
  }
  return branchOrOptions ?? {};
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

const EXTERNAL_SYMBOL_COLUMNS = `id, dependency_ecosystem, source_type, source_ref,
  package_name, package_version, symbol_name, symbol_kind, signature, doc_comment,
  resolved_type_signature, resolved_return_type, definition_uri, definition_path`;

// ─── Public API ───────────────────────────────────────────────────────────────

/** Fetch a single symbol by primary key.  Returns `undefined` if not found. */
export function getSymbolById(db: Database.Database, id: number): SymbolRow | undefined {
  return db
    .prepare(
      `SELECT s.*, sp.name AS parent_name, f.path AS file_path, f.branch AS file_branch, sm.line_count, sm.param_count, sm.cyclomatic, sm.max_nesting FROM ${symbolsTable(db)} s JOIN ${filesTable(db)} f ON f.id = s.file_id LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id WHERE s.id = ?`
    )
    .get(id) as SymbolRow | undefined;
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
         FROM ${symbolsTable(db)} s
         JOIN ${filesTable(db)} f ON f.id = s.file_id
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
       FROM ${symbolsTable(db)} s
       JOIN ${filesTable(db)} f ON s.file_id = f.id
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
       FROM ${symbolsTable(db)} s
       JOIN ${filesTable(db)} f ON s.file_id = f.id
       LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id
       LEFT JOIN symbol_metrics sm ON sm.symbol_id = s.id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY f.path ASC, f.branch ASC, s.name COLLATE NOCASE ASC, s.kind ASC, s.start_line ASC, s.end_line ASC, s.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as SymbolRow[];
}

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
