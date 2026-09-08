/**
 * @module indexer/stages/embedding
 *
 * Pipeline stage: embed symbol signature/type text and commit messages into
 * vec0 virtual tables for semantic search.
 *
 * Optimisations:
 *   - **Streaming batching**: symbols are processed incrementally; only one
 *     batch of text is held in memory at a time.
 *   - **Skip-unchanged**: in update mode, symbols whose embedding input text
 *     has not changed (by SHA-256 hash) are skipped entirely.
 *   - **Double-buffered I/O**: the next `embed()` call fires while the
 *     current batch's vectors are written to SQLite.
 */

import {
  setPipelineLoreMeta,
  type PipelineContext,
  type PipelineStage,
} from '../pipeline.js';
import type { Database } from '../../db/schema.js';
import type { EmbeddingProvider } from '../../embeddings/embedder.js';
import { createVec0Tables, getLoreMeta } from '../../db/schema.js';
import { buildStructuralEmbeddingText, hashEmbeddingText, tokenAwareBatch, estimateTokens, MAX_BATCH_TOKENS, MAX_BATCH_ITEMS } from '../../embeddings/embedder.js';

/**
 * Embed symbol signature/type text and commit messages.
 *
 * Skips entirely when no `EmbeddingProvider` is configured in the context.
 */
export class EmbeddingStage implements PipelineStage {
  readonly name = 'embedding';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    // Without the configured provider Lore cannot recreate replacement
    // vectors. Keep old, now-inert rowids instead of silently destroying the
    // persisted embedding index; searches join through effective_symbols.
    if (!context.embedder) return;

    const { db, embedder } = context;
    context.log.indexing('embedding started', { model: embedder.modelName });

    await embedder.init();
    assertCompatibleEmbeddingMetadata(db, embedder);
    if (mode === 'update') {
      deleteSymbolEmbeddings(context.db, context.staleSymbolIds);
    }

    if (mode === 'update') {
      // Resolve scoped file IDs for incremental symbol embedding.
      const changedFileIds = resolveFileIds(db, context.changedSourcePaths, context.branch);

      await embedStructural(db, embedder, changedFileIds, /* skipUnchanged */ true);
    } else {
      await embedStructural(db, embedder);
    }

    if (context.history) {
      await embedCommitMessages(db, embedder);
    }

    // Publish metadata only after every requested vector batch succeeded.
    // A failed refresh therefore continues to describe the prior vectors.
    setPipelineLoreMeta(context, 'embedding_model', embedder.modelName);
    setPipelineLoreMeta(context, 'embedding_dims', String(embedder.dims));

    context.log.indexing('embedding complete');
  }
}

function assertCompatibleEmbeddingMetadata(
  db: Database.Database,
  embedder: EmbeddingProvider,
): void {
  const persistedModel = getLoreMeta(db, 'embedding_model');
  const persistedDims = getLoreMeta(db, 'embedding_dims');
  if (persistedModel && persistedModel !== embedder.modelName) {
    throw new Error(
      `Embedding model mismatch: database uses "${persistedModel}" but refresh requested "${embedder.modelName}"; rebuild into a new database to change models`,
    );
  }
  if (persistedDims !== undefined && Number.parseInt(persistedDims, 10) !== embedder.dims) {
    throw new Error(
      `Embedding dimension mismatch: database uses ${persistedDims} dimensions but provider returned ${embedder.dims}`,
    );
  }
}

// ─── Structural symbol embeddings ─────────────────────────────────────────────

interface SymbolRow {
  id: number;
  name: string;
  signature: string | null;
  resolved_type_signature: string | null;
  resolved_return_type: string | null;
}

async function embedStructural(
  db: Database.Database,
  embedder: EmbeddingProvider,
  fileIds?: number[],
  skipUnchanged = false,
): Promise<void> {
  createVec0Tables(db, embedder.dims);

  // Ensure the hash tracking column exists (idempotent).
  ensureEmbeddingHashColumn(db, 'symbol_embeddings');

  const baseQuery =
    `SELECT id, name, signature, resolved_type_signature, resolved_return_type
     FROM effective_symbols
     WHERE (signature IS NOT NULL
        OR resolved_type_signature IS NOT NULL
        OR resolved_return_type IS NOT NULL)`;

  let symbols: SymbolRow[];

  if (fileIds && fileIds.length > 0) {
    symbols = db
      .prepare(
        `${baseQuery} AND file_id IN (${fileIds.map(() => '?').join(', ')})`,
      )
      .all(...fileIds) as SymbolRow[];
  } else {
    symbols = db.prepare(baseQuery).all() as SymbolRow[];
  }

  // Build texts incrementally and flush into embedding batches as they fill.
  // This avoids holding all embedding text in memory simultaneously.
  const existingHashes = skipUnchanged ? loadExistingHashes(db, 'symbol_embeddings', symbols.map(s => s.id)) : new Map<number, string>();

  const insertEmbed = db.prepare(
    'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  );
  const insertHash = db.prepare(
    'INSERT OR REPLACE INTO symbol_embeddings_hashes(rowid, content_hash) VALUES (?, ?)',
  );

  const writeBatch = (batch: Array<{ sym: SymbolRow; text: string; hash: string }>, embeddings: number[][]) => {
    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        if (item) {
          insertEmbed.run(item.sym.id, JSON.stringify(embeddings[j]));
          insertHash.run(item.sym.id, item.hash);
        }
      }
    })();
  };

  let currentBatch: Array<{ sym: SymbolRow; text: string; hash: string }> = [];
  let currentBatchTokens = 0;
  let pendingEmbed: Promise<number[][]> | null = null;
  let pendingBatch: Array<{ sym: SymbolRow; text: string; hash: string }> = [];

  // Double-buffered flush: starts embedding currentBatch while the previous
  // batch's results are being written to the DB.
  const flushBatch = async () => {
    if (currentBatch.length === 0) return;
    if (pendingEmbed) {
      const embeddings = await pendingEmbed;
      writeBatch(pendingBatch, embeddings);
    }
    pendingEmbed = embedder.embed(currentBatch.map(item => item.text));
    pendingBatch = currentBatch;
    currentBatch = [];
    currentBatchTokens = 0;
  };

  for (const sym of symbols) {
    const text = buildStructuralEmbeddingText({
      name: sym.name,
      signature: sym.signature,
      resolvedTypeSignature: sym.resolved_type_signature,
      resolvedReturnType: sym.resolved_return_type,
    });
    const hash = hashEmbeddingText(text);
    if (skipUnchanged && existingHashes.get(sym.id) === hash) continue;

    const itemTokens = estimateTokens(text);
    if (currentBatch.length >= MAX_BATCH_ITEMS || currentBatchTokens + itemTokens > MAX_BATCH_TOKENS) {
      await flushBatch();
    }
    currentBatch.push({ sym, text, hash });
    currentBatchTokens += itemTokens;
  }

  // Flush remaining items and drain the last pending batch.
  await flushBatch();
  if (pendingEmbed) {
    const embeddings = await pendingEmbed;
    writeBatch(pendingBatch, embeddings);
  }
}

// ─── Commit message embeddings ────────────────────────────────────────────────

async function embedCommitMessages(
  db: Database.Database,
  embedder: EmbeddingProvider,
): Promise<void> {
  const commits = db.prepare(
    `SELECT c.rowid, c.message
     FROM commits c
     LEFT JOIN commit_embeddings ce ON ce.rowid = c.rowid
     WHERE length(trim(c.message)) > 0
       AND ce.rowid IS NULL
     ORDER BY c.rowid`,
  ).all() as Array<{ rowid: number; message: string }>;
  if (commits.length === 0) return;

  const insertEmbed = db.prepare(
    'INSERT OR REPLACE INTO commit_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  );

  const batches = tokenAwareBatch(commits, (c) => c.message);
  await embedBatchesDoubleBuffered(batches, embedder,
    (c) => c.message,
    (batch, embeddings) => {
      db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const commit = batch[j];
          if (commit) insertEmbed.run(commit.rowid, JSON.stringify(embeddings[j]));
        }
      })();
    },
  );
}

// ─── Double-buffered batch embedding ──────────────────────────────────────────

/**
 * Embeds pre-batched items using double-buffered I/O: fires the next
 * `embed()` call while writing the current batch's results to the DB.
 */
async function embedBatchesDoubleBuffered<T>(
  batches: T[][],
  embedder: EmbeddingProvider,
  getText: (item: T) => string,
  writeBatch: (batch: T[], embeddings: number[][]) => void,
): Promise<void> {
  let pendingEmbed: Promise<number[][]> | null = null;
  let pendingBatch: T[] = [];

  for (const batch of batches) {
    const texts = batch.map(getText);

    // Write the previous batch while starting the next embed.
    if (pendingEmbed) {
      const embeddings = await pendingEmbed;
      writeBatch(pendingBatch, embeddings);
    }

    pendingEmbed = embedder.embed(texts);
    pendingBatch = batch;
  }

  // Drain the last pending batch.
  if (pendingEmbed) {
    const embeddings = await pendingEmbed;
    writeBatch(pendingBatch, embeddings);
  }
}

// ─── Skip-unchanged helpers ───────────────────────────────────────────────────

/**
 * Idempotently add a `content_hash` column to an embedding virtual table's
 * shadow storage.  vec0 virtual tables don't support ALTER TABLE, so we use
 * a companion regular table for the hash.
 */
function ensureEmbeddingHashColumn(db: Database.Database, tableName: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName}_hashes (
      rowid INTEGER PRIMARY KEY,
      content_hash TEXT NOT NULL
    );
  `);

  // Migrate: if we previously stored content_hash inline in the INSERT OR REPLACE
  // statement, the vec0 table ignores unknown columns silently, so nothing to migrate.
}

/**
 * Load existing content hashes for a set of row IDs from the hash companion table.
 */
function loadExistingHashes(db: Database.Database, tableName: string, ids: number[]): Map<number, string> {
  const map = new Map<number, string>();
  if (ids.length === 0) return map;

  const hashTable = `${tableName}_hashes`;
  const hasTable = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(hashTable) as { present: number } | undefined;
  if (!hasTable) return map;

  const CHUNK = 900;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db.prepare(
      `SELECT rowid, content_hash FROM ${hashTable} WHERE rowid IN (${chunk.map(() => '?').join(', ')})`,
    ).all(...chunk) as Array<{ rowid: number; content_hash: string }>;
    for (const row of rows) {
      map.set(row.rowid, row.content_hash);
    }
  }
  return map;
}

// ─── Update-mode helpers ──────────────────────────────────────────────────────

function deleteSymbolEmbeddings(db: Database.Database, symbolIds: number[]): void {
  if (symbolIds.length === 0) return;
  // Chunk to stay within SQLite's SQLITE_MAX_VARIABLE_NUMBER limit (default 999).
  const CHUNK = 900;
  for (const table of [
    'symbol_embeddings',
    'symbol_semantic_embeddings',
    'symbol_embeddings_hashes',
  ]) {
    const hasTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (!hasTable) continue;
    for (let i = 0; i < symbolIds.length; i += CHUNK) {
      const chunk = symbolIds.slice(i, i + CHUNK);
      db.prepare(
        `DELETE FROM ${table} WHERE rowid IN (${chunk.map(() => '?').join(', ')})`,
      ).run(...chunk);
    }
  }
}

function resolveFileIds(db: Database.Database, paths: string[], branch: string): number[] {
  const ids: number[] = [];
  for (const p of paths) {
    const row = db.prepare('SELECT id FROM effective_files WHERE path = ? AND branch = ?').get(p, branch) as { id: number } | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}
