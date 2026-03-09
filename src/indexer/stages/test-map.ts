/**
 * @module indexer/stages/test-map
 *
 * Pipeline stage: refresh test-to-source file mappings.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { refreshTestMappings } from '../test-mapper.js';

/**
 * Refresh test file mappings by matching source files to their test counterparts
 * using naming conventions and import analysis.
 */
export class TestMapStage implements PipelineStage {
  readonly name = 'test-map';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    refreshTestMappings(context.db, context.branch);
  }
}
