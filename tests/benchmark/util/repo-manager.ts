/**
 * @module benchmark/repo-manager
 *
 * Downloads, caches, and manages benchmark repository checkouts.
 * Repos are cloned on first use, then reset to the pinned SHA.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoSpec, RepoInstance } from './types.js';

const execFileAsync = promisify(execFile);

/** Default directory for benchmark repo checkouts. */
const DEFAULT_WORK_DIR = join(process.cwd(), '.benchmark');

/**
 * Manages the lifecycle of benchmark repo checkouts:
 * clone → pin SHA → clean reset between runs.
 */
export class RepoManager {
  private readonly workDir: string;
  private readonly instances = new Map<string, RepoInstance>();

  constructor(workDir?: string) {
    this.workDir = workDir ?? DEFAULT_WORK_DIR;
    mkdirSync(this.workDir, { recursive: true });
  }

  /** Clone or re-use a repo and reset it to the pinned SHA. */
  async prepare(spec: RepoSpec): Promise<RepoInstance> {
    const existing = this.instances.get(spec.name);
    if (existing) {
      await this.resetToSha(existing.localPath, spec.sha);
      return existing;
    }

    const localPath = join(this.workDir, spec.name);

    if (!existsSync(join(localPath, '.git'))) {
      // Clone with full history (needed for blame/history tasks)
      await this.clone(spec.url, localPath);
    }

    await this.resetToSha(localPath, spec.sha);

    const instance: RepoInstance = {
      spec,
      localPath,
      indexed: false,
    };
    this.instances.set(spec.name, instance);
    return instance;
  }

  /** Get a previously prepared repo instance. */
  get(name: string): RepoInstance | undefined {
    return this.instances.get(name);
  }

  /** Reset a repo checkout to a clean state at the pinned SHA. */
  async reset(name: string): Promise<void> {
    const inst = this.instances.get(name);
    if (!inst) throw new Error(`Repo "${name}" not prepared`);
    await this.resetToSha(inst.localPath, inst.spec.sha);
  }

  /** Remove a repo's local checkout entirely. */
  async remove(name: string): Promise<void> {
    const inst = this.instances.get(name);
    if (!inst) return;
    rmSync(inst.localPath, { recursive: true, force: true });
    this.instances.delete(name);
  }

  /** Remove all repo checkouts. */
  async removeAll(): Promise<void> {
    for (const name of this.instances.keys()) {
      await this.remove(name);
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async clone(url: string, dest: string): Promise<void> {
    mkdirSync(dest, { recursive: true });
    await execFileAsync('git', ['clone', '--no-checkout', url, dest], {
      timeout: 300_000, // 5 minutes
    });
  }

  private async resetToSha(repoPath: string, sha: string): Promise<void> {
    await execFileAsync('git', ['fetch', '--all'], {
      cwd: repoPath,
      timeout: 120_000,
    });
    await execFileAsync('git', ['checkout', sha], {
      cwd: repoPath,
      timeout: 60_000,
    });
    await execFileAsync('git', ['clean', '-fdx'], {
      cwd: repoPath,
      timeout: 60_000,
    });
  }
}
