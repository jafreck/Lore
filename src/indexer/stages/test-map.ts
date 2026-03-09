/**
 * @module indexer/stages/test-map
 *
 * Pipeline stage: refresh test file mappings.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { refreshTestMappings } from '../test-mapper.js';

export class TestMapStage implements PipelineStage {
  readonly name = 'test-map';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    refreshTestMappings(context.db, context.branch);
  }
}
