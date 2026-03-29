/**
 * @module indexer/stages/dependency-api
 *
 * Pipeline stage: index declaration-surface symbols from direct dependencies.
 *
 * After tree-sitter removal, external symbol discovery is handled by SCIP's
 * external symbol support. This stage clears stale external_symbols data and
 * will be re-implemented using SCIP/LSP for dependency API indexing.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';

export class DependencyApiStage implements PipelineStage {
  readonly name = 'dependency-api';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const { db } = context;

    // Clear external symbols — SCIP handles external symbol resolution
    // natively via its symbol definition map.
    db.prepare('DELETE FROM external_symbols').run();

    if (!context.indexDependencies) return;

    // External symbol indexing via SCIP is handled by ScipIndexerStage.
    // The former tree-sitter .d.ts extraction path has been removed.
    context.log.indexing('dependency-api: external symbol indexing delegated to SCIP');
  }

  async dispose(): Promise<void> {}
}
