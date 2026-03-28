/**
 * @module lore-server/db
 *
 * Read-only SQLite connection wrapper for the Lore MCP server.
 * All MCP tool files use `openReadOnly()` to open the knowledge-base database.
 *
 * Query functions are organized into domain-focused modules under `./queries/`.
 * This file re-exports everything for backward compatibility.
 */

import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const esmRequire = createRequire(import.meta.url);

// Re-export the Database type so callers don't need to import better-sqlite3 directly.
export type { Database };

// ─── Re-export all query modules for backward compatibility ───────────────────

export { resetEffectiveViewsCache } from './queries/helpers.js';
export type {
  SymbolRow,
  SymbolRangeLookupOptions,
  SymbolRangeMatch,
  SymbolRangeResolution,
  SymbolMatchMode,
  SymbolLookupOptions,
  ListSymbolsOptions,
  ExternalSymbolRow,
} from './queries/symbols.js';
export {
  getSymbolById,
  listSymbolRangesByName,
  resolveSymbolRangeByName,
  getSymbolsByName,
  listSymbols,
  getExternalSymbolsByName,
  searchExternalSymbolsByName,
} from './queries/symbols.js';
export type { FileRow } from './queries/files.js';
export { getFileById, getFileByPath, listFiles, listFilesByPathPrefix } from './queries/files.js';
export type {
  ResolvedEdge,
  ListResolvedEdgesOptions,
  TypeRefEdge,
  ListTypeRefsOptions,
  SymbolRelationshipEdge,
  ListSymbolRelationshipsOptions,
} from './queries/edges.js';
export { listResolvedEdges, listTypeRefs, listSymbolRelationships } from './queries/edges.js';
export type { AnnotationRow } from './queries/annotations.js';
export { listAnnotations } from './queries/annotations.js';
export type {
  CommitRow,
  CommitFileRow,
  CommitRefRow,
  CommitStatsFilters,
  CommitCadenceRow,
  CommitSizeRow,
  CommitChurnFileRow,
  CommitAuthorStatsRow,
  CommitMessagePrefixRow,
  CommitScheduleRow,
  CommitBranchActivityRow,
} from './queries/commits.js';
export {
  getCommitBySha,
  listRecentCommits,
  listCommitsByFile,
  listCommitsByAuthor,
  listCommitFiles,
  listCommitRefs,
  listCommitsByRef,
  hasCommitEmbeddings,
  listCommitsBySemanticQuery,
  listCommitCadence,
  listCommitSizes,
  listCommitChurnByFile,
  listCommitAuthorStats,
  listCommitMessagePrefixes,
  listCommitSchedule,
  listCommitBranchActivity,
} from './queries/commits.js';
export type { SemanticSearchSymbolsArgs, SemanticSymbolRow } from './queries/semantic.js';
export { semanticSearchSymbols } from './queries/semantic.js';

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
      'mixed'    = some files use overlay data. */
  source: 'baseline' | 'mixed';
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
  } catch (e: unknown) {
    // dirty_files table may not exist in old databases
    if (e instanceof Error && e.message.includes('no such table')) {
      dirtyCount = 0;
    } else {
      throw e;
    }
  }

  let baselineAgeS = 0;
  try {
    const row = db.prepare(
      "SELECT MAX(indexed_at) AS latest FROM files WHERE layer = 'baseline'",
    ).get() as { latest: number | null } | undefined;
    if (row?.latest) {
      baselineAgeS = Math.max(0, Math.floor(Date.now() / 1000) - row.latest);
    }
  } catch (e: unknown) {
    // layer column may not exist in old databases
    if (e instanceof Error && (e.message.includes('no such table') || e.message.includes('no such column'))) {
      baselineAgeS = 0;
    } else {
      throw e;
    }
  }

  const source: FreshnessInfo['source'] = dirtyCount === 0 ? 'baseline' : 'mixed';
  return { source, baseline_age_s: baselineAgeS, dirty_file_count: dirtyCount };
}
