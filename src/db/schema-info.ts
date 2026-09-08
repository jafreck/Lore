import type Database from 'better-sqlite3';

/** Version of the on-disk schema emitted by this Lore build. */
export const CURRENT_LORE_SCHEMA_VERSION = 3;
export const LORE_META_SCHEMA_VERSION = 'schema_version';

export type LoreSchemaStatus = 'current' | 'outdated' | 'newer' | 'missing';

export interface LoreSchemaInspection {
  status: LoreSchemaStatus;
  version: number | null;
  requiredVersion: number;
  missing: string[];
}

export interface LoreSchemaVersionMarkers {
  loreMeta: number | null;
  userVersion: number | null;
  effective: number | null;
}

export class LoreSchemaCompatibilityError extends Error {
  readonly inspection: LoreSchemaInspection;

  constructor(inspection: LoreSchemaInspection, consumer = 'Lore') {
    const detail = inspection.status === 'newer'
      ? `database schema version ${inspection.version} is newer than supported version ${inspection.requiredVersion}`
      : inspection.status === 'missing'
        ? 'database does not contain a Lore schema'
        : `database schema is outdated or incomplete (found ${inspection.version ?? 'unversioned'}, required ${inspection.requiredVersion})`;
    super(`${consumer} cannot use this database: ${detail}`);
    this.name = 'LoreSchemaCompatibilityError';
    this.inspection = inspection;
  }
}

/**
 * Columns required by the read-only index-health queries. Keeping this list
 * explicit lets doctor inspect old databases without preparing incompatible
 * SQL or invoking the mutating schema initializer.
 */
const VALIDATION_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  files: ['id', 'path', 'branch', 'language', 'source', 'indexed_at', 'layer', 'generation'],
  symbols: [
    'id', 'file_id', 'name', 'kind', 'start_line', 'start_character', 'end_line',
    'end_character', 'selection_line', 'selection_character', 'signature', 'parent_symbol_id',
  ],
  symbol_refs: [
    'id', 'file_id', 'callee_id', 'callee_name', 'call_line', 'call_character',
    'resolution_method', 'definition_path',
  ],
  type_refs: [
    'id', 'file_id', 'type_id', 'type_name', 'type_name_bare', 'ref_line',
    'ref_character', 'resolution_method', 'definition_path',
  ],
  symbol_relationships: [
    'id', 'file_id', 'target_symbol_id', 'target_symbol_name', 'line', 'character',
    'resolution_method', 'definition_path',
  ],
  file_imports: ['id', 'file_id', 'raw_import', 'resolved_id', 'resolution_method'],
  external_deps: ['file_id', 'package'],
  lore_meta: ['key', 'value'],
  baseline_generations: ['branch', 'generation'],
  index_runs: [
    'id', 'mode', 'root_dir', 'branch', 'layer', 'generation', 'started_at',
    'completed_at', 'status', 'fallback_degraded', 'error', 'config_json',
  ],
  indexer_runs: [
    'id', 'run_id', 'provider', 'indexer', 'languages_json', 'status', 'attempted',
    'fallback', 'files', 'symbols', 'call_refs', 'type_refs', 'imports', 'message',
    'details_json',
  ],
  effective_files: ['id', 'path', 'branch', 'language', 'source', 'indexed_at', 'layer', 'generation'],
  effective_symbols: ['id', 'file_id', 'name', 'kind', 'start_line', 'end_line'],
  effective_symbol_refs: ['id', 'file_id', 'callee_id', 'resolution_method'],
  effective_type_refs: ['id', 'file_id', 'type_id', 'resolution_method'],
  effective_symbol_relationships: ['id', 'file_id', 'target_symbol_id', 'resolution_method'],
  effective_file_imports: ['id', 'file_id', 'raw_import', 'resolved_id', 'resolution_method'],
  effective_symbol_metrics: ['symbol_id', 'line_count', 'param_count', 'cyclomatic', 'max_nesting'],
};

/** Inspect schema capabilities using only SQLite metadata reads. */
export function inspectLoreSchema(db: Database.Database): LoreSchemaInspection {
  const objects = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const markers = readLoreSchemaVersionMarkers(db);
  const version = markers.effective;
  if (version !== null && version > CURRENT_LORE_SCHEMA_VERSION) {
    return {
      status: 'newer',
      version,
      requiredVersion: CURRENT_LORE_SCHEMA_VERSION,
      missing: [],
    };
  }
  const hasLoreCore = objects.has('files') || objects.has('symbols') || objects.has('lore_meta');
  if (!hasLoreCore) {
    return {
      status: 'missing',
      version,
      requiredVersion: CURRENT_LORE_SCHEMA_VERSION,
      missing: ['table:files', 'table:symbols'],
    };
  }

  const missing: string[] = [];
  if (markers.loreMeta !== null && markers.userVersion !== null
    && markers.loreMeta !== markers.userVersion) {
    missing.push(
      `schema-version-marker-mismatch:lore_meta=${markers.loreMeta},user_version=${markers.userVersion}`,
    );
  }
  for (const [table, requiredColumns] of Object.entries(VALIDATION_SCHEMA)) {
    if (!objects.has(table)) {
      missing.push(`table:${table}`);
      continue;
    }
    let columns: Set<string>;
    try {
      columns = tableColumns(db, table);
    } catch {
      missing.push(`object:${table}:unreadable`);
      continue;
    }
    for (const column of requiredColumns) {
      if (!columns.has(column)) missing.push(`column:${table}.${column}`);
    }
  }

  return {
    status: missing.length === 0 && version === CURRENT_LORE_SCHEMA_VERSION
      ? 'current'
      : 'outdated',
    version,
    requiredVersion: CURRENT_LORE_SCHEMA_VERSION,
    missing,
  };
}

/** Throw unless a database is exactly compatible with this Lore build. */
export function assertLoreSchemaCompatible(
  db: Database.Database,
  consumer = 'Lore',
): LoreSchemaInspection {
  const inspection = inspectLoreSchema(db);
  if (inspection.status !== 'current') {
    throw new LoreSchemaCompatibilityError(inspection, consumer);
  }
  return inspection;
}

/** Read both independent schema markers without mutating the connection. */
export function readLoreSchemaVersionMarkers(
  db: Database.Database,
): LoreSchemaVersionMarkers {
  const objects = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  let loreMeta: number | null = null;
  if (objects.has('lore_meta')) {
    try {
      const columns = tableColumns(db, 'lore_meta');
      if (columns.has('key') && columns.has('value')) {
        const row = db.prepare('SELECT value FROM lore_meta WHERE key = ?').get(LORE_META_SCHEMA_VERSION) as
          | { value: string }
          | undefined;
        loreMeta = parseVersion(row?.value);
      }
    } catch {
      loreMeta = null;
    }
  }

  let userVersion: number | null = null;
  try {
    const rows = db.pragma('user_version') as Array<{ user_version: number }>;
    const value = rows[0]?.user_version;
    userVersion = Number.isInteger(value) && value! > 0 ? value! : null;
  } catch {
    userVersion = null;
  }
  const present = [loreMeta, userVersion].filter((value): value is number => value !== null);
  return {
    loreMeta,
    userVersion,
    effective: present.length > 0 ? Math.max(...present) : null,
  };
}

export function tableHasColumns(
  db: Database.Database,
  table: string,
  requiredColumns: readonly string[],
): boolean {
  const exists = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE name = ? AND type IN ('table', 'view') LIMIT 1",
  ).get(table);
  if (!exists) return false;
  try {
    const columns = tableColumns(db, table);
    return requiredColumns.every((column) => columns.has(column));
  } catch {
    return false;
  }
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  // The table names passed here are internal constants, not user input.
  return new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
}

function parseVersion(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function quoteIdentifier(identifier: string): string {
  return `'${identifier.replace(/'/gu, "''")}'`;
}
