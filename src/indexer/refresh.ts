import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Database } from '../db/schema.js';
import { walkFiles, type FileEntry, type WalkerConfig } from '../discovery/walker.js';
import { throwIfPipelineCancelled } from './pipeline.js';

export interface RefreshChangeOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  selectedFiles?: readonly FileEntry[];
}

/** Resolve the branch exactly as `IndexBuilder` does. */
export function resolveIndexBranch(config: WalkerConfig): string {
  if (config.branch) return config.branch;
  try {
    return execFileSync(
      'git',
      ['-C', config.rootDir, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * Diff the configured filesystem scope against persisted effective file hashes.
 * The result contains only created, content-changed, and deleted paths.
 */
export async function collectRefreshChanges(
  db: Database.Database,
  walkerConfig: WalkerConfig,
  branch: string,
  options: RefreshChangeOptions = {},
): Promise<string[]> {
  const currentFiles = options.selectedFiles ?? await walkFiles(walkerConfig);
  const persistedRows = db.prepare(
    'SELECT path, last_hash FROM effective_files WHERE branch = ?',
  ).all(branch) as Array<{ path: string; last_hash: string | null }>;
  const persisted = new Map(persistedRows.map((row) => [row.path, row.last_hash]));
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const changed = new Set<string>();

  const HASH_BATCH_SIZE = 64;
  for (let start = 0; start < currentFiles.length; start += HASH_BATCH_SIZE) {
    throwIfPipelineCancelled(options);
    const batch = currentFiles.slice(start, start + HASH_BATCH_SIZE);
    const hashes = await Promise.all(batch.map(async (file) => {
      try {
        const source = await fs.promises.readFile(file.path);
        return crypto.createHash('sha256').update(source).digest('hex');
      } catch {
        return null;
      }
    }));
    for (let index = 0; index < batch.length; index++) {
      const file = batch[index]!;
      const hash = hashes[index];
      if ((hash === null && persisted.has(file.path))
        || (hash !== null && persisted.get(file.path) !== hash)) {
        changed.add(file.path);
      }
    }
  }

  for (const path of persisted.keys()) {
    if (!currentPaths.has(path)) changed.add(path);
  }

  return [...changed].sort((left, right) => left.localeCompare(right));
}
