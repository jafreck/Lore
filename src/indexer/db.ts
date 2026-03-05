/**
 * @module indexer/db
 *
 * Opens (or creates) a SQLite knowledge-base database and ensures all
 * required tables exist.  Vector embedding tables (vec0 virtual tables)
 * are created separately via `createVec0Tables()` once the embedding
 * dimensions are known.
 */

import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);

// Re-export the Database type so callers don't need to import better-sqlite3.
export type { Database };

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
  indexed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(path, branch)
);

-- Named symbols extracted from source files.
CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  signature   TEXT,
  doc_comment TEXT,
  resolved_type_signature TEXT,
  resolved_return_type TEXT,
  definition_uri TEXT,
  definition_path TEXT
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
  created_at  INTEGER
);

-- Import / use declarations found in source files.
CREATE TABLE IF NOT EXISTS file_imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_import  TEXT    NOT NULL,
  resolved_id INTEGER REFERENCES files(id)
);

-- Test file to source file mappings derived during indexing.
CREATE TABLE IF NOT EXISTS test_mappings (
  test_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  confidence     TEXT    NOT NULL DEFAULT 'heuristic',
  UNIQUE(test_file_id, source_file_id)
);

-- Call-site references from one symbol to another.
CREATE TABLE IF NOT EXISTS symbol_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  callee_id   INTEGER REFERENCES symbols(id),
  callee_name TEXT    NOT NULL,
  call_line   INTEGER NOT NULL,
  resolved_type_signature TEXT,
  resolved_return_type TEXT,
  definition_uri TEXT,
  definition_path TEXT
);

-- External (third-party / stdlib) dependencies inferred from imports.
CREATE TABLE IF NOT EXISTS external_deps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  package     TEXT    NOT NULL,
  version     TEXT,
  UNIQUE(file_id, package)
);

-- Symbols extracted from direct dependency declarations and public API surfaces.
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
  max_nesting INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbol_metrics_cyclomatic ON symbol_metrics(cyclomatic);

-- Key-value store for knowledge-base metadata (schema version, embedding model, etc.).
CREATE TABLE IF NOT EXISTS kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- User and system notes scoped by key/scope pair.
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL,
  scope       TEXT    NOT NULL DEFAULT 'global',
  content     TEXT    NOT NULL,
  model       TEXT    NOT NULL DEFAULT '',
  source_hash TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(key, scope)
);

-- Indexed documentation files.
CREATE TABLE IF NOT EXISTS docs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT    NOT NULL,
  branch       TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  content_hash TEXT    NOT NULL,
  indexed_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(path, branch)
);

-- Heading-based documentation chunks.
CREATE TABLE IF NOT EXISTS doc_sections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id        INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  section_index INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  depth         INTEGER NOT NULL,
  heading_path  TEXT    NOT NULL,
  line_start    INTEGER NOT NULL,
  line_end      INTEGER NOT NULL,
  content       TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  UNIQUE(doc_id, section_index)
);

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

-- Coverage ingestion runs.
CREATE TABLE IF NOT EXISTS coverage_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_sha    TEXT    NOT NULL,
  source_path   TEXT    NOT NULL,
  format        TEXT    NOT NULL,
  ingested_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  source_mtime  INTEGER
);

-- Per-file coverage aggregates for each ingestion run.
CREATE TABLE IF NOT EXISTS coverage_files (
  run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
  file_path     TEXT    NOT NULL,
  lines_found   INTEGER NOT NULL DEFAULT 0,
  lines_hit     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, file_path)
);

-- Per-line hit counts for each file in an ingestion run.
CREATE TABLE IF NOT EXISTS coverage_lines (
  run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
  file_path     TEXT    NOT NULL,
  line_number   INTEGER NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, file_path, line_number),
  FOREIGN KEY (run_id, file_path) REFERENCES coverage_files(run_id, file_path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_routes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  method       TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  handler_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  handler_name TEXT    NOT NULL,
  framework    TEXT    NOT NULL,
  line         INTEGER NOT NULL,
  middleware   TEXT,
  UNIQUE(file_id, method, path)
);

CREATE INDEX IF NOT EXISTS idx_api_routes_method ON api_routes(method);
CREATE INDEX IF NOT EXISTS idx_api_routes_path ON api_routes(path);
CREATE INDEX IF NOT EXISTS idx_annotations_kind ON annotations(kind);
CREATE INDEX IF NOT EXISTS idx_annotations_file_id ON annotations(file_id);
CREATE INDEX IF NOT EXISTS idx_coverage_runs_ingested_at ON coverage_runs(ingested_at);
CREATE INDEX IF NOT EXISTS idx_coverage_files_path ON coverage_files(file_path);
CREATE INDEX IF NOT EXISTS idx_coverage_lines_path_line ON coverage_lines(file_path, line_number);
CREATE INDEX IF NOT EXISTS idx_docs_branch_kind ON docs(branch, kind);
CREATE INDEX IF NOT EXISTS idx_doc_sections_doc_id ON doc_sections(doc_id);
CREATE INDEX IF NOT EXISTS idx_external_symbols_dependency_ecosystem ON external_symbols(dependency_ecosystem);
CREATE INDEX IF NOT EXISTS idx_external_symbols_package_name ON external_symbols(package_name);
CREATE INDEX IF NOT EXISTS idx_external_symbols_symbol_name ON external_symbols(symbol_name);
`;

const ENRICHMENT_SCHEMA_MIGRATIONS: Array<{ table: string; column: string; sql: string }> = [
  { table: 'symbols', column: 'resolved_type_signature', sql: 'ALTER TABLE symbols ADD COLUMN resolved_type_signature TEXT' },
  { table: 'symbols', column: 'resolved_return_type', sql: 'ALTER TABLE symbols ADD COLUMN resolved_return_type TEXT' },
  { table: 'symbols', column: 'definition_uri', sql: 'ALTER TABLE symbols ADD COLUMN definition_uri TEXT' },
  { table: 'symbols', column: 'definition_path', sql: 'ALTER TABLE symbols ADD COLUMN definition_path TEXT' },
  { table: 'symbol_refs', column: 'resolved_type_signature', sql: 'ALTER TABLE symbol_refs ADD COLUMN resolved_type_signature TEXT' },
  { table: 'symbol_refs', column: 'resolved_return_type', sql: 'ALTER TABLE symbol_refs ADD COLUMN resolved_return_type TEXT' },
  { table: 'symbol_refs', column: 'definition_uri', sql: 'ALTER TABLE symbol_refs ADD COLUMN definition_uri TEXT' },
  { table: 'symbol_refs', column: 'definition_path', sql: 'ALTER TABLE symbol_refs ADD COLUMN definition_path TEXT' },
  { table: 'external_symbols', column: 'resolved_type_signature', sql: 'ALTER TABLE external_symbols ADD COLUMN resolved_type_signature TEXT' },
  { table: 'external_symbols', column: 'resolved_return_type', sql: 'ALTER TABLE external_symbols ADD COLUMN resolved_return_type TEXT' },
  { table: 'external_symbols', column: 'definition_uri', sql: 'ALTER TABLE external_symbols ADD COLUMN definition_uri TEXT' },
  { table: 'external_symbols', column: 'definition_path', sql: 'ALTER TABLE external_symbols ADD COLUMN definition_path TEXT' },
];

const ENRICHMENT_INDEX_MIGRATIONS = [
  'CREATE INDEX IF NOT EXISTS idx_symbols_definition_path ON symbols(definition_path)',
  'CREATE INDEX IF NOT EXISTS idx_symbol_refs_definition_path ON symbol_refs(definition_path)',
  'CREATE INDEX IF NOT EXISTS idx_external_symbols_definition_path ON external_symbols(definition_path)',
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

  // WAL mode: readers don't block writers, writers don't block readers.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create all tables in a single transaction.
  db.exec(DDL);
  ensureEnrichmentSchema(db);

  return db;
}

function ensureEnrichmentSchema(db: Database.Database): void {
  for (const migration of ENRICHMENT_SCHEMA_MIGRATIONS) {
    if (!hasTableColumn(db, migration.table, migration.column)) {
      db.exec(migration.sql);
    }
  }
  for (const indexMigration of ENRICHMENT_INDEX_MIGRATIONS) {
    db.exec(indexMigration);
  }
}

function hasTableColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

// ─── kb_meta helpers ──────────────────────────────────────────────────────────

export const KB_META_INDEX_CHECKPOINT = 'index_checkpoint';
export const KB_META_LAST_HEAD_SHA = 'last_known_head_sha';
export const KB_META_COVERAGE_LAST_SOURCE_PATH = 'coverage_last_source_path';
export const KB_META_COVERAGE_LAST_SOURCE_MTIME = 'coverage_last_source_mtime';

/** Write (or overwrite) a key-value pair in `kb_meta`. */
export function setKbMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO kb_meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Read a value from `kb_meta`; returns `undefined` if the key is absent. */
export function getKbMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kb_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

// ─── Vec0 virtual tables ──────────────────────────────────────────────────────

/**
 * Loads the sqlite-vec extension and creates the `symbol_embeddings` and
 * `symbol_semantic_embeddings` vec0 virtual tables with the given dimension.
 * Also stores `embedding_dims` in `kb_meta` for validation on reopen.
 *
 * This function is idempotent: it is safe to call multiple times with the
 * same `dims` value.
 *
 * @param db   An open better-sqlite3 database instance.
 * @param dims Embedding dimensionality (e.g. 1024 for Qwen3-Embedding-0.6B).
 */
export function createVec0Tables(db: Database.Database, dims: number): void {
  // Load the sqlite-vec native extension.
  // Use createRequire for ESM compatibility (native addons cannot be loaded via import()).
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_semantic_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);

  setKbMeta(db, 'embedding_dims', String(dims));
}
