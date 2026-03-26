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
  source      TEXT    NOT NULL DEFAULT '',
  indexed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  layer       TEXT    NOT NULL DEFAULT 'baseline',
  generation  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(path, branch, layer)
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
  path        TEXT PRIMARY KEY,
  dirty_since INTEGER NOT NULL DEFAULT (unixepoch()),
  overlay_gen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dirty_files_path ON dirty_files(path);

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

  // Performance pragmas: NORMAL sync is safe under WAL (only risk is
  // losing the last transaction on OS crash, not corruption).  Larger
  // cache reduces I/O during enrichment and resolution stages.
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');   // 64 MB

  // Create all tables in a single transaction.
  db.exec(DDL);
  ensureIncrementalSchema(db);

  return db;
}

/**
 * Ensure incremental indexing tables (dirty_files, reverse_deps) and
 * effective_* views exist.  These are idempotent CREATE IF NOT EXISTS
 * statements needed for databases created before incremental support.
 */
function ensureIncrementalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dirty_files (
      path        TEXT PRIMARY KEY,
      dirty_since INTEGER NOT NULL DEFAULT (unixepoch()),
      overlay_gen INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dirty_files_path ON dirty_files(path);

    CREATE TABLE IF NOT EXISTS reverse_deps (
      file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      dependent_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      dep_kind     TEXT    NOT NULL DEFAULT 'import',
      PRIMARY KEY (file_id, dependent_id, dep_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_reverse_deps_file ON reverse_deps(file_id);
    CREATE INDEX IF NOT EXISTS idx_reverse_deps_dependent ON reverse_deps(dependent_id);
  `);

  // Create effective_* views (DROP + CREATE to pick up any schema changes).
  db.exec(`
    DROP VIEW IF EXISTS effective_symbol_metrics;
    DROP VIEW IF EXISTS effective_file_imports;
    DROP VIEW IF EXISTS effective_annotations;
    DROP VIEW IF EXISTS effective_symbol_relationships;
    DROP VIEW IF EXISTS effective_type_refs;
    DROP VIEW IF EXISTS effective_symbol_refs;
    DROP VIEW IF EXISTS effective_symbols;
    DROP VIEW IF EXISTS effective_files;

    CREATE VIEW effective_files AS
    SELECT * FROM files
    WHERE (layer = 'overlay' AND path IN (SELECT path FROM dirty_files))
       OR (layer = 'baseline' AND path NOT IN (SELECT path FROM dirty_files));

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
  `);
}

// ─── lore_meta helpers ──────────────────────────────────────────────────────────

export const LORE_META_INDEX_CHECKPOINT = 'index_checkpoint';
export const LORE_META_LAST_HEAD_SHA = 'last_known_head_sha';

// Incremental indexing metadata keys
export const LORE_META_GENERATION = 'generation';
export const LORE_META_GENERATION_PENDING = 'generation_pending';
export const LORE_META_OVERLAY_DIRTY_FILES = 'overlay_dirty_files';
export const LORE_META_BASELINE_HEAD_SHA = 'baseline_head_sha';
export const LORE_META_OVERLAY_HEAD_SHA = 'overlay_head_sha';

/** Write (or overwrite) a key-value pair in `lore_meta`. */
export function setLoreMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO lore_meta (key, value) VALUES (?, ?)').run(key, value);
}

/** Read a value from `lore_meta`; returns `undefined` if the key is absent. */
export function getLoreMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM lore_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Get the current baseline generation counter (defaults to 0). */
export function getGeneration(db: Database.Database): number {
  const val = getLoreMeta(db, LORE_META_GENERATION);
  return val ? parseInt(val, 10) : 0;
}

/** Increment and return the next generation counter. */
export function incrementGeneration(db: Database.Database): number {
  const next = getGeneration(db) + 1;
  setLoreMeta(db, LORE_META_GENERATION, String(next));
  return next;
}

// ─── Vec0 virtual tables ──────────────────────────────────────────────────────

/**
 * Loads the sqlite-vec extension and creates the `symbol_embeddings`,
 * `symbol_semantic_embeddings`, and `commit_embeddings` vec0 virtual tables
 * with the given dimension.
 * Also stores `embedding_dims` in `lore_meta` for validation on reopen.
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
    CREATE VIRTUAL TABLE IF NOT EXISTS commit_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);

  setLoreMeta(db, 'embedding_dims', String(dims));
}
