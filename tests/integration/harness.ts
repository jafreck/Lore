/**
 * @module integration/harness
 *
 * Test harness for real-repo integration tests.
 *
 * Provides helpers to:
 * 1. Clone + index a pinned repo (reusing benchmark infrastructure)
 * 2. Open the DB and call MCP tool handlers directly
 * 3. Assert deterministic facts about the index
 *
 * Tests are gated behind `INTEGRATION=1` env var since they clone real repos.
 * Repos are cached in `.integration-repos/` (gitignored).
 */

import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { RepoManager } from '../benchmark/util/repo-manager.js';
import { indexRepo } from '../benchmark/util/indexer.js';
import { openReadOnly } from '../../src/db/read-only.js';
import type { RepoSpec, RepoInstance, IndexMode } from '../benchmark/util/types.js';
import type { Database } from '../../src/db/read-only.js';

const execFileAsync = promisify(execFile);

// ─── Tool handler imports ─────────────────────────────────────────────────────

import { handler as lookupHandler, type LookupArgs } from '../../src/server/tools/lookup.js';
import { handler as graphHandler } from '../../src/server/tools/graph.js';
import { handler as searchHandler } from '../../src/server/tools/search.js';
import { handler as dependentsHandler } from '../../src/server/tools/dependents.js';
import { handler as structureHandler } from '../../src/server/tools/structure.js';
import { handler as metricsHandler } from '../../src/server/tools/metrics.js';
import { handler as snippetHandler } from '../../src/server/tools/snippet.js';
import { handler as traceHandler } from '../../src/server/tools/trace.js';
import { handler as cohesionHandler } from '../../src/server/tools/cohesion.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const WORK_DIR = join(process.cwd(), '.integration-repos');

/** Whether integration tests are enabled. */
export const INTEGRATION_ENABLED = process.env.INTEGRATION === '1';

// ─── Repo manager singleton ───────────────────────────────────────────────────

let manager: RepoManager | undefined;

function getManager(): RepoManager {
  if (!manager) {
    manager = new RepoManager(WORK_DIR);
  }
  return manager;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

export interface IndexedRepo {
  instance: RepoInstance;
  db: Database.Database;
  /** Absolute path to the repo root, for constructing file paths. */
  repoRoot: string;
}

/** A shell command to run inside the repo before indexing. */
export interface BuildCommand {
  command: string;
  args?: string[];
  /** Extra env vars merged with the current process environment. */
  env?: Record<string, string>;
  /** Timeout in ms (default: 5 minutes). */
  timeoutMs?: number;
}

/**
 * Run build commands inside the repo checkout.
 * Skips if a `.lore.db` already exists (cached index from prior run).
 */
async function buildRepo(
  repoPath: string,
  commands: BuildCommand[],
): Promise<void> {
  // Skip builds when a cached index already exists
  if (existsSync(join(repoPath, '.lore.db'))) return;

  for (const cmd of commands) {
    await execFileAsync(cmd.command, cmd.args ?? [], {
      cwd: repoPath,
      timeout: cmd.timeoutMs ?? 300_000,
      env: { ...process.env, ...cmd.env },
      maxBuffer: 50 * 1024 * 1024,
    });
  }
}

/**
 * Prepare a repo for testing: clone (or reuse), optionally build, index,
 * and open the DB. The DB is opened read-only for querying via tool handlers.
 */
export async function prepareRepo(
  spec: RepoSpec,
  mode: IndexMode = 'scip',
  buildCommands?: BuildCommand[],
  scipTimeoutMs?: number,
): Promise<IndexedRepo> {
  const mgr = getManager();
  let instance = await mgr.prepare(spec);

  if (buildCommands?.length) {
    await buildRepo(instance.localPath, buildCommands);
  }

  instance = await indexRepo(instance, {
    mode,
    historyDepth: 50,
    scipTimeoutMs,
  });

  const db = openReadOnly(instance.dbPath!);
  return { instance, db, repoRoot: instance.localPath };
}

// ─── Tool query wrappers ──────────────────────────────────────────────────────

/** Look up a symbol by exact name. Returns matching rows. */
export async function lookupSymbol(
  db: Database.Database,
  name: string,
  opts?: Partial<LookupArgs>,
) {
  return lookupHandler(db, { kind: 'symbol', query: name, ...opts });
}

/** Look up a file by path. */
export async function lookupFile(db: Database.Database, path: string) {
  return lookupHandler(db, { kind: 'file', query: path });
}

/** Query call graph edges (outbound from a symbol). */
export async function queryCallees(db: Database.Database, sourceId: number) {
  return graphHandler(db, { kind: 'call', source_id: sourceId } as any);
}

/** Query call graph edges (inbound — callers of a symbol). */
export async function queryCallers(db: Database.Database, targetId: number) {
  return graphHandler(db, { kind: 'call', target_id: targetId } as any);
}

/** Query import graph edges. */
export async function queryImports(db: Database.Database, sourceId: number) {
  return graphHandler(db, { kind: 'import', source_id: sourceId } as any);
}

/** Search for symbols structurally. */
export async function searchSymbols(
  db: Database.Database,
  query: string,
  opts?: Record<string, unknown>,
) {
  return searchHandler(db, { query, mode: 'structural', ...opts } as any);
}

/** Find dependents of a symbol. */
export async function findDependents(
  db: Database.Database,
  symbolName: string,
) {
  return dependentsHandler(db, { query: symbolName, kind: 'symbol' } as any);
}

/** Find dependents of a file. */
export async function findFileDependents(
  db: Database.Database,
  filePath: string,
) {
  return dependentsHandler(db, { query: filePath, kind: 'file' } as any);
}

/** Run structure analysis. */
export async function analyzeStructure(
  db: Database.Database,
  analysis: string,
  opts?: Record<string, unknown>,
) {
  return structureHandler(db, { analysis, ...opts } as any);
}

/** Get index metrics. */
export async function getMetrics(db: Database.Database) {
  return metricsHandler(db, {} as any);
}

/** Get a code snippet by file path and line range. */
export async function getSnippet(
  db: Database.Database,
  filePath: string,
  startLine?: number,
  endLine?: number,
) {
  return snippetHandler(db, { path: filePath, start_line: startLine, end_line: endLine } as any);
}

/** Trace a call path from an entry point. */
export async function traceCall(
  db: Database.Database,
  entrySymbol: string,
  opts?: Record<string, unknown>,
) {
  return traceHandler(db, { entry: entrySymbol, ...opts } as any);
}

/** Rank directories by cohesion. */
export async function analyzeCohesion(db: Database.Database, opts?: Record<string, unknown>) {
  return cohesionHandler(db, { ...opts } as any);
}

/** Resolve a relative file path to the absolute path used in the index. */
export function absPath(repoRoot: string, relativePath: string): string {
  return join(repoRoot, relativePath);
}

/** Get basic index stats by querying the DB directly. */
export function getIndexStats(db: Database.Database) {
  const symbolCount = (db.prepare('SELECT count(*) as c FROM symbols').get() as any).c as number;
  const fileCount = (db.prepare('SELECT count(*) as c FROM files').get() as any).c as number;
  const refCount = (db.prepare('SELECT count(*) as c FROM symbol_refs').get() as any).c as number;
  const importCount = (db.prepare('SELECT count(*) as c FROM file_imports').get() as any).c as number;
  return { symbolCount, fileCount, refCount, importCount };
}
