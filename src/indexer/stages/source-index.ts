/**
 * @module indexer/stages/source-index
 *
 * Pipeline stage: walk the file tree and process each source file.
 *
 * This stage populates `context.files` for downstream stages and inserts
 * file, symbol, import, call-ref, type-ref, relationship, and annotation rows.
 *
 * For full builds it processes all files; for incremental updates it accepts
 * a pre-filtered list of changed paths via `context.changedPaths`.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';

/**
 * Walks the project tree and invokes the per-file extraction pipeline.
 *
 * This is a **thin wrapper** — the actual extraction logic remains inside
 * `IndexBuilder.processFile()` today.  The stage exists to enforce ordering
 * in the pipeline and to give downstream stages a populated `context.files`.
 *
 * Full extraction into this stage will happen once `IndexBuilder` is hollowed
 * out (Phase 2 of the refactor plan).
 */
export class SourceIndexStage implements PipelineStage {
  readonly name = 'source-index';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    // In the current implementation the SourceIndex work is still performed
    // inside IndexBuilder.build() / IndexBuilder.update() *before* the
    // pipeline is invoked.  This stage is a placeholder that documents the
    // intended boundary.
    //
    // When the migration is complete this stage will:
    //   1. Walk files via `walkFiles(context.walkerConfig)`
    //   2. Iterate files and call the extractor registry
    //   3. Insert rows into files, symbols, file_imports, symbol_refs,
    //      type_refs, symbol_relationships, api_routes, annotations tables
    //   4. Populate `context.files`
    //
    // For now, it simply validates that `context.files` was pre-populated.

    if (!context.files || context.files.length === 0) {
      context.log.indexing('source-index: no files in context (pre-populated by IndexBuilder)');
    }
  }
}
