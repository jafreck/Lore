import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { installGitHooks, type InstallGitHooksOptions } from '../../src/git/hooks.js';

let tmpDir: string;

function createGitDir(): void {
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
}

function createGitWorktreeFile(gitdir: string): void {
  fs.writeFileSync(path.join(tmpDir, '.git'), `gitdir: ${gitdir}\n`);
}

function defaultOptions(overrides?: Partial<InstallGitHooksOptions>): InstallGitHooksOptions {
  return {
    repoRoot: tmpDir,
    rootDir: tmpDir,
    dbPath: path.join(tmpDir, 'lore.db'),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hooks-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('installGitHooks', () => {
  it('creates hook files in .git/hooks/', () => {
    createGitDir();
    const result = installGitHooks(defaultOptions());

    expect(result.installed).toContain('post-commit');
    expect(result.installed).toContain('post-merge');
    expect(result.installed).toContain('post-checkout');
    expect(result.installed).toContain('post-rewrite');
    expect(result.installed.length).toBe(4);

    for (const hookName of result.installed) {
      const hookPath = path.join(tmpDir, '.git', 'hooks', hookName);
      expect(fs.existsSync(hookPath)).toBe(true);

      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('lore auto-refresh');
      expect(content).toContain('#!/usr/bin/env sh');

      // Check executable permission
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('hook script contains correct command arguments', () => {
    createGitDir();
    installGitHooks(defaultOptions({ includeHistory: true }));

    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(content).toContain('--history');
    expect(content).toContain('--root');
    expect(content).toContain('--db');
  });

  it('includes --lsp when lspEnabled is true', () => {
    createGitDir();
    installGitHooks(defaultOptions({ lspEnabled: true }));

    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(content).toContain('--lsp');
  });

  it('includes --no-scip when scipEnabled is false', () => {
    createGitDir();
    installGitHooks(defaultOptions({ scipEnabled: false }));

    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(content).toContain('--no-scip');
  });

  it('preserves existing non-Lore hook content', () => {
    createGitDir();
    const hookDir = path.join(tmpDir, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'post-commit'), '#!/bin/sh\necho "existing"\n');

    installGitHooks(defaultOptions());

    const content = fs.readFileSync(path.join(hookDir, 'post-commit'), 'utf8');
    expect(content).toContain('echo "existing"');
    expect(content).toContain('lore auto-refresh');
  });

  it('replaces existing Lore block on re-install', () => {
    createGitDir();

    // Install once
    installGitHooks(defaultOptions());
    // Install again
    installGitHooks(defaultOptions());

    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
    const matches = content.match(/lore auto-refresh \(start\)/g);
    expect(matches?.length).toBe(1);
  });

  it('supports worktree repos where .git is a file', () => {
    const actualGitDir = path.join(tmpDir, 'actual-git-dir');
    fs.mkdirSync(actualGitDir, { recursive: true });
    createGitWorktreeFile(actualGitDir);

    const result = installGitHooks(defaultOptions());
    expect(result.installed.length).toBe(4);

    const hookPath = path.join(actualGitDir, 'hooks', 'post-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it('throws when .git does not exist', () => {
    expect(() => installGitHooks(defaultOptions())).toThrow('Not a git repository');
  });

  it('escapes single quotes in paths', () => {
    createGitDir();
    const dbPath = path.join(tmpDir, "it's", 'lore.db');

    installGitHooks(defaultOptions({ dbPath }));

    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'), 'utf8');
    // Single quotes should be properly escaped
    expect(content).toContain('lore');
  });
});
