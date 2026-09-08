/**
 * @module cli/commands/refresh-cmd
 *
 * Handler for the `lore refresh` subcommand (includes watch/poll modes).
 */

import {
  parseCliArgs,
  usage,
  explicitLspEnabled,
  explicitScipEnabled,
  executionOptionsFromArgs,
  walkerConfigFromArgs,
} from '../args.js';
import type { LoreLogger } from '../../logger.js';

export async function runRefreshCommand(args: string[], log: LoreLogger): Promise<void> {
  const parsedArgs = parseCliArgs(args, 'refresh');
  const dbPath = parsedArgs.value('--db');
  const rootDir = parsedArgs.value('--root');

  if (!dbPath || !rootDir) {
    console.error('Error: --db <path> and --root <dir> are required for the refresh subcommand.\n');
    usage();
    return;
  }

  const watchMode = parsedArgs.has('--watch');
  const pollMode = parsedArgs.has('--poll');
  const indexDependencies = parsedArgs.has('--index-deps');

  const historyEnabled = parsedArgs.has('--history');
  const historyAll = parsedArgs.has('--history-all');
  const historyDepthRaw = parsedArgs.value('--history-depth');

  let historyDepth: number | undefined;
  if (historyDepthRaw !== undefined) {
    const parsed = Number(historyDepthRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error('Error: --history-depth must be a positive number.\n');
      usage();
      return;
    }
    historyDepth = Math.floor(parsed);
  }

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

  const shouldEnableHistory = historyEnabled || historyAll || historyDepth !== undefined;
  const historyOption = shouldEnableHistory
    ? {
        ...(historyDepth !== undefined && { depth: historyDepth }),
        ...(historyAll && { all: true }),
      }
    : false;

  const embeddingModel = parsedArgs.value('--embedding-model');
  const embeddingPreference = parsedArgs.has('--no-embeddings')
    ? false
    : (parsedArgs.has('--embeddings') || embeddingModel !== undefined ? true : undefined);
  const walkerConfig = walkerConfigFromArgs(parsedArgs, rootDir);
  const refreshOptions = {
    indexDependencies,
    ...(embeddingPreference !== undefined && { embeddings: embeddingPreference }),
    execution: executionOptionsFromArgs(parsedArgs),
    ...(embeddingModel && { embeddingModel }),
    ...(lspEnabled !== undefined && { lsp: lspEnabled }),
    ...(scipEnabled !== undefined && { scip: scipEnabled }),
    ...(shouldEnableHistory && { history: historyOption }),
  };

  // Build an optional long-lived embedder for watch/poll modes.
  const { IndexBuilder } = await import('../../indexer/index.js');
  const builder = new IndexBuilder(dbPath, walkerConfig, undefined, refreshOptions);

  if (watchMode || pollMode) {
    const configuration = await builder.resolveConfiguration();
    const { LoreRuntime } = await import('../../runtime.js');
    const runtime = new LoreRuntime({
      dbPath,
      rootDir,
      walkerConfig,
      lsp: configuration.lsp,
      scip: configuration.scip,
      execution: refreshOptions.execution,
      history: shouldEnableHistory ? historyOption : false,
      indexDependencies,
      ...(embeddingPreference !== undefined && { embeddings: embeddingPreference }),
      embeddingModel: embeddingModel ?? undefined,
      refreshMode: watchMode ? 'watch' : 'poll',
    }, log);

    await runtime.start();
    runtime.installSignalHandlers();
  } else {
    // Manual refresh: hash persisted effective files and update only actual
    // creations, content changes, and deletions. An uninitialized database is
    // reconciled through the same atomic full-build path.
    await builder.refresh();

    process.stderr.write(
      JSON.stringify({ level: 'info', source: 'cli', message: 'refresh complete', rootDir }) + '\n',
    );
  }
}
