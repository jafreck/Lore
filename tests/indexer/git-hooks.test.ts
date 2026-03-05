import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installGitHooks } from '../../src/indexer/git-hooks.js';

describe('installGitHooks', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-hooks-test-'));
    fs.mkdirSync(path.join(repoRoot, '.git', 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('should install expected hook files', () => {
    const result = installGitHooks({
      repoRoot,
      rootDir: repoRoot,
      dbPath: path.join(repoRoot, 'lore.db'),
      includeHistory: false,
    });

    expect(result.installed.sort()).toEqual([
      'post-checkout',
      'post-commit',
      'post-merge',
      'post-rewrite',
    ]);

    for (const hookName of result.installed) {
      const hookPath = path.join(repoRoot, '.git', 'hooks', hookName);
      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, 'utf8');
      expect(content).toContain('lore auto-refresh');
      expect(content).toContain('npx @jafreck/lore refresh');
    }
  });

  it('should include --history in hook command when requested', () => {
    installGitHooks({
      repoRoot,
      rootDir: repoRoot,
      dbPath: path.join(repoRoot, 'lore.db'),
      includeHistory: true,
    });

    const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('--history');
  });

  it('should not include LSP flags when lspEnabled is omitted', () => {
    installGitHooks({
      repoRoot,
      rootDir: repoRoot,
      dbPath: path.join(repoRoot, 'lore.db'),
    });

    const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).not.toContain('--lsp');
    expect(content).not.toContain('--no-lsp');
  });

  it('should include --lsp in hook command when requested', () => {
    installGitHooks({
      repoRoot,
      rootDir: repoRoot,
      dbPath: path.join(repoRoot, 'lore.db'),
      lspEnabled: true,
    });

    const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('--lsp');
    expect(content).not.toContain('--no-lsp');
  });

  it('should include --no-lsp in hook command when requested', () => {
    installGitHooks({
      repoRoot,
      rootDir: repoRoot,
      dbPath: path.join(repoRoot, 'lore.db'),
      lspEnabled: false,
    });

    const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('--no-lsp');
    expect(content).not.toContain('--lsp ');
  });

  it('should preserve existing hook content while adding lore block', () => {
    const hookPath = path.join(repoRoot, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hookPath, '#!/usr/bin/env sh\necho "custom"\n', 'utf8');

    installGitHooks({
      repoRoot,
      rootDir: repoRoot,
      dbPath: path.join(repoRoot, 'lore.db'),
      includeHistory: false,
    });

    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain('echo "custom"');
    expect(content).toContain('# --- lore auto-refresh (start) ---');
  });
});
