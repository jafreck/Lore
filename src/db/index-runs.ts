/**
 * Persistent provenance for index builds and the indexers used by each build.
 *
 * These rows intentionally complement (rather than replace) the small
 * `lore_meta` key/value store.  A doctor run needs to distinguish an indexer
 * that was never considered from one that was attempted and failed, and it
 * needs to retain that distinction after the indexing process exits.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type IndexRunMode = 'build' | 'update' | 'rebuild';
export type IndexRunStatus = 'running' | 'succeeded' | 'degraded' | 'failed';
export type IndexerRunStatus =
  | 'succeeded'
  | 'degraded'
  | 'failed'
  | 'unavailable'
  | 'skipped'
  | 'disabled';

export interface BeginIndexRunOptions {
  mode: IndexRunMode;
  rootDir: string;
  branch: string;
  layer: 'baseline' | 'overlay';
  generation: number;
  config?: unknown;
}

export interface FinishIndexRunOptions {
  status: Exclude<IndexRunStatus, 'running'>;
  fallbackDegraded?: boolean;
  error?: string;
}

export interface RecordIndexerRunOptions {
  runId: string;
  provider: 'scip' | 'lsp' | 'compdb' | 'discovery' | string;
  indexer: string;
  languages?: readonly string[];
  status: IndexerRunStatus;
  attempted: boolean;
  fallback?: boolean;
  files?: number;
  symbols?: number;
  callRefs?: number;
  typeRefs?: number;
  imports?: number;
  startedAt?: number;
  completedAt?: number;
  message?: string;
  details?: unknown;
}

export function beginIndexRun(
  db: Database.Database,
  options: BeginIndexRunOptions,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO index_runs
       (id, mode, root_dir, branch, layer, generation, started_at, status, config_json)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch(), 'running', ?)`,
  ).run(
    id,
    options.mode,
    options.rootDir,
    options.branch,
    options.layer,
    options.generation,
    stringifyJson(options.config),
  );
  return id;
}

export function finishIndexRun(
  db: Database.Database,
  runId: string,
  options: FinishIndexRunOptions,
): void {
  db.prepare(
    `UPDATE index_runs
     SET completed_at = unixepoch(), status = ?, fallback_degraded = ?, error = ?
     WHERE id = ?`,
  ).run(
    options.status,
    options.fallbackDegraded ? 1 : 0,
    options.error ?? null,
    runId,
  );
}

export function recordIndexerRun(
  db: Database.Database,
  options: RecordIndexerRunOptions,
): void {
  db.prepare(
    `INSERT INTO indexer_runs
       (run_id, provider, indexer, languages_json, status, attempted, fallback,
        files, symbols, call_refs, type_refs, imports, started_at, completed_at,
        message, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.runId,
    options.provider,
    options.indexer,
    JSON.stringify([...new Set(options.languages ?? [])].sort()),
    options.status,
    options.attempted ? 1 : 0,
    options.fallback ? 1 : 0,
    options.files ?? null,
    options.symbols ?? null,
    options.callRefs ?? null,
    options.typeRefs ?? null,
    options.imports ?? null,
    options.startedAt ?? null,
    options.completedAt ?? Math.floor(Date.now() / 1000),
    options.message ?? null,
    stringifyJson(options.details),
  );
}

function stringifyJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}