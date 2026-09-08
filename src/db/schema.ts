/**
 * @module indexer/db
 *
 * Opens (or creates) a SQLite knowledge-base database and ensures all
 * required tables exist.  Vector embedding tables (vec0 virtual tables)
 * are created separately via `createVec0Tables()` once the embedding
 * dimensions are known.
 */

import Database from 'better-sqlite3';
import { resetEffectiveViewsCache } from './read-only.js';
import {
  assertLoreSchemaCompatible,
  CURRENT_LORE_SCHEMA_VERSION,
  inspectLoreSchema,
  LORE_META_SCHEMA_VERSION,
  LoreSchemaCompatibilityError,
  readLoreSchemaVersionMarkers,
} from './schema-info.js';

// Re-export the Database type so callers don't need to import better-sqlite3.
export type { Database };

// Re-export everything from submodules for backward compatibility.
export * from './meta.js';
export * from './index-runs.js';
export * from './schema-info.js';
export { createVec0Tables } from './vec.js';

// ─── DDL ─────────────────────────────────────────────────────────────────────

const DDL = `
-- Indexed source files.
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL,
  branch      TEXT    NOT NULL DEFAULT '',
  language    TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  last_hash   TEXT,
  source      TEXT    NOT NULL DEFAULT '',
  indexed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(path, branch, layer, generation)
);

-- Named symbols extracted from source files.
CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  start_line  INTEGER NOT NULL,
  start_character INTEGER,
  end_line    INTEGER NOT NULL,
  end_character INTEGER,
  selection_line INTEGER,
  selection_character INTEGER,
  signature   TEXT,
  doc_comment TEXT,
  resolved_type_signature TEXT,
  resolved_return_type TEXT,
  definition_uri TEXT,
  definition_path TEXT,
  is_exported INTEGER NOT NULL DEFAULT 0,
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0
);

-- File-linked annotations extracted from comments (e.g. TODO/FIXME/NOTE).
CREATE TABLE IF NOT EXISTS annotations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  line        INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  symbol_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  author      TEXT,
  created_at  INTEGER,
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0
);

-- Import / use declarations found in source files.
CREATE TABLE IF NOT EXISTS file_imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_import  TEXT    NOT NULL,
  resolved_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  resolution_method TEXT NOT NULL DEFAULT 'unresolved',
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0
);

-- Call-site references from one symbol to another.
CREATE TABLE IF NOT EXISTS symbol_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  file_id     INTEGER REFERENCES files(id) ON DELETE CASCADE,
  callee_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  callee_name TEXT    NOT NULL,
  call_line   INTEGER NOT NULL,
  call_character INTEGER,
  call_kind   TEXT    NOT NULL DEFAULT 'direct',
  resolved_type_signature TEXT,
  resolved_return_type TEXT,
  definition_uri TEXT,
  definition_path TEXT,
  definition_line INTEGER,
  definition_character INTEGER,
  resolution_method TEXT NOT NULL DEFAULT 'unresolved',
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0
);

-- Semantic relationships between symbols (extends, implements, etc.).
CREATE TABLE IF NOT EXISTS symbol_relationships (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id            INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_symbol_id   INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_symbol_name TEXT    NOT NULL,
  relationship_type  TEXT    NOT NULL,
  line               INTEGER,
  character          INTEGER,
  definition_uri     TEXT,
  definition_path    TEXT,
  definition_line    INTEGER,
  definition_character INTEGER,
  resolution_method  TEXT NOT NULL DEFAULT 'unresolved',
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_symbol_rels_source ON symbol_relationships(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbol_rels_target ON symbol_relationships(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbol_rels_type ON symbol_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_symbol_rels_file_id ON symbol_relationships(file_id);
CREATE INDEX IF NOT EXISTS idx_symbol_rels_resolution_method ON symbol_relationships(resolution_method);

-- Type-usage references from symbols to type definitions.
CREATE TABLE IF NOT EXISTS type_refs (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id                 INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id               INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  type_id                 INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  type_name               TEXT    NOT NULL,
  type_name_bare          TEXT    NOT NULL,
  ref_kind                TEXT    NOT NULL DEFAULT 'other',
  ref_line                INTEGER NOT NULL,
  ref_character           INTEGER,
  resolved_type_signature TEXT,
  definition_uri          TEXT,
  definition_path         TEXT,
  definition_line         INTEGER,
  definition_character    INTEGER,
  resolution_method       TEXT NOT NULL DEFAULT 'unresolved',
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_type_refs_type_name ON type_refs(type_name);
CREATE INDEX IF NOT EXISTS idx_type_refs_type_name_bare ON type_refs(type_name_bare);
CREATE INDEX IF NOT EXISTS idx_type_refs_symbol_id ON type_refs(symbol_id);
CREATE INDEX IF NOT EXISTS idx_type_refs_file_id ON type_refs(file_id);
CREATE INDEX IF NOT EXISTS idx_type_refs_type_id ON type_refs(type_id);

-- External (third-party / stdlib) dependencies inferred from imports.
CREATE TABLE IF NOT EXISTS external_deps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  package     TEXT    NOT NULL,
  version     TEXT,
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(file_id, package)
);

-- Optional external symbol rows. The active pipeline does not populate this table.
CREATE TABLE IF NOT EXISTS external_symbols (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  dependency_ecosystem TEXT    NOT NULL DEFAULT 'npm',
  source_type          TEXT    NOT NULL DEFAULT 'declaration',
  source_ref           TEXT    NOT NULL DEFAULT '',
  package_name         TEXT    NOT NULL,
  package_version      TEXT,
  symbol_name          TEXT    NOT NULL,
  symbol_kind          TEXT    NOT NULL,
  signature            TEXT    NOT NULL DEFAULT '',
  doc_comment          TEXT,
  resolved_type_signature TEXT,
  resolved_return_type TEXT,
  definition_uri       TEXT,
  definition_path      TEXT,
  UNIQUE(dependency_ecosystem, package_name, package_version, symbol_name, symbol_kind, signature)
);

-- Logical modules grouping related files (e.g. Rust crates, Python packages).
CREATE TABLE IF NOT EXISTS modules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL,
  manifest    TEXT
);

-- Many-to-many mapping between files and modules.
CREATE TABLE IF NOT EXISTS file_modules (
  file_id   INTEGER NOT NULL REFERENCES files(id)   ON DELETE CASCADE,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, module_id)
);

-- LLM-generated natural-language summaries for symbols.
CREATE TABLE IF NOT EXISTS symbol_summaries (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  summary   TEXT    NOT NULL,
  model     TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Per-symbol complexity metrics.
CREATE TABLE IF NOT EXISTS symbol_metrics (
  symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  line_count  INTEGER NOT NULL,
  param_count INTEGER NOT NULL,
  cyclomatic  INTEGER NOT NULL,
  max_nesting INTEGER NOT NULL,
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_symbol_metrics_cyclomatic ON symbol_metrics(cyclomatic);

-- Key-value store for knowledge-base metadata (schema version, embedding model, etc.).
CREATE TABLE IF NOT EXISTS lore_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The baseline generation currently visible to readers, scoped by branch.
-- New baseline generations are populated while hidden; a short promotion
-- transaction changes this pointer after the complete candidate succeeds.
CREATE TABLE IF NOT EXISTS baseline_generations (
  branch     TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
);

-- One row per full build, overlay update, or baseline reconciliation.
CREATE TABLE IF NOT EXISTS index_runs (
  id                TEXT PRIMARY KEY,
  mode              TEXT NOT NULL,
  root_dir          TEXT NOT NULL,
  branch            TEXT NOT NULL DEFAULT '',
  layer             TEXT NOT NULL,
  generation        INTEGER NOT NULL DEFAULT 0,
  started_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at      INTEGER,
  status            TEXT NOT NULL DEFAULT 'running',
  fallback_degraded INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  config_json       TEXT
);

-- Attempt/success/failure provenance for structural providers used in a run.
CREATE TABLE IF NOT EXISTS indexer_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  indexer        TEXT NOT NULL,
  languages_json TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL,
  attempted      INTEGER NOT NULL DEFAULT 0,
  fallback       INTEGER NOT NULL DEFAULT 0,
  files          INTEGER,
  symbols        INTEGER,
  call_refs      INTEGER,
  type_refs      INTEGER,
  imports        INTEGER,
  started_at     INTEGER,
  completed_at   INTEGER,
  message        TEXT,
  details_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_index_runs_started_at ON index_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_index_runs_branch ON index_runs(branch, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_indexer_runs_run_id ON indexer_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_indexer_runs_status ON indexer_runs(status);

-- Full-text search index over symbol names, signatures, and kinds (BM25 via FTS5).
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, signature, kind
);

-- Git commit metadata.
CREATE TABLE IF NOT EXISTS commits (
  sha         TEXT    PRIMARY KEY,
  author      TEXT    NOT NULL,
  author_email TEXT   NOT NULL,
  timestamp   INTEGER NOT NULL,
  message     TEXT    NOT NULL,
  parents     TEXT    NOT NULL DEFAULT '[]'
);

-- Files touched by each commit (with diff stats).
CREATE TABLE IF NOT EXISTS commit_files (
  commit_sha  TEXT    NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  file_path   TEXT    NOT NULL,
  change_type TEXT    NOT NULL,
  insertions  INTEGER,
  deletions   INTEGER,
  PRIMARY KEY (commit_sha, file_path)
);

CREATE TABLE IF NOT EXISTS commit_refs (
  commit_sha  TEXT    NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  ref_name    TEXT    NOT NULL,
  ref_type    TEXT    NOT NULL,
  PRIMARY KEY (commit_sha, ref_name)
);

CREATE INDEX IF NOT EXISTS idx_commit_files_file_path ON commit_files(file_path);
CREATE INDEX IF NOT EXISTS idx_commit_refs_ref_name ON commit_refs(ref_name);

CREATE INDEX IF NOT EXISTS idx_annotations_kind ON annotations(kind);
CREATE INDEX IF NOT EXISTS idx_annotations_file_id ON annotations(file_id);
CREATE INDEX IF NOT EXISTS idx_external_symbols_dependency_ecosystem ON external_symbols(dependency_ecosystem);
CREATE INDEX IF NOT EXISTS idx_external_symbols_package_name ON external_symbols(package_name);
CREATE INDEX IF NOT EXISTS idx_external_symbols_symbol_name ON external_symbols(symbol_name);
CREATE INDEX IF NOT EXISTS idx_symbols_file_id ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_definition_path ON symbols(definition_path);
CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported) WHERE is_exported = 1;
CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_symbol_id);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_definition_path ON symbol_refs(definition_path);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_file_id ON symbol_refs(file_id);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_resolution_method ON symbol_refs(resolution_method);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_callee_id ON symbol_refs(callee_id);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_caller_callee ON symbol_refs(caller_id, callee_id, call_line);
CREATE INDEX IF NOT EXISTS idx_type_refs_resolution_method ON type_refs(resolution_method);
CREATE INDEX IF NOT EXISTS idx_external_symbols_definition_path ON external_symbols(definition_path);
CREATE INDEX IF NOT EXISTS idx_files_layer ON files(layer);
CREATE INDEX IF NOT EXISTS idx_files_layer_path ON files(layer, path);
CREATE INDEX IF NOT EXISTS idx_symbols_layer ON symbols(layer);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_layer ON symbol_refs(layer);
CREATE INDEX IF NOT EXISTS idx_type_refs_layer ON type_refs(layer);
CREATE INDEX IF NOT EXISTS idx_symbol_relationships_layer ON symbol_relationships(layer);

-- ─── Incremental indexing: new tables ──────────────────────────────────────────

-- Tracks files with active overlay data.
CREATE TABLE IF NOT EXISTS dirty_files (
  path        TEXT NOT NULL,
  branch      TEXT NOT NULL DEFAULT '',
  dirty_since INTEGER NOT NULL DEFAULT (unixepoch()),
  overlay_gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (path, branch)
);
CREATE INDEX IF NOT EXISTS idx_dirty_files_path ON dirty_files(path);
CREATE INDEX IF NOT EXISTS idx_dirty_files_branch ON dirty_files(branch);

-- Reverse dependency graph: "file X is depended on by file Y".
CREATE TABLE IF NOT EXISTS reverse_deps (
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dependent_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dep_kind     TEXT    NOT NULL DEFAULT 'import',
  PRIMARY KEY (file_id, dependent_id, dep_kind)
);
CREATE INDEX IF NOT EXISTS idx_reverse_deps_file ON reverse_deps(file_id);
CREATE INDEX IF NOT EXISTS idx_reverse_deps_dependent ON reverse_deps(dependent_id);
`;

const LEGACY_COLUMN_MIGRATIONS: ReadonlyArray<{
  table: string;
  column: string;
  definition: string;
}> = [
  { table: 'files', column: 'branch', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'files', column: 'size_bytes', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'files', column: 'last_hash', definition: 'TEXT' },
  { table: 'files', column: 'source', definition: "TEXT NOT NULL DEFAULT ''" },
  { table: 'files', column: 'indexed_at', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'files', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'files', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'symbols', column: 'start_character', definition: 'INTEGER' },
  { table: 'symbols', column: 'end_character', definition: 'INTEGER' },
  { table: 'symbols', column: 'selection_line', definition: 'INTEGER' },
  { table: 'symbols', column: 'selection_character', definition: 'INTEGER' },
  { table: 'symbols', column: 'signature', definition: 'TEXT' },
  { table: 'symbols', column: 'doc_comment', definition: 'TEXT' },
  { table: 'symbols', column: 'resolved_type_signature', definition: 'TEXT' },
  { table: 'symbols', column: 'resolved_return_type', definition: 'TEXT' },
  { table: 'symbols', column: 'definition_uri', definition: 'TEXT' },
  { table: 'symbols', column: 'definition_path', definition: 'TEXT' },
  { table: 'symbols', column: 'is_exported', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'symbols', column: 'parent_symbol_id', definition: 'INTEGER REFERENCES symbols(id) ON DELETE SET NULL' },
  { table: 'symbols', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'symbols', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'annotations', column: 'symbol_id', definition: 'INTEGER REFERENCES symbols(id) ON DELETE SET NULL' },
  { table: 'annotations', column: 'author', definition: 'TEXT' },
  { table: 'annotations', column: 'created_at', definition: 'INTEGER' },
  { table: 'annotations', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'annotations', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'file_imports', column: 'resolved_id', definition: 'INTEGER REFERENCES files(id) ON DELETE SET NULL' },
  { table: 'file_imports', column: 'resolution_method', definition: "TEXT NOT NULL DEFAULT 'unresolved'" },
  { table: 'file_imports', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'file_imports', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'symbol_refs', column: 'file_id', definition: 'INTEGER REFERENCES files(id) ON DELETE CASCADE' },
  { table: 'symbol_refs', column: 'call_character', definition: 'INTEGER' },
  { table: 'symbol_refs', column: 'call_kind', definition: "TEXT NOT NULL DEFAULT 'direct'" },
  { table: 'symbol_refs', column: 'resolved_type_signature', definition: 'TEXT' },
  { table: 'symbol_refs', column: 'resolved_return_type', definition: 'TEXT' },
  { table: 'symbol_refs', column: 'definition_uri', definition: 'TEXT' },
  { table: 'symbol_refs', column: 'definition_path', definition: 'TEXT' },
  { table: 'symbol_refs', column: 'definition_line', definition: 'INTEGER' },
  { table: 'symbol_refs', column: 'definition_character', definition: 'INTEGER' },
  { table: 'symbol_refs', column: 'resolution_method', definition: "TEXT NOT NULL DEFAULT 'unresolved'" },
  { table: 'symbol_refs', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'symbol_refs', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'symbol_relationships', column: 'character', definition: 'INTEGER' },
  { table: 'symbol_relationships', column: 'definition_uri', definition: 'TEXT' },
  { table: 'symbol_relationships', column: 'definition_path', definition: 'TEXT' },
  { table: 'symbol_relationships', column: 'definition_line', definition: 'INTEGER' },
  { table: 'symbol_relationships', column: 'definition_character', definition: 'INTEGER' },
  { table: 'symbol_relationships', column: 'resolution_method', definition: "TEXT NOT NULL DEFAULT 'unresolved'" },
  { table: 'symbol_relationships', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'symbol_relationships', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'type_refs', column: 'ref_kind', definition: "TEXT NOT NULL DEFAULT 'other'" },
  { table: 'type_refs', column: 'ref_character', definition: 'INTEGER' },
  { table: 'type_refs', column: 'resolved_type_signature', definition: 'TEXT' },
  { table: 'type_refs', column: 'definition_uri', definition: 'TEXT' },
  { table: 'type_refs', column: 'definition_path', definition: 'TEXT' },
  { table: 'type_refs', column: 'definition_line', definition: 'INTEGER' },
  { table: 'type_refs', column: 'definition_character', definition: 'INTEGER' },
  { table: 'type_refs', column: 'resolution_method', definition: "TEXT NOT NULL DEFAULT 'unresolved'" },
  { table: 'type_refs', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'type_refs', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'external_deps', column: 'version', definition: 'TEXT' },
  { table: 'external_deps', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'external_deps', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'external_symbols', column: 'resolved_type_signature', definition: 'TEXT' },
  { table: 'external_symbols', column: 'resolved_return_type', definition: 'TEXT' },
  { table: 'external_symbols', column: 'definition_uri', definition: 'TEXT' },
  { table: 'external_symbols', column: 'definition_path', definition: 'TEXT' },
  { table: 'symbol_metrics', column: 'layer', definition: "TEXT NOT NULL DEFAULT 'baseline'" },
  { table: 'symbol_metrics', column: 'generation', definition: 'INTEGER NOT NULL DEFAULT 0' },
];

interface LoreSchemaMigration {
  toVersion: number;
  migrate(db: Database.Database): void;
}

/** Ordered versions are exported for migration audits and tests. */
export const LORE_SCHEMA_MIGRATION_VERSIONS: readonly number[] = Object.freeze([1, 2, 3]);

const LORE_SCHEMA_MIGRATIONS: readonly LoreSchemaMigration[] = [
  {
    toVersion: 1,
    migrate(db) {
      db.transaction(() => {
        prepareLegacyTablesForCurrentDdl(db);
        db.exec(DDL);
      }).immediate();
    },
  },
  {
    toVersion: 2,
    migrate(db) {
      ensureIncrementalSchema(db);
    },
  },
  {
    toVersion: 3,
    migrate(db) {
      // Refresh generation-sensitive views for existing databases. Do not
      // infer a promotion pointer here: a row without one may be an
      // interrupted first candidate and must remain hidden.
      ensureIncrementalSchema(db, false);
    },
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Opens (or creates) the SQLite database at `path` and initialises the schema.
 *
 * The returned `Database` instance is opened with WAL mode enabled for
 * better concurrent read performance.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  try {
    // This check is deliberately before WAL mode or any other mutating pragma.
    // Consult both markers so a stale lore_meta value cannot mask a newer
    // SQLite user_version (or vice versa).
    const markers = readLoreSchemaVersionMarkers(db);
    if (markers.effective !== null && markers.effective > CURRENT_LORE_SCHEMA_VERSION) {
      throw new LoreSchemaCompatibilityError({
        status: 'newer',
        version: markers.effective,
        requiredVersion: CURRENT_LORE_SCHEMA_VERSION,
        missing: [],
      });
    }
    if (markers.loreMeta !== null && markers.userVersion !== null
      && markers.loreMeta !== markers.userVersion) {
      throw new LoreSchemaCompatibilityError(inspectLoreSchema(db));
    }
    // A database claiming the current version is not a migration candidate.
    // Require the complete schema and both agreeing markers before any pragma
    // can alter its on-disk state. Older versions continue through the ordered
    // migration chain, whose version writes restore both markers atomically.
    if (markers.effective === CURRENT_LORE_SCHEMA_VERSION) {
      const inspection = inspectLoreSchema(db);
      if (inspection.status !== 'current') {
        throw new LoreSchemaCompatibilityError(inspection);
      }
    }

    // WAL mode: readers don't block writers, writers don't block readers.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Performance pragmas: NORMAL sync is safe under WAL (only risk is
    // losing the last transaction on OS crash, not corruption). Larger
    // cache reduces I/O during enrichment and resolution stages.
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');   // 64 MB
    db.pragma('busy_timeout = 60000');

    let version = markers.effective ?? 0;
    for (const migration of LORE_SCHEMA_MIGRATIONS) {
      if (migration.toVersion <= version) continue;
      if (migration.toVersion !== version + 1) {
        throw new Error(
          `Missing ordered Lore schema migration from version ${version} to ${version + 1}`,
        );
      }
      migration.migrate(db);
      writeSchemaVersion(db, migration.toVersion);
      version = migration.toVersion;
    }
    if (version !== CURRENT_LORE_SCHEMA_VERSION) {
      throw new Error(
        `No migration path from Lore schema ${version} to ${CURRENT_LORE_SCHEMA_VERSION}`,
      );
    }
    assertLoreSchemaCompatible(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function writeSchemaVersion(db: Database.Database, version: number): void {
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO lore_meta (key, value) VALUES (?, ?)').run(
      LORE_META_SCHEMA_VERSION,
      String(version),
    );
    db.pragma(`user_version = ${version}`);
  }).immediate();
}

function prepareLegacyTablesForCurrentDdl(db: Database.Database): void {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const columnsByTable = new Map<string, Set<string>>();
  for (const migration of LEGACY_COLUMN_MIGRATIONS) {
    if (!tables.has(migration.table)) continue;
    let columns = columnsByTable.get(migration.table);
    if (!columns) {
      columns = new Set(
        (db.prepare(`PRAGMA table_info(${quoteIdentifier(migration.table)})`).all() as Array<{ name: string }>)
          .map((column) => column.name),
      );
      columnsByTable.set(migration.table, columns);
    }
    if (columns.has(migration.column)) continue;
    db.exec(
      `ALTER TABLE ${quoteDoubleIdentifier(migration.table)} ADD COLUMN ${quoteDoubleIdentifier(migration.column)} ${migration.definition}`,
    );
    columns.add(migration.column);
  }
}

/**
 * Ensure incremental indexing tables (dirty_files, reverse_deps) and
 * effective_* views exist.  These are idempotent CREATE IF NOT EXISTS
 * statements needed for databases created before incremental support.
 */
function ensureIncrementalSchema(
  db: Database.Database,
  bootstrapLegacyPromotion = true,
): void {
  ensureGenerationAwareFilesTable(db);

  const symbolColumns = new Set(
    (db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const symbolPositionColumns = [
    ['start_character', 'INTEGER'],
    ['end_character', 'INTEGER'],
    ['selection_line', 'INTEGER'],
    ['selection_character', 'INTEGER'],
  ] as const;
  for (const [name, type] of symbolPositionColumns) {
    if (!symbolColumns.has(name)) db.exec(`ALTER TABLE symbols ADD COLUMN ${name} ${type}`);
  }

  const importColumns = new Set(
    (db.prepare('PRAGMA table_info(file_imports)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!importColumns.has('resolution_method')) {
    db.exec("ALTER TABLE file_imports ADD COLUMN resolution_method TEXT NOT NULL DEFAULT 'unresolved'");
  }

  // Older import resolution persisted the package row but not the matching
  // classification on file_imports. Recover exact legacy pairs so read-only
  // coverage does not count known external dependencies as failures after an
  // explicit migration.
  db.exec(`
    UPDATE file_imports AS fi
       SET resolution_method = 'external_dependency'
     WHERE fi.resolved_id IS NULL
       AND fi.resolution_method = 'unresolved'
       AND EXISTS (
         SELECT 1 FROM external_deps dependency
          WHERE dependency.file_id = fi.file_id
            AND dependency.package = fi.raw_import
       )
  `);

  // Trigger semantics changed in schema v3; recreate rather than retaining
  // the v2 body through CREATE TRIGGER IF NOT EXISTS.
  db.exec('DROP TRIGGER IF EXISTS reset_file_import_resolution_on_target_delete');

  db.exec(`
    CREATE TABLE IF NOT EXISTS baseline_generations (
      branch      TEXT PRIMARY KEY,
      generation  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_layer ON files(layer);
    CREATE INDEX IF NOT EXISTS idx_files_layer_path ON files(layer, path);
    CREATE INDEX IF NOT EXISTS idx_files_branch_generation ON files(branch, layer, generation);
    CREATE INDEX IF NOT EXISTS idx_file_imports_resolution_method ON file_imports(resolution_method);
    CREATE TRIGGER reset_file_import_resolution_on_target_delete
    AFTER UPDATE OF resolved_id ON file_imports
    WHEN OLD.resolved_id IS NOT NULL AND NEW.resolved_id IS NULL
    BEGIN
      UPDATE file_imports SET resolution_method = 'overlay_stale' WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS remap_file_import_target_before_file_delete
    BEFORE DELETE ON files
    WHEN EXISTS (
      SELECT 1 FROM files replacement
       WHERE replacement.path = OLD.path
         AND replacement.branch = OLD.branch
         AND replacement.id != OLD.id
    )
    BEGIN
      UPDATE file_imports
         SET resolved_id = (
           SELECT replacement.id
             FROM files replacement
             LEFT JOIN baseline_generations promoted
               ON promoted.branch = replacement.branch
            WHERE replacement.path = OLD.path
              AND replacement.branch = OLD.branch
              AND replacement.id != OLD.id
            ORDER BY CASE
                       WHEN replacement.layer = 'overlay' THEN 0
                       WHEN replacement.layer = 'baseline'
                        AND replacement.generation = promoted.generation THEN 1
                       ELSE 2
                     END,
                     replacement.generation DESC,
                     replacement.id DESC
            LIMIT 1
         )
       WHERE resolved_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS reset_symbol_ref_resolution_on_target_delete
    AFTER UPDATE OF callee_id ON symbol_refs
    WHEN OLD.callee_id IS NOT NULL AND NEW.callee_id IS NULL
    BEGIN
      UPDATE symbol_refs SET resolution_method = 'unresolved' WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS reset_type_ref_resolution_on_target_delete
    AFTER UPDATE OF type_id ON type_refs
    WHEN OLD.type_id IS NOT NULL AND NEW.type_id IS NULL
    BEGIN
      UPDATE type_refs SET resolution_method = 'unresolved' WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS reset_symbol_relationship_resolution_on_target_delete
    AFTER UPDATE OF target_symbol_id ON symbol_relationships
    WHEN OLD.target_symbol_id IS NOT NULL AND NEW.target_symbol_id IS NULL
    BEGIN
      UPDATE symbol_relationships SET resolution_method = 'unresolved' WHERE id = NEW.id;
    END;
    CREATE TABLE IF NOT EXISTS dirty_files (
      path        TEXT NOT NULL,
      branch      TEXT NOT NULL DEFAULT '',
      dirty_since INTEGER NOT NULL DEFAULT (unixepoch()),
      overlay_gen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (path, branch)
    );
    CREATE INDEX IF NOT EXISTS idx_dirty_files_path ON dirty_files(path);
    CREATE INDEX IF NOT EXISTS idx_dirty_files_branch ON dirty_files(branch);

    CREATE TABLE IF NOT EXISTS reverse_deps (
      file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      dependent_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      dep_kind     TEXT    NOT NULL DEFAULT 'import',
      PRIMARY KEY (file_id, dependent_id, dep_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_reverse_deps_file ON reverse_deps(file_id);
    CREATE INDEX IF NOT EXISTS idx_reverse_deps_dependent ON reverse_deps(dependent_id);
  `);

  if (bootstrapLegacyPromotion) bootstrapPromotedGenerations(db);

  // Create effective_* views (DROP + CREATE to pick up any schema changes).
  // Wrapped in a transaction so concurrent readers never see missing views.
  db.transaction(() => {
    db.exec(`
    DROP TRIGGER IF EXISTS reconcile_targets_after_dirty_file_insert;
    DROP VIEW IF EXISTS effective_symbol_metrics;
    DROP VIEW IF EXISTS effective_file_imports;
    DROP VIEW IF EXISTS effective_annotations;
    DROP VIEW IF EXISTS effective_symbol_relationships;
    DROP VIEW IF EXISTS effective_type_refs;
    DROP VIEW IF EXISTS effective_symbol_refs;
    DROP VIEW IF EXISTS effective_symbols;
    DROP VIEW IF EXISTS effective_files;

    CREATE VIEW effective_files AS
    SELECT f.* FROM files f
    WHERE (f.layer = 'overlay'
           AND EXISTS (
             SELECT 1 FROM dirty_files df
             WHERE df.path = f.path AND df.branch = f.branch
           ))
       OR (f.layer = 'baseline'
           AND NOT EXISTS (
             SELECT 1 FROM dirty_files df
             WHERE df.path = f.path AND df.branch = f.branch
           )
           AND f.generation = (
             SELECT bg.generation
               FROM baseline_generations bg
              WHERE bg.branch = f.branch
           ));

    CREATE VIEW effective_symbols AS
    SELECT s.* FROM symbols s
    JOIN effective_files f ON f.id = s.file_id;

    CREATE VIEW effective_symbol_refs AS
    SELECT sr.* FROM symbol_refs sr
    JOIN effective_files f ON f.id = sr.file_id;

    CREATE VIEW effective_type_refs AS
    SELECT tr.* FROM type_refs tr
    JOIN effective_files f ON f.id = tr.file_id;

    CREATE VIEW effective_symbol_relationships AS
    SELECT rel.* FROM symbol_relationships rel
    JOIN effective_files f ON f.id = rel.file_id;

    CREATE VIEW effective_annotations AS
    SELECT a.* FROM annotations a
    JOIN effective_files f ON f.id = a.file_id;

    CREATE VIEW effective_file_imports AS
    SELECT fi.* FROM file_imports fi
    JOIN effective_files f ON f.id = fi.file_id;

    CREATE VIEW effective_symbol_metrics AS
    SELECT sm.* FROM symbol_metrics sm
    JOIN effective_symbols s ON s.id = sm.symbol_id;

    CREATE TRIGGER reconcile_targets_after_dirty_file_insert
    AFTER INSERT ON dirty_files
    BEGIN
      UPDATE symbol_refs
         SET callee_id = NULL,
             resolution_method = 'unresolved'
       WHERE id IN (
         SELECT edge.id
           FROM effective_symbol_refs edge
           JOIN symbols target ON target.id = edge.callee_id
           JOIN files target_file ON target_file.id = target.file_id
           LEFT JOIN effective_symbols effective_target ON effective_target.id = target.id
          WHERE target_file.path = NEW.path
            AND target_file.branch = NEW.branch
            AND effective_target.id IS NULL
       );

      UPDATE type_refs
         SET type_id = NULL,
             resolution_method = 'unresolved'
       WHERE id IN (
         SELECT edge.id
           FROM effective_type_refs edge
           JOIN symbols target ON target.id = edge.type_id
           JOIN files target_file ON target_file.id = target.file_id
           LEFT JOIN effective_symbols effective_target ON effective_target.id = target.id
          WHERE target_file.path = NEW.path
            AND target_file.branch = NEW.branch
            AND effective_target.id IS NULL
       );

      UPDATE symbol_relationships
         SET target_symbol_id = NULL,
             resolution_method = 'unresolved'
       WHERE id IN (
         SELECT edge.id
           FROM effective_symbol_relationships edge
           JOIN symbols target ON target.id = edge.target_symbol_id
           JOIN files target_file ON target_file.id = target.file_id
           LEFT JOIN effective_symbols effective_target ON effective_target.id = target.id
          WHERE target_file.path = NEW.path
            AND target_file.branch = NEW.branch
            AND effective_target.id IS NULL
       );

      UPDATE file_imports
         SET resolved_id = (
               SELECT replacement.id
                 FROM files hidden_target
                 LEFT JOIN effective_files replacement
                   ON replacement.path = hidden_target.path
                  AND replacement.branch = hidden_target.branch
                WHERE hidden_target.id = file_imports.resolved_id
             ),
             resolution_method = CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM files hidden_target
                   JOIN effective_files replacement
                     ON replacement.path = hidden_target.path
                    AND replacement.branch = hidden_target.branch
                  WHERE hidden_target.id = file_imports.resolved_id
               ) THEN resolution_method
               ELSE 'unresolved'
             END
       WHERE id IN (
         SELECT edge.id
           FROM effective_file_imports edge
           JOIN files target_file ON target_file.id = edge.resolved_id
           LEFT JOIN effective_files effective_target ON effective_target.id = edge.resolved_id
          WHERE target_file.path = NEW.path
            AND target_file.branch = NEW.branch
            AND effective_target.id IS NULL
       );
    END;
  `);
  })();

  // Invalidate cached view-existence checks so any read-only handles
  // sharing this underlying db re-detect the newly created views.
  resetEffectiveViewsCache(db);

}

/**
 * Databases created before generation promotion keyed files only by
 * `(path, branch, layer)`. Rebuild that table once so an uncommitted next
 * generation can coexist with the currently promoted baseline. IDs are
 * preserved, which keeps every dependent foreign key valid.
 */
function ensureGenerationAwareFilesTable(db: Database.Database): void {
  const indexes = db.prepare('PRAGMA index_list(files)').all() as Array<{
    name: string;
    unique: number;
  }>;
  const hasGenerationUniqueKey = indexes.some((index) => {
    if (index.unique !== 1) return false;
    const columns = db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as Array<{
      name: string;
    }>;
    return columns.map((column) => column.name).join('\u0000')
      === ['path', 'branch', 'layer', 'generation'].join('\u0000');
  });
  if (hasGenerationUniqueKey) return;

  // Foreign-key enforcement cannot be toggled from inside a transaction.
  // No rows are rewritten outside the transaction, and IDs are copied exactly.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      dropEffectiveViews(db);
      db.exec(`
        CREATE TABLE files_generation_migration (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          path        TEXT    NOT NULL,
          branch      TEXT    NOT NULL DEFAULT '',
          language    TEXT    NOT NULL,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          last_hash   TEXT,
          source      TEXT    NOT NULL DEFAULT '',
          indexed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
          layer       TEXT    NOT NULL DEFAULT 'baseline',
          generation  INTEGER NOT NULL DEFAULT 0,
          UNIQUE(path, branch, layer, generation)
        );
        INSERT INTO files_generation_migration
          (id, path, branch, language, size_bytes, last_hash, source, indexed_at, layer, generation)
        SELECT id, path, branch, language, size_bytes, last_hash, source, indexed_at, layer, generation
          FROM files;
        DROP TABLE files;
        ALTER TABLE files_generation_migration RENAME TO files;
      `);
    }).immediate();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error('files generation migration left invalid foreign-key references');
  }
}

function quoteIdentifier(identifier: string): string {
  return `'${identifier.replace(/'/gu, "''")}'`;
}

function quoteDoubleIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

function dropEffectiveViews(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS reconcile_targets_after_dirty_file_insert;
    DROP VIEW IF EXISTS effective_symbol_metrics;
    DROP VIEW IF EXISTS effective_file_imports;
    DROP VIEW IF EXISTS effective_annotations;
    DROP VIEW IF EXISTS effective_symbol_relationships;
    DROP VIEW IF EXISTS effective_type_refs;
    DROP VIEW IF EXISTS effective_symbol_refs;
    DROP VIEW IF EXISTS effective_symbols;
    DROP VIEW IF EXISTS effective_files;
  `);
}

/** Seed per-branch promotion state for databases that predate the table. */
function bootstrapPromotedGenerations(db: Database.Database): void {
  const legacyGeneration = db.prepare(
    "SELECT CAST(value AS INTEGER) AS generation FROM lore_meta WHERE key = 'generation'",
  ).get() as { generation: number } | undefined;
  const legacyPending = db.prepare(
    "SELECT CAST(value AS INTEGER) AS generation FROM lore_meta WHERE key = 'generation_pending'",
  ).get() as { generation: number } | undefined;
  const branches = db.prepare(
    "SELECT DISTINCT branch FROM files WHERE layer = 'baseline'",
  ).all() as Array<{ branch: string }>;
  const hasPromoted = db.prepare(
    'SELECT 1 AS present FROM baseline_generations WHERE branch = ?',
  );
  const hasGeneration = db.prepare(
    "SELECT 1 AS present FROM files WHERE branch = ? AND layer = 'baseline' AND generation = ? LIMIT 1",
  );
  const maxGeneration = db.prepare(
    "SELECT MAX(generation) AS generation FROM files WHERE branch = ? AND layer = 'baseline'",
  );
  const maxBeforePending = db.prepare(
    "SELECT MAX(generation) AS generation FROM files WHERE branch = ? AND layer = 'baseline' AND generation < ?",
  );
  const insert = db.prepare(
    'INSERT INTO baseline_generations (branch, generation) VALUES (?, ?)',
  );

  db.transaction(() => {
    for (const { branch } of branches) {
      if (hasPromoted.get(branch)) continue;
      let generation = legacyGeneration?.generation;
      if (generation === undefined || !hasGeneration.get(branch, generation)) {
        generation = (maxGeneration.get(branch) as { generation: number | null }).generation ?? 0;
      } else if (legacyPending?.generation === generation) {
        // Older builds advanced `generation` before the build was complete.
        // If a prior generation still exists, keep it promoted and treat the
        // pending generation as an interrupted staging attempt.
        const prior = (maxBeforePending.get(branch, generation) as { generation: number | null }).generation;
        if (prior !== null) generation = prior;
      }
      insert.run(branch, generation);
    }
  })();
}
