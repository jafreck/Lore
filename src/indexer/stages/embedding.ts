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

/** Number of items to embed per batch. */
const EMBED_BATCH_SIZE = 64;

/**
 * Embed symbol signatures, documentation sections, and commit messages.
 *
 * Skips entirely when no `EmbeddingProvider` is configured in the context.
 */
export class EmbeddingStage implements PipelineStage {
  readonly name = 'embedding';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    if (!context.embedder) return;

    const { db, embedder } = context;
    context.log.indexing('embedding started', { model: embedder.modelName });

    await embedder.init();
    await embedStructural(db, embedder);
    await embedDocumentation(db, embedder);

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
    const embeddings = await embedder.embed(texts);

    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const sym = batch[j];
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

  for (let i = 0; i < sections.length; i += EMBED_BATCH_SIZE) {
    const batch = sections.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(section => section.content || section.title);
    const embeddings = await embedder.embed(texts);

    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const section = batch[j];
        if (section) {
          insertEmbed.run(section.id, JSON.stringify(embeddings[j]));
        }
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

  for (let i = 0; i < commits.length; i += EMBED_BATCH_SIZE) {
    const batch = commits.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await embedder.embed(batch.map((commit) => commit.message));

    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const commit = batch[j];
        if (commit) {
          insertEmbed.run(commit.rowid, JSON.stringify(embeddings[j]));
        }
      }
    })();
  }
}
