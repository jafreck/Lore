/**
 * @module indexer/stages/docs-index
 *
 * Pipeline stage: walk documentation files, chunk them, and persist to the DB.
 *
 * Also handles auto-seeding of documentation notes when enabled.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';

/**
 * Placeholder stage for documentation indexing.
 *
 * Currently the docs processing is performed inside `IndexBuilder.build()` /
 * `IndexBuilder.update()` before the pipeline runs.  This stage documents the
 * intended boundary and will absorb the logic in a future migration step.
 */
export class DocsIndexStage implements PipelineStage {
  readonly name = 'docs-index';

  async execute(_context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    // Docs processing is currently performed by IndexBuilder before the
    // pipeline.  This stage is a structural placeholder.
  }
}
