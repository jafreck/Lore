/**
 * @module indexer/stages/import-resolution
 *
 * Pipeline stage: resolve raw import strings to file IDs and populate
 * `external_deps` for external packages.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';

/**
 * Placeholder stage for import resolution.
 *
 * Currently the import resolution is performed inside `IndexBuilder` via
 * `resolveImports()`.  This stage documents the intended boundary.
 */
export class ImportResolutionStage implements PipelineStage {
  readonly name = 'import-resolution';

  async execute(_context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    // Import resolution is currently performed by IndexBuilder.
    // This stage is a structural placeholder.
  }
}
