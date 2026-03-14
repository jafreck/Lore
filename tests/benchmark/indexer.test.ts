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

  it('runs configured coverage prep and ingests the generated report', async () => {
    const { repoPath, sha } = createLocalRepo();
    writeFileSync(
      join(repoPath, 'generate-coverage.mjs'),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('coverage', { recursive: true });",
        "writeFileSync('coverage/lcov.info', " + JSON.stringify('TN:\nSF:index.ts\nDA:1,1\nDA:2,1\nend_of_record\n') + ");",
      ].join('\n'),
    );
    mkdirSync(join(repoPath, 'coverage'), { recursive: true });

    const spec: RepoSpec = {
      name: 'local-coverage',
      url: repoPath,
      sha,
      languages: ['typescript'],
      size: 'small',
      structure: 'cli',
      coverage: {
        commands: [
          { command: 'node', args: ['generate-coverage.mjs'] },
        ],
        reportPath: 'coverage/lcov.info',
        format: 'lcov',
      },
    };

    const instance: RepoInstance = { spec, localPath: repoPath, indexed: false };
    const indexed = await indexRepo(instance, { mode: 'tree-sitter', historyDepth: 10 });
    const db = openReadOnly(indexed.dbPath!);
    try {
      const runs = db.prepare('SELECT COUNT(*) AS n FROM coverage_runs').get() as { n: number };
      const lines = db.prepare('SELECT COUNT(*) AS n FROM coverage_lines').get() as { n: number };
      expect(runs.n).toBe(1);
      expect(lines.n).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });
});