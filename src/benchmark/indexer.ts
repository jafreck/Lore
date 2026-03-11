/**
 * @module benchmark/indexer
 *
 * Builds a Lore index for a benchmark repo using the IndexBuilder API.
 */

import { join } from 'node:path';
import { IndexBuilder } from '../indexer/index.js';
import type { WalkerConfig } from '../discovery/walker.js';
import type { RepoInstance } from './types.js';

/**
 * Run the Lore indexer on a repo checkout, producing a .lore.db file.
 * Returns the updated RepoInstance with dbPath and timing info.
 */
export async function indexRepo(instance: RepoInstance): Promise<RepoInstance> {
  const dbPath = join(instance.localPath, '.lore.db');
  const walkerConfig: WalkerConfig = {
    rootDir: instance.localPath,
  };

  const start = performance.now();

  const builder = new IndexBuilder(dbPath, walkerConfig, undefined, {
    history: { depth: 100 },
    docsAutoNotes: true,
    indexDependencies: false,
  });

  await builder.build();

  const elapsed = Math.round(performance.now() - start);

  return {
    ...instance,
    dbPath,
    indexed: true,
    indexTimeMs: elapsed,
  };
}
