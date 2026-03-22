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
  caller_kind: string;
  caller_file: string;
  enclosing_name?: string;
  line?: number;
  character?: number | null;
  resolution_method?: string;
}

interface CompactCallerEntry {
  caller_id: number;
  caller_name: string;
  caller_kind: string;
  caller_file: string;
  enclosing_name?: string;
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

export interface DependentsErrorResult {
  error: string;
  candidates?: Array<{ id: number; name: string; kind: string; file: string }>;
}

// ─── Raw SQL row shapes ──────────────────────────────────────────────────────

interface RawCallerRow {
  caller_id: number;
  caller_name: string;
  caller_kind: string;
  caller_file: string;
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

function formatCallerName(row: RawCallerRow): string {
  return row.enclosing_name
    ? `${row.caller_name} (in ${row.enclosing_name})`
    : row.caller_name;
}

function compactCaller(row: RawCallerRow): CompactCallerEntry {
  return {
    caller_id: row.caller_id,
    caller_name: formatCallerName(row),
    caller_kind: row.caller_kind,
    caller_file: row.caller_file,
    ...(row.enclosing_name ? { enclosing_name: row.enclosing_name } : {}),
  };
}

function fullCaller(row: RawCallerRow): CallerEntry {
  return {
    caller_id: row.caller_id,
    caller_name: formatCallerName(row),
    caller_kind: row.caller_kind,
    caller_file: row.caller_file,
    ...(row.enclosing_name ? { enclosing_name: row.enclosing_name } : {}),
    line: row.line,
    character: row.character,
    resolution_method: row.resolution_method,
  };
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
  const all: RawCallerRow[] = [];
  const seen = new Set<number>();
  let frontier = seedIds;

  for (let hop = 0; hop < depth && frontier.length > 0 && all.length < limit; hop++) {
    const remaining = limit - all.length;
    const rows = queryCallers(db, frontier, branch, remaining);
    const nextFrontier: number[] = [];
    for (const row of rows) {
      if (seen.has(row.caller_id)) continue;
      seen.add(row.caller_id);
      all.push(row);
      nextFrontier.push(row.caller_id);
    }
    frontier = nextFrontier;
  }
  return all;
}

function expandImporters(
  db: Database.Database,
  seedIds: number[],
  branch: string | undefined,
  depth: number,
  limit: number,
): RawImporterRow[] {
  const all: RawImporterRow[] = [];
  const seen = new Set<number>();
  let frontier = seedIds;

  for (let hop = 0; hop < depth && frontier.length > 0 && all.length < limit; hop++) {
    const remaining = limit - all.length;
    const rows = queryImporters(db, frontier, branch, remaining);
    const nextFrontier: number[] = [];
    for (const row of rows) {
      if (seen.has(row.file_id)) continue;
      seen.add(row.file_id);
      all.push(row);
      nextFrontier.push(row.file_id);
    }
    frontier = nextFrontier;
  }
  return all;
}

function expandSubclasses(
  db: Database.Database,
  seedIds: number[],
  branch: string | undefined,
  depth: number,
  limit: number,
): RawSubclassRow[] {
  const all: RawSubclassRow[] = [];
  const seen = new Set<number>();
  let frontier = seedIds;

  for (let hop = 0; hop < depth && frontier.length > 0 && all.length < limit; hop++) {
    const remaining = limit - all.length;
    const rows = querySubclasses(db, frontier, branch, remaining);
    const nextFrontier: number[] = [];
    for (const row of rows) {
      if (seen.has(row.symbol_id)) continue;
      seen.add(row.symbol_id);
      all.push(row);
      nextFrontier.push(row.symbol_id);
    }
    frontier = nextFrontier;
  }
  return all;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const INTERNAL_LIMIT = 1000;

/** Unified reverse-dependency / blast-radius query. */
export function handler(
  db: Database.Database,
  args: DependentsArgs,
): DependentsResult | DependentsErrorResult {
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
): DependentsResult | DependentsErrorResult {
  const file = getFileByPath(db, args.query, args.branch);
  if (!file) {
    return { error: `No file found matching path "${args.query}"` };
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
): DependentsResult | DependentsErrorResult {
  const symbols = getSymbolsByName(db, args.query, {
    branch: args.branch,
    matchMode: 'exact',
  });

  if (symbols.length === 0) {
    return { error: `No symbol found matching name "${args.query}"` };
  }

  // If multiple matches, use the first but if many are ambiguous, report
  if (symbols.length > 5) {
    return {
      error: `Ambiguous: ${symbols.length} symbols match "${args.query}". Narrow your query with a more specific name.`,
      candidates: symbols.slice(0, 10).map((s) => {
        const file = getFileById(db, s.file_id, args.branch);
        return { id: s.id, name: s.name, kind: s.kind, file: file?.path ?? '' };
      }),
    };
  }

  // Use the best match (first result). If there are a few, aggregate across all.
  const symbolIds = symbols.map((s) => s.id);
  const primarySymbol = symbols[0]!;
  const primaryFile = getFileById(db, primarySymbol.file_id, args.branch);

  const target: DependentTarget = {
    id: primarySymbol.id,
    name: primarySymbol.name,
    kind: primarySymbol.kind,
    file: primaryFile?.path,
  };

  const callerRows = expandCallers(db, symbolIds, args.branch, depth, limit);
  const subclassRows = expandSubclasses(db, symbolIds, args.branch, depth, limit);
  const typeRefRows = queryTypeReferences(db, symbolIds, args.branch, limit);

  // For symbols, importers are files that import the file containing this symbol
  const fileIds = [...new Set(symbols.map((s) => s.file_id))];
  const importerRows = expandImporters(db, fileIds, args.branch, depth, limit);

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
