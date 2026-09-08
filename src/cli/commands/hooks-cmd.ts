/**
 * @module cli/commands/hooks-cmd
 *
 * Handler for the `lore hooks` subcommand.
 */

import {
  parseCliArgs,
  usage,
  explicitLspEnabled,
  explicitScipEnabled,
  executionOptionsFromArgs,
} from '../args.js';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { LoreLogger } from '../../logger.js';

export async function runHooksCommand(args: string[], _log: LoreLogger): Promise<void> {
  const parsedArgs = parseCliArgs(args, 'hooks');
  const dbPath = parsedArgs.value('--db');
  const rootDir = parsedArgs.value('--root');

  if (!dbPath || !rootDir) {
    console.error('Error: --db <path> and --root <dir> are required for the hooks subcommand.\n');
    usage();
    return;
  }

  const historyEnabled = parsedArgs.has('--history');
  const historyAll = parsedArgs.has('--history-all');
  const historyDepthRaw = parsedArgs.value('--history-depth');
  const includeHistory = historyEnabled || historyAll || historyDepthRaw !== undefined;

  let lspEnabled: boolean | undefined;
  let scipEnabled: boolean | undefined;
  try {
    lspEnabled = explicitLspEnabled(parsedArgs);
    scipEnabled = explicitScipEnabled(parsedArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}.\n`);
    usage();
    return;
  }

  const { installGitHooks } = await import('../../git/hooks.js');
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('Cannot determine the current Lore CLI executable');
  const pinnedCliEntry = realpathSync(resolve(cliEntry));
  const result = installGitHooks({
    repoRoot: rootDir,
    rootDir,
    dbPath,
    includeHistory,
    lspEnabled,
    scipEnabled,
    execution: executionOptionsFromArgs(parsedArgs),
    loreCommand: [process.execPath, pinnedCliEntry],
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
