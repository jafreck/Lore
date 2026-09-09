/**
 * @module cli/commands/index-cmd
 *
 * Handler for the `lore index` subcommand.
 */

import {
  parseCliArgs,
  usage,
  explicitLspEnabled,
  explicitScipEnabled,
  executionOptionsFromArgs,
  validationPolicyFromArgs,
  walkerConfigFromArgs,
  scipScopeFromArgs,
} from '../args.js';
import type { LoreLogger } from '../../logger.js';

export async function runIndexCommand(args: string[], _log: LoreLogger): Promise<void> {
  const parsedArgs = parseCliArgs(args, 'index');
  const rootDir = parsedArgs.value('--root');
  const dbPath = parsedArgs.value('--db');
  if (!rootDir) {
    console.error('Error: --root <dir> is required for the index subcommand.\n');
    usage();
    return;
  }
  if (!dbPath) {
    console.error('Error: --db <path> is required for the index subcommand.\n');
    usage();
    return;
  }
  const embeddingModel = parsedArgs.value('--embedding-model');
  const embeddingsEnabled = embeddingModel !== undefined || parsedArgs.has('--embeddings');

  const indexDependencies = parsedArgs.has('--index-deps');
  const historyEnabled = parsedArgs.has('--history');
  const historyAll = parsedArgs.has('--history-all');
  const historyDepthRaw = parsedArgs.value('--history-depth');
  const maxWorkersRaw = parsedArgs.value('--max-workers');

  let maxWorkers: number | undefined;
  if (maxWorkersRaw !== undefined) {
    const parsed = Number(maxWorkersRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error('Error: --max-workers must be a positive integer.\n');
      usage();
      return;
    }
    maxWorkers = parsed;
  }

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

  let validation;
  try {
    validation = validationPolicyFromArgs(parsedArgs, { includeScope: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}.\n`);
    process.exit(1);
    return;
  }

  const walkerConfig = walkerConfigFromArgs(parsedArgs, rootDir);

  const { IndexBuilder } = await import('../../indexer/index.js');

  // Create an embedding provider when embeddings are enabled.
  let embedder: import('../../embeddings/embedder.js').EmbeddingProvider | undefined;
  if (embeddingsEnabled) {
    const { LazyEmbeddingProvider, DEFAULT_EMBEDDING_MODEL } = await import('../../embeddings/embedder.js');
    embedder = new LazyEmbeddingProvider(embeddingModel ?? DEFAULT_EMBEDDING_MODEL);
  }

  const shouldEnableHistory = historyEnabled || historyAll || historyDepth !== undefined;
  const options = {
    indexDependencies,
    scipScope: scipScopeFromArgs(parsedArgs),
    embeddings: embeddingsEnabled,
    execution: executionOptionsFromArgs(parsedArgs),
    ...(lspEnabled !== undefined && { lsp: lspEnabled }),
    ...(scipEnabled !== undefined && { scip: scipEnabled }),
    ...(embeddingModel && { embeddingModel }),
    ...(maxWorkers !== undefined && { maxWorkers }),
    ...(validation && { validation }),
    ...(shouldEnableHistory && {
      history: {
        ...(historyDepth !== undefined && { depth: historyDepth }),
        ...(historyAll && { all: true }),
      },
    }),
  };

  const builder = new IndexBuilder(
    dbPath,
    walkerConfig,
    embedder,
    options,
  );
  await builder.build();
}
