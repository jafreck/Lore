/**
 * Focused tests for benchmark repo indexing helpers.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openReadOnly } from '../../src/db/read-only.js';
import { indexRepo } from './util/indexer.js';
import type { RepoInstance, RepoSpec } from './util/types.js';

function createLocalRepo(): { repoPath: string; sha: string } {
  const repoPath = mkdtempSync(join(tmpdir(), 'bench-indexer-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Benchmark Test'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'index.ts'), 'export function answer() { return 42; }\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'index.ts'), 'export function answer() { return 43; }\n');
  execFileSync('git', ['commit', '-am', 'second'], { cwd: repoPath });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
  return { repoPath, sha };
}

describe('benchmark indexer', () => {
  it('ingests git history during benchmark indexing', async () => {
    const { repoPath, sha } = createLocalRepo();
    const spec: RepoSpec = {
      name: 'local-history',
      url: repoPath,
      sha,
      languages: ['typescript'],
      size: 'small',
      structure: 'cli',
    };

    const instance: RepoInstance = { spec, localPath: repoPath, indexed: false };
    const indexed = await indexRepo(instance, { mode: 'tree-sitter', historyDepth: 10 });
    const db = openReadOnly(indexed.dbPath!);
    try {
      const commits = db.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number };
      expect(commits.n).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });
});