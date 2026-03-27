/**
 * @module indexer/git-hooks
 *
 * Utilities for installing Git hooks that keep a Lore index up to date.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InstallGitHooksOptions {
  repoRoot: string;
  rootDir: string;
  dbPath: string;
  includeHistory?: boolean;
  lspEnabled?: boolean;
  scipEnabled?: boolean;
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
  scipEnabled: boolean | undefined,
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
    ...(lspEnabled === true ? ['--lsp'] : []),
    ...(scipEnabled === false ? ['--no-scip'] : []),
  ].join(' ');

  return [
    '#!/usr/bin/env sh',
    'set -e',
    `${cmd} >/dev/null 2>&1 || true`,
    '',
  ].join('\n');
}

/**
 * Resolve the actual git directory for a repository. In normal repos, `.git`
 * is a directory. In worktrees, `.git` is a file containing `gitdir: <path>`.
 */
function resolveGitDir(repoRoot: string): string {
  const dotGit = path.join(repoRoot, '.git');
  const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Not a git repository: ${repoRoot}`);

  if (stat.isFile()) {
    // Worktree: .git is a file with "gitdir: <path>"
    const content = fs.readFileSync(dotGit, 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) throw new Error('Invalid .git file');
    const gitdir = match[1]!;
    // Resolve relative paths against the repo root
    return path.resolve(repoRoot, gitdir);
  }

  return dotGit; // Normal repo: .git is a directory
}

/**
 * Install Lore-refresh git hooks in the git directory's `hooks/` folder for
 * common lifecycle events. Supports both normal repos and worktrees.
 * Existing non-Lore hooks are preserved by prepending a Lore block.
 */
export function installGitHooks(options: InstallGitHooksOptions): { installed: string[] } {
  const repoRoot = options.repoRoot;
  const gitDir = resolveGitDir(repoRoot);
  const hookDir = path.join(gitDir, 'hooks');

  fs.mkdirSync(hookDir, { recursive: true });

  const loreBlock = [
    '# --- lore auto-refresh (start) ---',
    makeHookScript(
      options.rootDir,
      options.dbPath,
      options.includeHistory ?? false,
      options.lspEnabled,
      options.scipEnabled,
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
      content = `#!/usr/bin/env sh\nset -e\n\n${loreBlock}`;
    }

    fs.writeFileSync(hookPath, content, 'utf8');
    fs.chmodSync(hookPath, 0o755);
    installed.push(hookName);
  }

  return { installed };
}
