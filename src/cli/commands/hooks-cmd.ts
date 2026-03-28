/**
 * @module cli/commands/hooks-cmd
 *
 * Handler for the `lore hooks` subcommand.
 */

import { flag, usage, explicitLspEnabled, explicitScipEnabled } from '../args.js';
import {
  loadLspSettingsFromLoreConfig,
  resolveEffectiveLspSettings,
} from '../../lsp/config.js';
import {
  loadScipSettingsFromLoreConfig,
  resolveEffectiveScipSettings,
} from '../../scip/config.js';
import type { LoreLogger } from '../../logger.js';

export async function runHooksCommand(args: string[], _log: LoreLogger): Promise<void> {
  const dbPath = flag(args, '--db');
  const rootDir = flag(args, '--root');

  if (!dbPath || !rootDir) {
    console.error('Error: --db <path> and --root <dir> are required for the hooks subcommand.\n');
    usage();
    return;
  }

  const historyEnabled = args.includes('--history');
  const historyAll = args.includes('--history-all');
  const historyDepthRaw = flag(args, '--history-depth');
  const includeHistory = historyEnabled || historyAll || historyDepthRaw !== undefined;

  let lspEnabled: boolean | undefined;
  let scipEnabled3: boolean | undefined;
  try {
    lspEnabled = explicitLspEnabled(args);
    scipEnabled3 = explicitScipEnabled(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}.\n`);
    usage();
    return;
  }

  let lspSettings;
  try {
    const lspConfig = loadLspSettingsFromLoreConfig(rootDir);
    lspSettings = resolveEffectiveLspSettings(
      lspConfig,
      { ...(lspEnabled !== undefined && { enabled: lspEnabled }) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}\n`);
    process.exit(1);
    return;
  }

  let scipSettings;
  try {
    const scipConfig = loadScipSettingsFromLoreConfig(rootDir);
    scipSettings = resolveEffectiveScipSettings(
      scipConfig,
      { ...(scipEnabled3 !== undefined && { enabled: scipEnabled3 }) },
    );
  } catch {
    // SCIP config errors in hooks are non-fatal.
  }

  const { installGitHooks } = await import('../../git/hooks.js');
  const result = installGitHooks({
    repoRoot: rootDir,
    rootDir,
    dbPath,
    includeHistory,
    lspEnabled: lspSettings.enabled,
    scipEnabled: scipSettings?.enabled ?? false,
  });

  process.stderr.write(
    JSON.stringify({
      level: 'info',
      source: 'cli',
      message: 'git hooks installed',
      rootDir,
      hooks: result.installed,
    }) + '\n',
  );
}
