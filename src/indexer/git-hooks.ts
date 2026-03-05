/**
 * @module indexer/git-hooks
 *
 * Utilities for installing Git hooks that keep a Lore index up to date.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface InstallGitHooksOptions {
  repoRoot: string;
  rootDir: string;
  dbPath: string;
  includeHistory?: boolean;
  lspEnabled?: boolean;
}

const HOOK_NAMES = ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite'] as const;

function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function makeHookScript(
  rootDir: string,
  dbPath: string,
  includeHistory: boolean,
  lspEnabled: boolean | undefined,
): string {
  const cmd = [
    'npx',
    '@jafreck/lore',
    'refresh',
    '--root',
    shellEscapeSingle(rootDir),
    '--db',
    shellEscapeSingle(dbPath),
    ...(includeHistory ? ['--history'] : []),
    ...(lspEnabled === true ? ['--lsp'] : lspEnabled === false ? ['--no-lsp'] : []),
  ].join(' ');

  return [
    '#!/usr/bin/env sh',
    'set -e',
    `${cmd} >/dev/null 2>&1 || true`,
    '',
  ].join('\n');
}

/**
 * Install Lore-refresh git hooks in `.git/hooks` for common lifecycle events.
 * Existing non-Lore hooks are preserved by prepending a Lore block.
 */
export function installGitHooks(options: InstallGitHooksOptions): { installed: string[] } {
  const repoRoot = options.repoRoot;
  const hookDir = path.join(repoRoot, '.git', 'hooks');

  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }

  fs.mkdirSync(hookDir, { recursive: true });

  const loreBlock = [
    '# --- lore auto-refresh (start) ---',
    makeHookScript(
      options.rootDir,
      options.dbPath,
      options.includeHistory ?? false,
      options.lspEnabled,
    ).trimEnd(),
    '# --- lore auto-refresh (end) ---',
    '',
  ].join('\n');

  const installed: string[] = [];

  for (const hookName of HOOK_NAMES) {
    const hookPath = path.join(hookDir, hookName);
    let existing = '';
    if (fs.existsSync(hookPath)) {
      existing = fs.readFileSync(hookPath, 'utf8');
      existing = existing.replace(/# --- lore auto-refresh \(start\) ---[\s\S]*?# --- lore auto-refresh \(end\) ---\n?/g, '');
    }

    let content = '';
    if (existing.trim().length > 0) {
      content = `${existing.trimEnd()}\n\n${loreBlock}`;
    } else {
      content = loreBlock;
    }

    fs.writeFileSync(hookPath, content, 'utf8');
    try {
      execFileSync('chmod', ['+x', hookPath]);
    } catch {
      fs.chmodSync(hookPath, 0o755);
    }
    installed.push(hookName);
  }

  return { installed };
}
