/**
 * @module db/vec
 *
 * sqlite-vec extension loading and vec0 virtual table creation.
 */

import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { setLoreMeta } from './meta.js';

const esmRequire = createRequire(import.meta.url);

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
  if (!Number.isInteger(dims) || dims <= 0 || dims > 10000) {
    throw new Error(`Invalid embedding dimensions: ${dims}`);
  }

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
