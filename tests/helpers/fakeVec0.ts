/**
 * @module tests/helpers/fakeVec0
 *
 * Test helper that makes vec0-dependent code paths exercisable without the
 * sqlite-vec native extension.
 *
 * ## Problem
 *
 * sqlite-vec's `vec0` virtual tables use custom `MATCH` syntax for KNN
 * queries (`WHERE embedding MATCH ? AND k = ?`) that cannot be emulated
 * with regular SQLite tables. Many code paths guard on
 * `hasSymbolEmbeddingsTable(db)` / `hasVirtualTable(db, 'symbol_embeddings')`
 * and skip when the table doesn't exist.
 *
 * ## Approach
 *
 * `installFakeVec0(db, rows)`:
 * 1. Registers a sentinel table in `sqlite_master` so existence checks pass.
 * 2. Wraps `db.prepare()` to intercept SQL containing `embedding MATCH` and
 *    return the provided fake rows instead of failing on unknown syntax.
 * 3. All other SQL goes through to the real database unchanged.
 *
 * Call `removeFakeVec0(db)` in `afterEach` to restore the original
 * `db.prepare` and drop the sentinel table.
 */

import type Database from 'better-sqlite3';

/** Shape returned by symbol_embeddings KNN queries in search.ts / semantic.ts. */
export interface FakeVec0SymbolRow {
  result_type?: string;
  symbol_id: number;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  score: number;
  branch?: string;
  file_branch?: string;
  language?: string;
  [key: string]: unknown;
}

/** Shape returned by commit_embeddings KNN queries. */
export interface FakeVec0CommitRow {
  sha: string;
  author: string;
  author_email: string;
  timestamp: number;
  message: string;
  [key: string]: unknown;
}

const ORIGINAL_PREPARE = Symbol('originalPrepare');

/**
 * Install fake vec0 tables on a database connection.
 *
 * @param db              An open better-sqlite3 database.
 * @param symbolRows      Rows to return for `symbol_embeddings` MATCH queries.
 * @param commitRows      Rows to return for `commit_embeddings` MATCH queries.
 */
export function installFakeVec0(
  db: Database.Database,
  symbolRows: FakeVec0SymbolRow[] = [],
  commitRows: FakeVec0CommitRow[] = [],
): void {
  // 1. Create sentinel tables so hasSymbolEmbeddingsTable / hasVirtualTable
  //    return true.  We use a plain table; the sqlite_master type will be
  //    'table' which the checks accept (they look for 'table' OR 'virtual table').
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_embeddings (rowid INTEGER PRIMARY KEY, embedding TEXT);
    CREATE TABLE IF NOT EXISTS symbol_semantic_embeddings (rowid INTEGER PRIMARY KEY, embedding TEXT);
    CREATE TABLE IF NOT EXISTS commit_embeddings (rowid INTEGER PRIMARY KEY, embedding TEXT);
  `);

  // 2. Wrap db.prepare to intercept vec0 KNN queries.
  const origPrepare = db.prepare.bind(db);
  (db as any)[ORIGINAL_PREPARE] = origPrepare;

  (db as any).prepare = function fakeVec0Prepare(sql: string) {
    const lower = sql.toLowerCase();

    // Intercept symbol_embeddings MATCH queries
    if (lower.includes('embedding match') && lower.includes('symbol_embeddings')) {
      return {
        all(..._args: unknown[]) { return symbolRows; },
        get(..._args: unknown[]) { return symbolRows[0] ?? undefined; },
        run(..._args: unknown[]) { return { changes: 0, lastInsertRowid: 0 }; },
        bind() { return this; },
        pluck() { return this; },
        raw() { return this; },
        columns() { return []; },
        safeIntegers() { return this; },
      };
    }

    // Intercept commit_embeddings MATCH queries
    if (lower.includes('embedding match') && lower.includes('commit_embeddings')) {
      return {
        all(..._args: unknown[]) { return commitRows; },
        get(..._args: unknown[]) { return commitRows[0] ?? undefined; },
        run(..._args: unknown[]) { return { changes: 0, lastInsertRowid: 0 }; },
        bind() { return this; },
        pluck() { return this; },
        raw() { return this; },
        columns() { return []; },
        safeIntegers() { return this; },
      };
    }

    // All other SQL goes through normally
    return origPrepare(sql);
  };
}

/**
 * Remove the fake vec0 wrapper and drop sentinel tables.
 */
export function removeFakeVec0(db: Database.Database): void {
  // Restore original prepare
  const orig = (db as any)[ORIGINAL_PREPARE];
  if (orig) {
    db.prepare = orig;
    delete (db as any)[ORIGINAL_PREPARE];
  }

  // Drop sentinel tables (they're regular tables, safe to drop)
  try { db.exec('DROP TABLE IF EXISTS symbol_embeddings'); } catch { /* ignore */ }
  try { db.exec('DROP TABLE IF EXISTS symbol_semantic_embeddings'); } catch { /* ignore */ }
  try { db.exec('DROP TABLE IF EXISTS commit_embeddings'); } catch { /* ignore */ }
}
