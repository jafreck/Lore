/**
 * @module indexer/stages/history
 *
 * Pipeline stage: ingest git commit history.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { ingestGitHistory } from '../git-history.js';

export class HistoryStage implements PipelineStage {
  readonly name = 'history';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    if (!context.history) return;

    context.log.indexing('git history ingestion started');
    const historyOptions =
      typeof context.history === 'object' ? context.history : undefined;
    await ingestGitHistory(context.db, context.walkerConfig.rootDir, historyOptions);
    context.log.indexing('git history ingestion complete');
  }
}
