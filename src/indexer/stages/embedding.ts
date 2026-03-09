/**
 * @module indexer/stages/embedding
 *
 * Pipeline stage: generate and persist vector embeddings for symbols,
 * documentation sections, and commit messages.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';

/**
 * Placeholder stage for embedding generation.
 *
 * Currently the embedding logic is performed inside `IndexBuilder` via
 * `embedStructural()`, `embedDocumentation()`, and `embedCommitMessages()`.
 * This stage documents the intended boundary and will absorb the logic in a
 * future migration step.
 */
export class EmbeddingStage implements PipelineStage {
  readonly name = 'embedding';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    if (!context.embedder) return;
    // Embedding is currently performed by IndexBuilder after the pipeline.
    // This stage is a structural placeholder.
    context.log.indexing('embedding stage: delegated to IndexBuilder');
  }
}
