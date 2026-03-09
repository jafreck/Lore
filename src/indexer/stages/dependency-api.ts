/**
 * @module indexer/stages/dependency-api
 *
 * Pipeline stage: index external dependency declarations (.d.ts files).
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';

/**
 * Placeholder stage for dependency API indexing.
 *
 * Currently the dependency indexing is performed inside `IndexBuilder` via
 * `indexDependencyDeclarations()`.  This stage documents the intended boundary.
 */
export class DependencyApiStage implements PipelineStage {
  readonly name = 'dependency-api';

  async execute(_context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    // Dependency indexing is currently performed by IndexBuilder.
    // This stage is a structural placeholder.
  }
}
