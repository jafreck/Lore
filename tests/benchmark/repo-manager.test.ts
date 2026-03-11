/**
 * Unit tests for the repo manager.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { RepoManager } from '../../src/benchmark/repo-manager.js';
import type { RepoSpec } from '../../src/benchmark/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a tiny local git repo for testing (avoids network). */
function createLocalGitRepo(): { path: string; sha: string; url: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bench-git-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'index.ts'), 'export const x = 1;');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  return { path: dir, sha, url: dir };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RepoManager', () => {
  let workDir: string;
  let manager: RepoManager;

  afterEach(async () => {
    if (manager) await manager.removeAll();
  });

  it('should create work directory', () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-work-'));
    const dir = join(workDir, 'repos');
    manager = new RepoManager(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('should clone and reset a local repo', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-work-'));
    manager = new RepoManager(workDir);
    const { sha, url } = createLocalGitRepo();

    const spec: RepoSpec = {
      name: 'test-local',
      url,
      sha,
      languages: ['typescript'],
      size: 'small',
      structure: 'cli',
    };

    const instance = await manager.prepare(spec);
    expect(instance.localPath).toBe(join(workDir, 'test-local'));
    expect(existsSync(join(instance.localPath, 'index.ts'))).toBe(true);
  });

  it('should reuse existing checkout on second prepare', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-work-'));
    manager = new RepoManager(workDir);
    const { sha, url } = createLocalGitRepo();

    const spec: RepoSpec = {
      name: 'test-reuse',
      url,
      sha,
      languages: ['typescript'],
      size: 'small',
      structure: 'cli',
    };

    const inst1 = await manager.prepare(spec);
    const inst2 = await manager.prepare(spec);
    expect(inst1.localPath).toBe(inst2.localPath);
  });

  it('should remove a repo', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-work-'));
    manager = new RepoManager(workDir);
    const { sha, url } = createLocalGitRepo();

    const spec: RepoSpec = {
      name: 'test-remove',
      url,
      sha,
      languages: ['typescript'],
      size: 'small',
      structure: 'cli',
    };

    const instance = await manager.prepare(spec);
    expect(existsSync(instance.localPath)).toBe(true);

    await manager.remove('test-remove');
    expect(existsSync(instance.localPath)).toBe(false);
    expect(manager.get('test-remove')).toBeUndefined();
  });

  it('should return undefined for unknown repo', () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-work-'));
    manager = new RepoManager(workDir);
    expect(manager.get('nonexistent')).toBeUndefined();
  });
});
