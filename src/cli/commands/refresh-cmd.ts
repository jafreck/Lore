/**
 * @module cli/commands/refresh-cmd
 *
 * Handler for the `lore refresh` subcommand (includes watch/poll modes).
 */

import * as fs from 'node:fs';
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

export async function runRefreshCommand(args: string[], log: LoreLogger): Promise<void> {
  const dbPath = flag(args, '--db');
  const rootDir = flag(args, '--root');

  if (!dbPath || !rootDir) {
    console.error('Error: --db <path> and --root <dir> are required for the refresh subcommand.\n');
    usage();
    return;
  }

  const watchMode = args.includes('--watch');
  const pollMode = args.includes('--poll');
  const indexDependencies = args.includes('--index-deps');

  const historyEnabled = args.includes('--history');
  const historyAll = args.includes('--history-all');
  const historyDepthRaw = flag(args, '--history-depth');

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
  let scipEnabled2: boolean | undefined;
  try {
    lspEnabled = explicitLspEnabled(args);
    scipEnabled2 = explicitScipEnabled(args);
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
      { ...(scipEnabled2 !== undefined && { enabled: scipEnabled2 }) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}\n`);
    process.exit(1);
    return;
  }

  const shouldEnableHistory = historyEnabled || historyAll || historyDepth !== undefined;
  const historyOption = shouldEnableHistory
    ? {
        ...(historyDepth !== undefined && { depth: historyDepth }),
        ...(historyAll && { all: true }),
      }
    : false;

  const walkerConfig = {
    rootDir,
  };
  const refreshOptions = {
    indexDependencies,
    lsp: lspSettings,
    scip: scipSettings,
    ...(shouldEnableHistory && { history: historyOption }),
  };

  // Build an optional long-lived embedder for watch/poll modes.
  const embeddingModel = flag(args, '--embedding-model');

  if (watchMode || pollMode) {
    const { LoreRuntime } = await import('../../runtime.js');
    const runtime = new LoreRuntime({
      dbPath,
      rootDir,
      walkerConfig,
      lsp: lspSettings,
      scip: scipSettings,
      history: shouldEnableHistory ? historyOption : false,
      indexDependencies,
      embeddingModel: embeddingModel ?? undefined,
      refreshMode: watchMode ? 'watch' : 'poll',
    }, log);

    await runtime.start();
    runtime.installSignalHandlers();
  } else {
    // Manual refresh: full build if DB doesn't exist yet, otherwise incremental update
    const { IndexBuilder } = await import('../../indexer/index.js');
    const builder = new IndexBuilder(dbPath, walkerConfig, undefined, {
      ...refreshOptions,
    });

    const dbExists = fs.existsSync(dbPath);
    if (dbExists) {
      const [{ openDb }, { walkFiles }] = await Promise.all([
        import('../../db/schema.js'),
        import('../../discovery/walker.js'),
      ]);
      const files = await walkFiles(walkerConfig);
      const db = openDb(dbPath);
      const branch = 'HEAD';
      let indexedPaths: string[];
      try {
        indexedPaths = (
          db.prepare('SELECT path FROM files WHERE branch = ?').all(branch) as Array<{ path: string }>
        ).map((row) => row.path);
      } finally {
        db.close();
      }
      const changedPaths = [...new Set([...files.map(f => f.path), ...indexedPaths])];
      await builder.update(changedPaths);
    } else {
      await builder.build();
    }

    process.stderr.write(
      JSON.stringify({ level: 'info', source: 'cli', message: 'refresh complete', rootDir }) + '\n',
    );
  }
}
