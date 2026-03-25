/**
 * @module indexer/stages/embedding
 *
 * Pipeline stage: embed symbol signatures, documentation sections, and
 * commit messages into vec0 virtual tables for semantic search.
 *
 * Optimisations:
 *   - **Streaming batching**: symbols and doc sections are processed
 *     incrementally; only one batch of text is held in memory at a time,
 *     capping peak memory usage regardless of corpus size.
 *   - **Skip-unchanged**: in update mode, symbols whose embedding input text
 *     has not changed (by SHA-256 hash) are skipped entirely.
 *   - **Double-buffered I/O**: the next `embed()` call fires while the
 *     current batch's vectors are written to SQLite.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../../db/schema.js';
import type { EmbeddingProvider } from '../../embeddings/embedder.js';
import { setLoreMeta, createVec0Tables } from '../../db/schema.js';
import { buildStructuralEmbeddingText, hashEmbeddingText, tokenAwareBatch, estimateTokens, MAX_BATCH_TOKENS, MAX_BATCH_ITEMS } from '../../embeddings/embedder.js';

/**
 * Embed symbol signatures, documentation sections, and commit messages.
 *
 * Skips entirely when no `EmbeddingProvider` is configured in the context.
 */
export class EmbeddingStage implements PipelineStage {
  readonly name = 'embedding';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    if (!context.embedder) return;

    const { db, embedder } = context;
    context.log.indexing('embedding started', { model: embedder.modelName });

    await embedder.init();

    if (mode === 'update') {
      // Clean up orphaned symbol embeddings for symbols that were deleted/replaced.
      deleteSymbolEmbeddings(db, context.staleSymbolIds);

      // Resolve scoped file/doc IDs for incremental embedding.
      const changedFileIds = resolveFileIds(db, context.changedSourcePaths, context.branch);
      const changedDocIds = resolveDocIds(db, context.changedDocPaths, context.branch);

      await embedStructural(db, embedder, changedFileIds, /* skipUnchanged */ true);
      await embedDocumentation(db, embedder, changedDocIds, /* skipUnchanged */ true);
    } else {
      await embedStructural(db, embedder);
      await embedDocumentation(db, embedder);
    }

    if (context.history) {
      await embedCommitMessages(db, embedder);
    }

    context.log.indexing('embedding complete');
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
  setLoreMeta(db, 'embedding_model', embedder.modelName);
  setLoreMeta(db, 'embedding_dims', String(embedder.dims));
  createVec0Tables(db, embedder.dims);

  // Ensure the hash tracking column exists (idempotent).
  ensureEmbeddingHashColumn(db, 'symbol_embeddings');

  const baseQuery =
    `SELECT id, name, signature, resolved_type_signature, resolved_return_type
     FROM symbols
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

// ─── Documentation section embeddings ─────────────────────────────────────────

async function embedDocumentation(
  db: Database.Database,
  embedder: EmbeddingProvider,
  docIds?: number[],
  skipUnchanged = false,
): Promise<void> {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_section_embeddings USING vec0(
      embedding FLOAT[${embedder.dims}]
    );
  `);

  ensureEmbeddingHashColumn(db, 'doc_section_embeddings');

  let sections: Array<{ id: number; title: string; content: string }>;
  if (docIds && docIds.length > 0) {
    sections = db.prepare(
      `SELECT id, title, content
       FROM doc_sections
       WHERE doc_id IN (${docIds.map(() => '?').join(', ')})
       ORDER BY id`,
    ).all(...docIds) as typeof sections;
  } else {
    sections = db.prepare(
      `SELECT id, title, content
       FROM doc_sections
       ORDER BY id`,
    ).all() as typeof sections;
  }
  if (sections.length === 0) return;

  // Build texts incrementally and flush into embedding batches as they fill.
  // This avoids holding all embedding text in memory simultaneously.
  const existingHashes = skipUnchanged ? loadExistingHashes(db, 'doc_section_embeddings', sections.map(s => s.id)) : new Map<number, string>();

  const insertEmbed = db.prepare(
    'INSERT OR REPLACE INTO doc_section_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  );
  const insertHash = db.prepare(
    'INSERT OR REPLACE INTO doc_section_embeddings_hashes(rowid, content_hash) VALUES (?, ?)',
  );

  type SectionItem = { section: typeof sections[number]; text: string; hash: string };

  const writeBatch = (batch: SectionItem[], embeddings: number[][]) => {
    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        if (item) {
          insertEmbed.run(item.section.id, JSON.stringify(embeddings[j]));
          insertHash.run(item.section.id, item.hash);
        }
      }
    })();
  };

  let currentBatch: SectionItem[] = [];
  let currentBatchTokens = 0;
  let pendingEmbed: Promise<number[][]> | null = null;
  let pendingBatch: SectionItem[] = [];

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

  for (const section of sections) {
    const text = section.content || section.title;
    const hash = hashEmbeddingText(text);
    if (skipUnchanged && existingHashes.get(section.id) === hash) continue;

    const itemTokens = estimateTokens(text);
    if (currentBatch.length >= MAX_BATCH_ITEMS || currentBatchTokens + itemTokens > MAX_BATCH_TOKENS) {
      await flushBatch();
    }
    currentBatch.push({ section, text, hash });
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
  const hasTable = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'symbol_embeddings'",
  ).get() as { present: number } | undefined;
  if (!hasTable) return;
  // Chunk to stay within SQLite's SQLITE_MAX_VARIABLE_NUMBER limit (default 999).
  const CHUNK = 900;
  for (let i = 0; i < symbolIds.length; i += CHUNK) {
    const chunk = symbolIds.slice(i, i + CHUNK);
    db.prepare(
      `DELETE FROM symbol_embeddings WHERE rowid IN (${chunk.map(() => '?').join(', ')})`,
    ).run(...chunk);
  }
}

function resolveFileIds(db: Database.Database, paths: string[], branch: string): number[] {
  const ids: number[] = [];
  for (const p of paths) {
    const row = db.prepare('SELECT id FROM files WHERE path = ? AND branch = ?').get(p, branch) as { id: number } | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}

function resolveDocIds(db: Database.Database, paths: string[], branch: string): number[] {
  const ids: number[] = [];
  for (const p of paths) {
    const row = db.prepare('SELECT id FROM docs WHERE path = ? AND branch = ?').get(p, branch) as { id: number } | undefined;
    if (row) ids.push(row.id);
  }
  return ids;
}
