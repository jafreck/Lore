/**
 * @module lore-server/db/queries/edges
 *
 * Resolved call-graph edges, type refs, and symbol relationship queries.
 */

import type Database from 'better-sqlite3';

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
