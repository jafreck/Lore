/**
 * @module cli/commands/index-cmd
 *
 * Handler for the `lore index` subcommand.
 */

import { flag, flags, usage, explicitLspEnabled, explicitScipEnabled, LANG_TO_EXTS } from '../args.js';
import {
  loadLspSettingsFromLoreConfig,
  resolveEffectiveLspSettings,
} from '../../lsp/config.js';
import {
  loadScipSettingsFromLoreConfig,
  resolveEffectiveScipSettings,
} from '../../scip/config.js';
import type { LoreLogger } from '../../logger.js';

export async function runIndexCommand(args: string[], _log: LoreLogger): Promise<void> {
  const rootDir = flag(args, '--root');
  const dbPath = flag(args, '--db');
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
  const embeddingModel = flag(args, '--embedding-model');
  const embeddingsEnabled = embeddingModel !== undefined || args.includes('--embeddings');
  if (args.includes('--embeddings') && args.includes('--no-embeddings')) {
    console.error('Error: --embeddings and --no-embeddings cannot be used together.\n');
    usage();
    return;
  }

  const indexDependencies = args.includes('--index-deps');
  const historyEnabled = args.includes('--history');
  const historyAll = args.includes('--history-all');
  const historyDepthRaw = flag(args, '--history-depth');
  const maxWorkersRaw = flag(args, '--max-workers');

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
    lspEnabled = explicitLspEnabled(args);
    scipEnabled = explicitScipEnabled(args);
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
      { ...(scipEnabled !== undefined && { enabled: scipEnabled }) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}\n`);
    process.exit(1);
    return;
  }

  const includeGlobs = flags(args, '--include');
  const excludeGlobs = flags(args, '--exclude');
  const languageNames = flags(args, '--language');

  // Resolve --language names to extensions
  let extensions: string[] | undefined;
  if (languageNames.length > 0) {
    extensions = [];
    for (const lang of languageNames) {
      const exts = LANG_TO_EXTS[lang];
      if (!exts) {
        console.error(`Error: unknown language "${lang}". Known languages: ${Object.keys(LANG_TO_EXTS).sort().join(', ')}\n`);
        process.exit(1);
        return;
      }
      extensions.push(...exts);
    }
  }

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
    lsp: lspSettings,
    scip: scipSettings,
    ...(embeddingModel && { embeddingModel }),
    ...(maxWorkers !== undefined && { maxWorkers }),
    ...(shouldEnableHistory && {
      history: {
        ...(historyDepth !== undefined && { depth: historyDepth }),
        ...(historyAll && { all: true }),
      },
    }),
  };

  const builder = new IndexBuilder(
    dbPath,
    {
      rootDir,
      ...(includeGlobs.length > 0 && { includeGlobs }),
      ...(excludeGlobs.length > 0 && { excludeGlobs }),
      ...(extensions && { extensions }),
    },
    embedder,
    options,
  );
  await builder.build();
}
