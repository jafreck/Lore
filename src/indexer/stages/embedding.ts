/**
 * @module indexer/stages/embedding
 *
 * Pipeline stage: embed symbol signatures, documentation sections, and
 * commit messages into vec0 virtual tables for semantic search.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../db.js';
import type { EmbeddingProvider } from '../embedder.js';
import { setLoreMeta, createVec0Tables } from '../db.js';
import { buildStructuralEmbeddingText } from '../embedder.js';

/**
 * Number of items to send per `embed()` call.
 *
 * Larger batches reduce per-call overhead in TransformersJsProvider —
 * the ONNX runtime handles its own internal micro-batching so bigger
 * is better up to memory limits.
 *
 * 512 is a good trade-off: for a 10k-symbol codebase it means ~20
 * round-trips instead of ~160, while keeping peak memory reasonable
 * (512 × 1024-dim × 4 bytes ≈ 2 MB per batch of float vectors).
 */
const EMBED_BATCH_SIZE = 512;

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

      await embedStructural(db, embedder, changedFileIds);
      await embedDocumentation(db, embedder, changedDocIds);
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

async function embedStructural(
  db: Database.Database,
  embedder: EmbeddingProvider,
  fileIds?: number[],
): Promise<void> {
  setLoreMeta(db, 'embedding_model', embedder.modelName);
  setLoreMeta(db, 'embedding_dims', String(embedder.dims));
  createVec0Tables(db, embedder.dims);

  const baseQuery =
    `SELECT id, name, signature, resolved_type_signature, resolved_return_type
     FROM symbols
     WHERE (signature IS NOT NULL
        OR resolved_type_signature IS NOT NULL
        OR resolved_return_type IS NOT NULL)`;

  let symbols: Array<{
    id: number;
    name: string;
    signature: string | null;
    resolved_type_signature: string | null;
    resolved_return_type: string | null;
  }>;

  if (fileIds && fileIds.length > 0) {
    symbols = db
      .prepare(
        `${baseQuery} AND file_id IN (${fileIds.map(() => '?').join(', ')})`,
      )
      .all(...fileIds) as typeof symbols;
  } else {
    symbols = db.prepare(baseQuery).all() as typeof symbols;
  }

  const insertEmbed = db.prepare(
    'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  );

  // P4: Pipeline — start embedding the next batch while writing the current one.
  let pendingEmbed: Promise<number[][]> | null = null;
  let pendingBatch: typeof symbols = [];

  for (let i = 0; i < symbols.length; i += EMBED_BATCH_SIZE) {
    const batch = symbols.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((symbol) =>
      buildStructuralEmbeddingText({
        name: symbol.name,
        signature: symbol.signature,
        resolvedTypeSignature: symbol.resolved_type_signature,
        resolvedReturnType: symbol.resolved_return_type,
      }),
    );

    if (pendingEmbed) {
      const embeddings = await pendingEmbed;
      db.transaction(() => {
        for (let j = 0; j < pendingBatch.length; j++) {
          const sym = pendingBatch[j];
          if (sym) insertEmbed.run(sym.id, JSON.stringify(embeddings[j]));
        }
      })();
    }

    pendingEmbed = embedder.embed(texts);
    pendingBatch = batch;
  }

  if (pendingEmbed) {
    const embeddings = await pendingEmbed;
    db.transaction(() => {
      for (let j = 0; j < pendingBatch.length; j++) {
        const sym = pendingBatch[j];
        if (sym) insertEmbed.run(sym.id, JSON.stringify(embeddings[j]));
      }
    })();
  }
}

// ─── Documentation section embeddings ─────────────────────────────────────────

async function embedDocumentation(
  db: Database.Database,
  embedder: EmbeddingProvider,
  docIds?: number[],
): Promise<void> {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_section_embeddings USING vec0(
      embedding FLOAT[${embedder.dims}]
    );
  `);

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

  const insertEmbed = db.prepare(
    'INSERT OR REPLACE INTO doc_section_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  );

  // P4: Pipeline — start embedding the next batch while writing the current one.
  let pendingEmbed: Promise<number[][]> | null = null;
  let pendingBatch: typeof sections = [];

  for (let i = 0; i < sections.length; i += EMBED_BATCH_SIZE) {
    const batch = sections.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(section => section.content || section.title);

    if (pendingEmbed) {
      const embeddings = await pendingEmbed;
      db.transaction(() => {
        for (let j = 0; j < pendingBatch.length; j++) {
          const section = pendingBatch[j];
          if (section) insertEmbed.run(section.id, JSON.stringify(embeddings[j]));
        }
      })();
    }

    pendingEmbed = embedder.embed(texts);
    pendingBatch = batch;
  }

  if (pendingEmbed) {
    const embeddings = await pendingEmbed;
    db.transaction(() => {
      for (let j = 0; j < pendingBatch.length; j++) {
        const section = pendingBatch[j];
        if (section) insertEmbed.run(section.id, JSON.stringify(embeddings[j]));
      }
    })();
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

  // P4: Pipeline — start embedding the next batch while writing the current one.
  let pendingEmbed: Promise<number[][]> | null = null;
  let pendingBatch: typeof commits = [];

  for (let i = 0; i < commits.length; i += EMBED_BATCH_SIZE) {
    const batch = commits.slice(i, i + EMBED_BATCH_SIZE);

    if (pendingEmbed) {
      const embeddings = await pendingEmbed;
      db.transaction(() => {
        for (let j = 0; j < pendingBatch.length; j++) {
          const commit = pendingBatch[j];
          if (commit) insertEmbed.run(commit.rowid, JSON.stringify(embeddings[j]));
        }
      })();
    }

    pendingEmbed = embedder.embed(batch.map((commit) => commit.message));
    pendingBatch = batch;
  }

  if (pendingEmbed) {
    const embeddings = await pendingEmbed;
    db.transaction(() => {
      for (let j = 0; j < pendingBatch.length; j++) {
        const commit = pendingBatch[j];
        if (commit) insertEmbed.run(commit.rowid, JSON.stringify(embeddings[j]));
      }
    })();
  }
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
