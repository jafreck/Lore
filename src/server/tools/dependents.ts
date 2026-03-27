/**
 * @module lore-server/tools/dependents
 *
 * MCP tool: unified reverse-dependency / blast-radius queries.
 *
 * Given a symbol name or file path, returns all dependents across edge types
 * (callers, importers, subclasses, type references) in a single call.
 * This is a higher-level abstraction over `lore_graph` that resolves names
 * internally and aggregates across edge kinds.
 */

import type { Database } from '../../db/read-only.js';
import {
  getSymbolsByName,
  getFileByPath,
  getSymbolById,
  getFileById,
} from '../../db/read-only.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_dependents',
  description:
    'Use this tool FIRST for any reverse-dependency question: who calls X, what breaks if I delete X, ' +
    'what is the blast radius of changing X, which other files call X, or can X be safely inlined. ' +
    'Returns callers, importers, subclasses, and type references in one call — including transitive dependents up to 5 hops. ' +
    'Finds both same-file wrappers AND cross-file callers; if the question asks about "other files", call this first then filter results. ' +
    'Every caller returned is verified — do NOT re-verify results by reading source files. ' +
    'For kind="symbol", resolves the query by name and returns all reverse edges. ' +
    'For kind="file", returns files that import it plus symbols in other files that call into its exports. ' +
    'Use compact=true (recommended default) for caller inventories, fan-in counts, and deletion/inline safety checks — one call is usually enough. ' +
    'Use lore_snippet only if the question explicitly asks for exact call-site code lines. ' +
    'This is the REVERSE counterpart to lore_graph(kind=call) which answers "what does X call" (forward).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Symbol name, function name, or file path to find dependents of. Use the name as it appears in source code.',
      },
      kind: {
        type: 'string',
        enum: ['symbol', 'file'],
        description:
          '"symbol" resolves query as a symbol name; "file" resolves query as a file path.',
      },
      branch: {
        type: 'string',
        description: 'Optional branch name to filter results.',
      },
      compact: {
        type: 'boolean',
        description:
          'Omit provenance fields to reduce token count. Recommended default for caller inventories, fan-in, deletion, and inline checks. Default false.',
      },
    },
    required: ['query', 'kind'],
  },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DependentsArgs {
  query: string;
  kind: 'symbol' | 'file';
  branch?: string;
  compact?: boolean;
}

export interface DependentTarget {
  id: number;
  name: string;
  kind: string;
  file?: string;
}

interface CallerEntry {
  caller_id: number;
  caller_name: string;
  caller_parent_symbol_id?: number | null;
  caller_parent_name?: string | null;
  caller_kind: string;
  caller_file: string;
  line?: number;
  character?: number | null;
  resolution_method?: string;
}

interface CompactCallerEntry {
  caller_id: number;
  caller_name: string;
  caller_parent_symbol_id?: number | null;
  caller_parent_name?: string | null;
  caller_kind: string;
  caller_file: string;
}

interface ImporterEntry {
  file_id: number;
  file_path: string;
  raw_import: string;
}

interface CompactImporterEntry {
  file_id: number;
  file_path: string;
}

interface SubclassEntry {
  symbol_id: number;
  symbol_name: string;
  symbol_kind: string;
  file: string;
  relationship_type: string;
  line?: number;
  character?: number | null;
  resolution_method?: string;
}

interface CompactSubclassEntry {
  symbol_id: number;
  symbol_name: string;
  symbol_kind: string;
  file: string;
  relationship_type: string;
}

interface TypeRefEntry {
  symbol_id: number;
  symbol_name: string;
  symbol_kind: string;
  file: string;
  ref_kind: string;
  line?: number;
  character?: number | null;
  resolution_method?: string;
}

interface CompactTypeRefEntry {
  symbol_id: number;
  symbol_name: string;
  symbol_kind: string;
  file: string;
  ref_kind: string;
}

export interface DependentsResult {
  target: DependentTarget;
  dependents: {
    callers: CallerEntry[] | CompactCallerEntry[];
    importers: ImporterEntry[] | CompactImporterEntry[];
    subclasses: SubclassEntry[] | CompactSubclassEntry[];
    type_references: TypeRefEntry[] | CompactTypeRefEntry[];
  };
  depth_used: number;
  total_count: number;
  truncated: boolean;
}



// ─── Raw SQL row shapes ──────────────────────────────────────────────────────

interface RawCallerRow {
  caller_id: number;
  caller_name: string;
  caller_kind: string;
  caller_file: string;
  caller_parent_symbol_id: number | null;
  enclosing_name: string | null;
  line: number;
  character: number | null;
  resolution_method: string;
}

interface RawImporterRow {
  file_id: number;
  file_path: string;
  raw_import: string;
}

interface RawSubclassRow {
  symbol_id: number;
  symbol_name: string;
  symbol_kind: string;
  file: string;
  relationship_type: string;
  line: number | null;
  character: number | null;
  resolution_method: string;
}

interface RawTypeRefRow {
  symbol_id: number;
  symbol_name: string;
  symbol_kind: string;
  file: string;
  ref_kind: string;
  line: number;
  character: number | null;
  resolution_method: string;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

function queryCallers(
  db: Database.Database,
  symbolIds: number[],
  branch: string | undefined,
  limit: number,
): RawCallerRow[] {
  if (symbolIds.length === 0) return [];
  const placeholders = symbolIds.map(() => '?').join(', ');
  const conditions = [`sr.callee_id IN (${placeholders})`];
  const params: Array<string | number> = [...symbolIds];
  if (branch !== undefined) {
    conditions.push('f.branch = ?');
    params.push(branch);
  }
  params.push(limit);

  return db
    .prepare(
      `SELECT sr.caller_id,
              s.name AS caller_name,
              s.kind AS caller_kind,
              f.path AS caller_file,
              s.parent_symbol_id AS caller_parent_symbol_id,
              sp.name AS enclosing_name,
              sr.call_line + 1 AS line,
              CASE WHEN sr.call_character IS NULL THEN NULL ELSE sr.call_character + 1 END AS character,
              sr.resolution_method
         FROM symbol_refs sr
         JOIN symbols s ON s.id = sr.caller_id
         JOIN files f ON f.id = s.file_id
         LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id
        WHERE ${conditions.join(' AND ')}
        LIMIT ?`,
    )
    .all(...params) as RawCallerRow[];
}

function queryImporters(
  db: Database.Database,
  fileIds: number[],
  branch: string | undefined,
  limit: number,
): RawImporterRow[] {
  if (fileIds.length === 0) return [];
  const placeholders = fileIds.map(() => '?').join(', ');
  const conditions = [`fi.resolved_id IN (${placeholders})`];
  const params: Array<string | number> = [...fileIds];
  if (branch !== undefined) {
    conditions.push('f.branch = ?');
    params.push(branch);
  }
  params.push(limit);

  return db
    .prepare(
      `SELECT fi.file_id,
              f.path AS file_path,
              fi.raw_import
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
        WHERE ${conditions.join(' AND ')}
        LIMIT ?`,
    )
    .all(...params) as RawImporterRow[];
}

function querySubclasses(
  db: Database.Database,
  symbolIds: number[],
  branch: string | undefined,
  limit: number,
): RawSubclassRow[] {
  if (symbolIds.length === 0) return [];
  const placeholders = symbolIds.map(() => '?').join(', ');
  const conditions = [
    `rel.target_symbol_id IN (${placeholders})`,
    "rel.relationship_type IN ('extends', 'implements')",
  ];
  const params: Array<string | number> = [...symbolIds];
  if (branch !== undefined) {
    conditions.push('f.branch = ?');
    params.push(branch);
  }
  params.push(limit);

  return db
    .prepare(
      `SELECT rel.source_symbol_id AS symbol_id,
              s.name AS symbol_name,
              s.kind AS symbol_kind,
              f.path AS file,
              rel.relationship_type,
              CASE WHEN rel.line IS NULL THEN NULL ELSE rel.line + 1 END AS line,
              CASE WHEN rel.character IS NULL THEN NULL ELSE rel.character + 1 END AS character,
              rel.resolution_method
         FROM symbol_relationships rel
         JOIN symbols s ON s.id = rel.source_symbol_id
         JOIN files f ON f.id = s.file_id
        WHERE ${conditions.join(' AND ')}
        LIMIT ?`,
    )
    .all(...params) as RawSubclassRow[];
}

function queryTypeReferences(
  db: Database.Database,
  symbolIds: number[],
  branch: string | undefined,
  limit: number,
): RawTypeRefRow[] {
  if (symbolIds.length === 0) return [];
  const placeholders = symbolIds.map(() => '?').join(', ');
  const conditions = [`tr.type_id IN (${placeholders})`];
  const params: Array<string | number> = [...symbolIds];
  if (branch !== undefined) {
    conditions.push('f.branch = ?');
    params.push(branch);
  }
  params.push(limit);

  return db
    .prepare(
      `SELECT tr.symbol_id,
              COALESCE(s.name, '') AS symbol_name,
              COALESCE(s.kind, '') AS symbol_kind,
              f.path AS file,
              tr.ref_kind,
              tr.ref_line + 1 AS line,
              CASE WHEN tr.ref_character IS NULL THEN NULL ELSE tr.ref_character + 1 END AS character,
              tr.resolution_method
         FROM type_refs tr
         JOIN files f ON f.id = tr.file_id
         LEFT JOIN symbols s ON s.id = tr.symbol_id
        WHERE ${conditions.join(' AND ')}
        LIMIT ?`,
    )
    .all(...params) as RawTypeRefRow[];
}

/** For kind="file", find all symbols defined in the given file(s) so we can query their callers. */
function getSymbolIdsInFiles(
  db: Database.Database,
  fileIds: number[],
  branch: string | undefined,
): number[] {
  if (fileIds.length === 0) return [];
  const placeholders = fileIds.map(() => '?').join(', ');
  const conditions = [`s.file_id IN (${placeholders})`];
  const params: Array<string | number> = [...fileIds];
  if (branch !== undefined) {
    conditions.push('f.branch = ?');
    params.push(branch);
  }

  const rows = db
    .prepare(
      `SELECT s.id
         FROM symbols s
         JOIN files f ON f.id = s.file_id
        WHERE ${conditions.join(' AND ')}`,
    )
    .all(...params) as Array<{ id: number }>;

  return rows.map((r) => r.id);
}

// ─── Compact helpers ──────────────────────────────────────────────────────────

function compactCaller(row: RawCallerRow): CompactCallerEntry {
  const entry: CompactCallerEntry = {
    caller_id: row.caller_id,
    caller_name: row.caller_name,
    caller_kind: row.caller_kind,
    caller_file: row.caller_file,
  };
  if (row.caller_parent_symbol_id != null) entry.caller_parent_symbol_id = row.caller_parent_symbol_id;
  if (row.enclosing_name != null) entry.caller_parent_name = row.enclosing_name;
  return entry;
}

function fullCaller(row: RawCallerRow): CallerEntry {
  const entry: CallerEntry = {
    caller_id: row.caller_id,
    caller_name: row.caller_name,
    caller_kind: row.caller_kind,
    caller_file: row.caller_file,
    line: row.line,
    character: row.character,
    resolution_method: row.resolution_method,
  };
  if (row.caller_parent_symbol_id != null) entry.caller_parent_symbol_id = row.caller_parent_symbol_id;
  if (row.enclosing_name != null) entry.caller_parent_name = row.enclosing_name;
  return entry;
}

function compactImporter(row: RawImporterRow): CompactImporterEntry {
  return {
    file_id: row.file_id,
    file_path: row.file_path,
  };
}

function compactSubclass(row: RawSubclassRow): CompactSubclassEntry {
  return {
    symbol_id: row.symbol_id,
    symbol_name: row.symbol_name,
    symbol_kind: row.symbol_kind,
    file: row.file,
    relationship_type: row.relationship_type,
  };
}

function compactTypeRef(row: RawTypeRefRow): CompactTypeRefEntry {
  return {
    symbol_id: row.symbol_id,
    symbol_name: row.symbol_name,
    symbol_kind: row.symbol_kind,
    file: row.file,
    ref_kind: row.ref_kind,
  };
}

// ─── Multi-hop expansion ──────────────────────────────────────────────────────

function expandCallers(
  db: Database.Database,
  seedIds: number[],
  branch: string | undefined,
  depth: number,
  limit: number,
): RawCallerRow[] {
  if (seedIds.length === 0) return [];

  const seedPlaceholders = seedIds.map(() => '(?)').join(', ');
  const params: Array<string | number> = [...seedIds];

  // Branch filter applied in recursive step (filter callers by their file's branch)
  const recursiveBranchJoin = branch !== undefined ? 'JOIN files f_r ON f_r.id = s_r.file_id' : '';
  const recursiveBranchCond = branch !== undefined ? 'AND f_r.branch = ?' : '';

  params.push(depth); // max depth for WHERE r.depth < ? (must come before branch in SQL)
  if (branch !== undefined) params.push(branch);

  // Branch filter applied in outer query
  const outerBranchCond = branch !== undefined ? 'AND f.branch = ?' : '';
  if (branch !== undefined) params.push(branch);

  params.push(limit);

  return db
    .prepare(
      `WITH RECURSIVE
         seeds(id) AS (VALUES ${seedPlaceholders}),
         reachable(symbol_id, depth) AS (
           SELECT id, 0 FROM seeds
           UNION
           SELECT sr.caller_id, r.depth + 1
             FROM reachable r
             JOIN symbol_refs sr ON sr.callee_id = r.symbol_id
             JOIN symbols s_r ON s_r.id = sr.caller_id
             ${recursiveBranchJoin}
            WHERE r.depth < ?
              ${recursiveBranchCond}
         )
       SELECT
         e.symbol_id AS caller_id,
         s.name AS caller_name,
         s.kind AS caller_kind,
         f.path AS caller_file,
         s.parent_symbol_id AS caller_parent_symbol_id,
         sp.name AS enclosing_name,
         MIN(sr.call_line) + 1 AS line,
         CASE WHEN MIN(sr.call_character) IS NULL THEN NULL ELSE MIN(sr.call_character) + 1 END AS character,
         MIN(sr.resolution_method) AS resolution_method
       FROM (SELECT symbol_id FROM reachable WHERE depth > 0 GROUP BY symbol_id) e
       JOIN symbols s ON s.id = e.symbol_id
       JOIN files f ON f.id = s.file_id
       LEFT JOIN symbols sp ON sp.id = s.parent_symbol_id
       JOIN symbol_refs sr ON sr.caller_id = e.symbol_id
       WHERE 1=1 ${outerBranchCond}
       GROUP BY e.symbol_id, s.name, s.kind, f.path, s.parent_symbol_id, sp.name
       LIMIT ?`,
    )
    .all(...params) as RawCallerRow[];
}

function expandImporters(
  db: Database.Database,
  seedIds: number[],
  branch: string | undefined,
  depth: number,
  limit: number,
): RawImporterRow[] {
  if (seedIds.length === 0) return [];

  const seedPlaceholders = seedIds.map(() => '(?)').join(', ');
  const params: Array<string | number> = [...seedIds];

  // Branch filter applied in recursive step (filter importers by their file's branch)
  const recursiveBranchCond = branch !== undefined ? 'AND f_r.branch = ?' : '';

  params.push(depth); // max depth for WHERE r.depth < ? (must come before branch in SQL)
  if (branch !== undefined) params.push(branch);

  // Branch filter applied in outer query
  const outerBranchCond = branch !== undefined ? 'AND f.branch = ?' : '';
  if (branch !== undefined) params.push(branch);

  params.push(limit);

  return db
    .prepare(
      `WITH RECURSIVE
         seeds(id) AS (VALUES ${seedPlaceholders}),
         reachable(file_id, depth) AS (
           SELECT id, 0 FROM seeds
           UNION
           SELECT fi.file_id, r.depth + 1
             FROM reachable r
             JOIN file_imports fi ON fi.resolved_id = r.file_id
             JOIN files f_r ON f_r.id = fi.file_id
            WHERE r.depth < ?
              ${recursiveBranchCond}
         )
       SELECT
         e.file_id,
         f.path AS file_path,
         MIN(fi.raw_import) AS raw_import
       FROM (SELECT file_id FROM reachable WHERE depth > 0 GROUP BY file_id) e
       JOIN files f ON f.id = e.file_id
       JOIN file_imports fi ON fi.file_id = e.file_id
       WHERE 1=1 ${outerBranchCond}
       GROUP BY e.file_id, f.path
       LIMIT ?`,
    )
    .all(...params) as RawImporterRow[];
}

function expandSubclasses(
  db: Database.Database,
  seedIds: number[],
  branch: string | undefined,
  depth: number,
  limit: number,
): RawSubclassRow[] {
  if (seedIds.length === 0) return [];

  const seedPlaceholders = seedIds.map(() => '(?)').join(', ');
  const params: Array<string | number> = [...seedIds];

  // Branch filter applied in recursive step (filter subclasses by their file's branch)
  const recursiveBranchJoin = branch !== undefined ? 'JOIN files f_r ON f_r.id = s_r.file_id' : '';
  const recursiveBranchCond = branch !== undefined ? 'AND f_r.branch = ?' : '';

  params.push(depth); // max depth for WHERE r.depth < ? (must come before branch in SQL)
  if (branch !== undefined) params.push(branch);

  // Branch filter applied in outer query
  const outerBranchCond = branch !== undefined ? 'AND f.branch = ?' : '';
  if (branch !== undefined) params.push(branch);

  params.push(limit);

  return db
    .prepare(
      `WITH RECURSIVE
         seeds(id) AS (VALUES ${seedPlaceholders}),
         reachable(symbol_id, depth) AS (
           SELECT id, 0 FROM seeds
           UNION
           SELECT rel.source_symbol_id, r.depth + 1
             FROM reachable r
             JOIN symbol_relationships rel ON rel.target_symbol_id = r.symbol_id
             JOIN symbols s_r ON s_r.id = rel.source_symbol_id
             ${recursiveBranchJoin}
            WHERE r.depth < ?
              AND rel.relationship_type IN ('extends', 'implements')
              ${recursiveBranchCond}
         )
       SELECT
         e.symbol_id,
         s.name AS symbol_name,
         s.kind AS symbol_kind,
         f.path AS file,
         MIN(rel.relationship_type) AS relationship_type,
         CASE WHEN MIN(rel.line) IS NULL THEN NULL ELSE MIN(rel.line) + 1 END AS line,
         CASE WHEN MIN(rel.character) IS NULL THEN NULL ELSE MIN(rel.character) + 1 END AS character,
         MIN(rel.resolution_method) AS resolution_method
       FROM (SELECT symbol_id FROM reachable WHERE depth > 0 GROUP BY symbol_id) e
       JOIN symbols s ON s.id = e.symbol_id
       JOIN files f ON f.id = s.file_id
       JOIN symbol_relationships rel ON rel.source_symbol_id = e.symbol_id
       WHERE rel.relationship_type IN ('extends', 'implements') ${outerBranchCond}
       GROUP BY e.symbol_id, s.name, s.kind, f.path
       LIMIT ?`,
    )
    .all(...params) as RawSubclassRow[];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const INTERNAL_LIMIT = 1000;

/** Unified reverse-dependency / blast-radius query. */
export function handler(
  db: Database.Database,
  args: DependentsArgs,
): DependentsResult {
  const depth = 5;
  const compact = args.compact ?? false;
  const limit = INTERNAL_LIMIT;

  if (args.kind === 'file') {
    return handleFileDependents(db, args, depth, compact, limit);
  }
  return handleSymbolDependents(db, args, depth, compact, limit);
}

function handleFileDependents(
  db: Database.Database,
  args: DependentsArgs,
  depth: number,
  compact: boolean,
  limit: number,
): DependentsResult {
  const file = getFileByPath(db, args.query, args.branch);
  if (!file) {
    throw new Error(`No file found matching path "${args.query}"`);
  }

  const target: DependentTarget = {
    id: file.id,
    name: file.path,
    kind: 'file',
    file: file.path,
  };

  // Get importers of this file
  const importerRows = expandImporters(db, [file.id], args.branch, depth, limit);

  // Get symbols defined in this file, then find callers from other files
  const symbolIds = getSymbolIdsInFiles(db, [file.id], args.branch);
  const callerRows = expandCallers(db, symbolIds, args.branch, depth, limit)
    // Exclude callers that are within the same file
    .filter((row) => row.caller_file !== file.path);

  // For files, subclasses and type_references target symbols within the file
  const subclassRows = expandSubclasses(db, symbolIds, args.branch, depth, limit);
  const typeRefRows = queryTypeReferences(db, symbolIds, args.branch, limit);

  return buildResult(target, callerRows, importerRows, subclassRows, typeRefRows, compact, depth);
}

function handleSymbolDependents(
  db: Database.Database,
  args: DependentsArgs,
  depth: number,
  compact: boolean,
  limit: number,
): DependentsResult {
  const symbols = getSymbolsByName(db, args.query, {
    branch: args.branch,
    matchMode: 'exact',
  });

  if (symbols.length === 0) {
    throw new Error(`No symbol found matching name "${args.query}"`);
  }

  // If multiple symbols share the same name, report ambiguity instead of
  // silently aggregating dependents across different symbols.
  if (symbols.length > 1) {
    const candidates = symbols.slice(0, 10).map((s) => {
      const file = getFileById(db, s.file_id, args.branch);
      return { id: s.id, name: s.name, kind: s.kind, file: file?.path ?? '' };
    });
    throw new Error(
      `Ambiguous: ${symbols.length} symbols match "${args.query}". Results would aggregate dependents across all matches which can be misleading. Narrow your query or specify a file path to disambiguate. Candidates: ${JSON.stringify(candidates)}`,
    );
  }

  const primarySymbol = symbols[0]!;
  const primaryFile = getFileById(db, primarySymbol.file_id, args.branch);

  const target: DependentTarget = {
    id: primarySymbol.id,
    name: primarySymbol.name,
    kind: primarySymbol.kind,
    file: primaryFile?.path,
  };

  const callerRows = expandCallers(db, [primarySymbol.id], args.branch, depth, limit);
  const subclassRows = expandSubclasses(db, [primarySymbol.id], args.branch, depth, limit);
  const typeRefRows = queryTypeReferences(db, [primarySymbol.id], args.branch, limit);

  // For symbols, importers are files that import the file containing this symbol
  const importerRows = expandImporters(db, [primarySymbol.file_id], args.branch, depth, limit);

  return buildResult(target, callerRows, importerRows, subclassRows, typeRefRows, compact, depth);
}

function buildResult(
  target: DependentTarget,
  callerRows: RawCallerRow[],
  importerRows: RawImporterRow[],
  subclassRows: RawSubclassRow[],
  typeRefRows: RawTypeRefRow[],
  compact: boolean,
  depth: number,
): DependentsResult {
  const callers = compact ? callerRows.map(compactCaller) : callerRows.map(fullCaller);
  const importers = compact ? importerRows.map(compactImporter) : importerRows;
  const subclasses = compact ? subclassRows.map(compactSubclass) : subclassRows;
  const typeRefs = compact ? typeRefRows.map(compactTypeRef) : typeRefRows;

  const total = callers.length + importers.length + subclasses.length + typeRefs.length;
  return {
    target,
    dependents: {
      callers,
      importers,
      subclasses,
      type_references: typeRefs,
    },
    depth_used: depth,
    total_count: total,
    truncated: total >= INTERNAL_LIMIT,
  };
}
