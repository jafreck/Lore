#!/usr/bin/env node
/**
 * @module cli
 *
 * Lore CLI — unified entry point for indexing and the MCP server.
 *
 * Usage:
 *   lore index --root <dir> --db <path> [--embedding-model <id>]
 *                              Index a codebase into a knowledge-base file.
 *   lore mcp --db <path>                        Start the knowledge-base MCP server (stdio transport).
 *   lore refresh --db <path> --root <dir>       Run an incremental index update and exit.
 *   lore refresh --db <path> --root <dir> --watch  Watch for changes and refresh automatically.
 *   lore refresh --db <path> --root <dir> --poll   Poll for changes and refresh automatically.
 *   lore hooks --root <dir> --db <path>         Install git hooks for automatic Lore refresh.
 *   lore ingest-coverage --db <path> --root <dir> --file <path> --format <lcov|cobertura>
 *                         Ingest a coverage report file into the knowledge base.
 */

import * as fs from 'node:fs';
import {
  loadLspSettingsFromLoreConfig,
  resolveEffectiveLspSettings,
} from './indexer/lsp/config.js';
import {
  loadScipSettingsFromLoreConfig,
  resolveEffectiveScipSettings,
} from './indexer/scip/config.js';
import { initLogger, LogLevel, LOG_LEVEL_NAMES } from './logger.js';
import { killAllTracked } from './process-tracker.js';
import { LoreRuntime } from './runtime.js';

// ─── Argument helpers ─────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    `Usage:
  lore index --root <dir> --db <path> [--embedding-model <id>] [--index-deps] [--history] [--history-depth <n>] [--history-all]
                         Index a codebase into a knowledge-base SQLite file
  lore mcp --db <path> [--root <dir> --watch|--poll]  Start the Lore MCP server (stdio transport), optionally with live indexing
  lore refresh --db <path> --root <dir> [--index-deps] [--history] [--history-depth <n>] [--history-all]  Run an incremental index update and exit
  lore refresh --db <path> --root <dir> --watch [--embedding-model <id>] Watch for file changes and refresh automatically
  lore refresh --db <path> --root <dir> --poll [--embedding-model <id>]  Poll for file changes and refresh automatically
  lore hooks --db <path> --root <dir> [--history] [--history-depth <n>] [--history-all] [--lsp] [--no-lsp]
                         Install git hooks for automatic refresh on commit/merge/checkout
  lore ingest-coverage --db <path> --root <dir> --file <path> --format <lcov|cobertura> [--commit <sha>]
                         Ingest an explicit coverage report file into the knowledge base
  lore analyze --db <path> [--mode <mode>] [--edge-kinds <kind>] [--branch <name>] [--max-lines <n>]
                         Run graph analysis on the knowledge-base (cycles, components, clusters, summary)

Options:
  --root <dir>             Root directory to index (required for index, refresh)
  --db <path>              Path to a Lore knowledge-base SQLite file (required for index, mcp, refresh)
  --embedding-model <id>   Embedding model identifier (default: Qwen/Qwen3-Embedding-4B)
  --index-deps             Enable dependency API indexing (disabled by default)
  --history                Enable git history ingestion
  --history-depth <n>      Limit commit ingestion to the most recent N commits
  --history-all            Traverse all refs (branches/tags) for history ingestion
  --include <glob>         Glob pattern for files to include (repeatable)
  --exclude <glob>         Glob pattern for paths to exclude (repeatable)
  --language <lang>        Language name to filter by, e.g. typescript (repeatable)
  --docs-include <glob>    Glob pattern for docs to include (repeatable)
  --docs-exclude <glob>    Glob pattern for docs to exclude (repeatable)
  --docs-extension <ext>   Documentation extension to include, e.g. .md (repeatable)
  --docs-auto-notes        Enable doc-based note seeding during indexing (default)
  --no-docs-auto-notes     Disable doc-based note seeding during indexing
  --watch                  Enable fs-event watch mode (low-latency, may miss events on some platforms)
  --poll                   Enable polling mode (reliable but higher CPU/IO cost)
  --lsp                    Force-enable index-time LSP settings
  --no-lsp                 Force-disable index-time LSP settings
  --scip                   Force-enable index-time SCIP enrichment
  --no-scip                Force-disable index-time SCIP enrichment
  --file <path>            Coverage report path (required for ingest-coverage)
  --format <name>          Coverage format: lcov or cobertura (required for ingest-coverage)
  --commit <sha>           Commit SHA to associate with coverage ingestion (default: HEAD)
  --log-level <level>      Log level: debug, info, warn, error, silent (default: info)
  --log-file <path>        Path to the structured log file (default: lore.log next to the DB)
  --help, -h               Show this help message`,
  );
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/** Returns all values provided for a repeatable flag (e.g. --include a --include b → ['a', 'b']). */
function flags(args: string[], name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name) results.push(args[i + 1] as string);
  }
  return results;
}

function docsAutoNotesFlag(args: string[]): boolean {
  const enable = args.includes('--docs-auto-notes');
  const disable = args.includes('--no-docs-auto-notes');
  if (enable && disable) {
    console.error('Error: --docs-auto-notes and --no-docs-auto-notes cannot be used together.\n');
    usage();
  }
  if (enable) return true;
  if (disable) return false;
  return true;
}

function explicitLspEnabled(args: string[]): boolean | undefined {
  const enabled = args.includes('--lsp');
  const disabled = args.includes('--no-lsp');
  if (enabled && disabled) {
    throw new Error('cannot combine --lsp and --no-lsp');
  }
  if (enabled) return true;
  if (disabled) return false;
  return undefined;
}

function explicitScipEnabled(args: string[]): boolean | undefined {
  const enabled = args.includes('--scip');
  const disabled = args.includes('--no-scip');
  if (enabled && disabled) {
    throw new Error('cannot combine --scip and --no-scip');
  }
  if (enabled) return true;
  if (disabled) return false;
  return undefined;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    usage();
    return;
  }

  const subcommand = args[0];

  // ── Initialise logger (applies to all subcommands) ─────────────────────────
  const logLevelRaw = flag(args, '--log-level');
  const logFileRaw = flag(args, '--log-file');
  const dbPathForLog = flag(args, '--db');
  const resolvedLogLevel = logLevelRaw
    ? (LOG_LEVEL_NAMES[logLevelRaw.toLowerCase()] ?? LogLevel.INFO)
    : LogLevel.INFO;
  const resolvedLogFile = logFileRaw
    ?? (dbPathForLog
      ? dbPathForLog.replace(/\.[^.]+$/, '.log')
      : undefined);
  const log = initLogger({ level: resolvedLogLevel, logFile: resolvedLogFile });

  // Safety-net: kill tracked child processes (Python embedder, LSP servers)
  // when the process exits for any reason. Sub-commands that create a
  // LoreRuntime install their own signal handlers with graceful shutdown;
  // this covers one-shot flows (index, refresh) where no runtime exists.
  process.once('exit', () => killAllTracked());

  if (subcommand === 'index') {
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
    const docsIncludeGlobs = flags(args, '--docs-include');
    const docsExcludeGlobs = flags(args, '--docs-exclude');
    const docsExtensions = flags(args, '--docs-extension');
    const docsAutoNotes = docsAutoNotesFlag(args);

    // Static reverse map: language name → extensions (mirrors EXT_TO_LANG in walker.ts)
    const LANG_TO_EXTS: Record<string, string[]> = {
      c: ['.c', '.h'],
      rust: ['.rs'],
      python: ['.py'],
      cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
      typescript: ['.ts', '.tsx'],
      javascript: ['.js', '.jsx', '.mjs', '.cjs'],
      go: ['.go'],
      java: ['.java'],
      csharp: ['.cs'],
      ruby: ['.rb'],
      php: ['.php'],
      swift: ['.swift'],
      kotlin: ['.kt', '.kts'],
      scala: ['.scala', '.sc'],
      lua: ['.lua'],
      bash: ['.sh', '.bash', '.zsh'],
      elixir: ['.ex', '.exs'],
      zig: ['.zig'],
      ocaml: ['.ml', '.mli'],
      haskell: ['.hs'],
      julia: ['.jl'],
      elm: ['.elm'],
      objc: ['.m', '.mm'],
    };

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

    const { IndexBuilder } = await import('./indexer/index.js');

    const shouldEnableHistory = historyEnabled || historyAll || historyDepth !== undefined;
    const options = {
      docsAutoNotes,
      indexDependencies,
      lsp: lspSettings,
      scip: scipSettings,
      ...(embeddingModel && { embeddingModel }),
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
        ...(docsIncludeGlobs.length > 0 && { docsIncludeGlobs }),
        ...(docsExcludeGlobs.length > 0 && { docsExcludeGlobs }),
        ...(docsExtensions.length > 0 && { docsExtensions }),
      },
      undefined,
      options,
    );
    await builder.build();
  } else if (subcommand === 'mcp') {
    const dbPath = flag(args, '--db');
    if (!dbPath) {
      console.error('Error: --db <path> is required for the mcp subcommand.\n');
      usage();
      return;
    }

    log.startup('mcp server initializing', { dbPath });

    // Dynamically import so tree-shaking keeps the MCP server out of the
    // library entry point for consumers who only need the indexer.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/stdio.js'
    );

    const { openReadOnly } = await import('./lore-server/db.js');
    const { createLoreMcpServer } = await import('./lore-server/server.js');
    const { getLoreMeta } = await import('./indexer/db.js');

    const db = openReadOnly(dbPath);

    // Gather DB stats for startup log
    const totalFiles = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    const totalSymbols = (db.prepare('SELECT COUNT(*) AS cnt FROM symbols').get() as { cnt: number }).cnt;
    let totalEdges = 0;
    try {
      totalEdges = (db.prepare('SELECT COUNT(*) AS cnt FROM symbol_refs').get() as { cnt: number }).cnt;
    } catch { /* table may not exist */ }
    let totalDocs = 0;
    try {
      totalDocs = (db.prepare('SELECT COUNT(*) AS cnt FROM docs').get() as { cnt: number }).cnt;
    } catch { /* table may not exist */ }
    let commitCount: number | undefined;
    try {
      commitCount = (db.prepare('SELECT COUNT(*) AS cnt FROM commits').get() as { cnt: number }).cnt;
    } catch { /* commits table may not exist */ }
    const dbSizeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : undefined;

    // Build optional embedder from model recorded at index time.
    let embedder: import('./indexer/embedder.js').EmbeddingProvider | undefined;
    const modelName = getLoreMeta(db, 'embedding_model') as string | undefined;

    // ── Optional live-index watcher/poller (shares the same embedder) ────
    const watchMode = args.includes('--watch');
    const pollMode = args.includes('--poll');
    const rootDir = flag(args, '--root');

    const runtime = new LoreRuntime({
      dbPath,
      rootDir: rootDir ?? '.',
      walkerConfig: { rootDir: rootDir ?? '.' },
      lsp: null,
      scip: null,
      history: false,
      indexDependencies: false,
      docsAutoNotes: true,
      embeddingModel: modelName ?? undefined,
      refreshMode: (watchMode && rootDir) ? 'watch' : (pollMode && rootDir) ? 'poll' : 'none',
    }, log);

    await runtime.start();
    embedder = runtime.embedder;

    if ((watchMode || pollMode) && !rootDir) {
      log.warn('startup', '--root <dir> is required when using --watch or --poll with mcp; live indexing disabled');
    }

    log.startup('db stats', {
      dbPath,
      dbSizeBytes,
      embeddingModel: modelName ?? null,
      embeddingReady: !!embedder,
      totalFiles,
      totalSymbols,
      totalDocs,
      totalEdges,
      commitCount,
    });

    const server = createLoreMcpServer(db, dbPath, embedder, { logger: log });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    log.startup('mcp server ready', { transport: 'stdio' });

    // Signal readiness on stderr so parent processes can detect it.
    process.stderr.write('READY\n');

    runtime.installSignalHandlers();
  } else if (subcommand === 'refresh') {
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
    const docsIncludeGlobs = flags(args, '--docs-include');
    const docsExcludeGlobs = flags(args, '--docs-exclude');
    const docsExtensions = flags(args, '--docs-extension');
    const docsAutoNotes = docsAutoNotesFlag(args);

    const walkerConfig = {
      rootDir,
      ...(docsIncludeGlobs.length > 0 && { docsIncludeGlobs }),
      ...(docsExcludeGlobs.length > 0 && { docsExcludeGlobs }),
      ...(docsExtensions.length > 0 && { docsExtensions }),
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
      const runtime = new LoreRuntime({
        dbPath,
        rootDir,
        walkerConfig,
        lsp: lspSettings,
        scip: scipSettings,
        history: shouldEnableHistory ? historyOption : false,
        indexDependencies,
        docsAutoNotes,
        embeddingModel: embeddingModel ?? undefined,
        refreshMode: watchMode ? 'watch' : 'poll',
      }, log);

      await runtime.start();
      runtime.installSignalHandlers();
    } else {
      // Manual refresh: full build if DB doesn't exist yet, otherwise incremental update
      const { IndexBuilder } = await import('./indexer/index.js');
      const builder = new IndexBuilder(dbPath, walkerConfig, undefined, {
        ...refreshOptions,
        docsAutoNotes,
      });

      const dbExists = fs.existsSync(dbPath);
      if (dbExists) {
        const [{ openDb }, { walkFiles }] = await Promise.all([
          import('./indexer/db.js'),
          import('./indexer/walker.js'),
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
  } else if (subcommand === 'hooks') {
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

    const { installGitHooks } = await import('./indexer/git-hooks.js');
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
  } else if (subcommand === 'ingest-coverage') {
    const dbPath = flag(args, '--db');
    const rootDir = flag(args, '--root');
    const reportPath = flag(args, '--file');
    const format = flag(args, '--format');
    const commitSha = flag(args, '--commit');

    if (!dbPath || !rootDir || !reportPath || !format) {
      console.error('Error: --db <path>, --root <dir>, --file <path>, and --format <lcov|cobertura> are required for the ingest-coverage subcommand.\n');
      usage();
      return;
    }

    if (format !== 'lcov' && format !== 'cobertura') {
      console.error(`Error: unsupported coverage format "${format}". Use "lcov" or "cobertura".\n`);
      usage();
      return;
    }

    const { IndexBuilder } = await import('./indexer/index.js');
    const builder = new IndexBuilder(dbPath, { rootDir });
    await builder.ingestCoverage(reportPath, format, commitSha);
  } else if (subcommand === 'analyze') {
    const dbPath = flag(args, '--db');
    if (!dbPath) {
      console.error('Error: --db <path> is required for the analyze subcommand.\n');
      usage();
      return;
    }

    const mode = flag(args, '--mode') ?? 'summary';
    const validModes = ['cycles', 'components', 'clusters', 'summary'];
    if (!validModes.includes(mode)) {
      console.error(`Error: --mode must be one of: ${validModes.join(', ')}\n`);
      usage();
      return;
    }

    const edgeKindsRaw = flag(args, '--edge-kinds') ?? 'both';
    const validEdgeKinds = ['call', 'type', 'both'];
    if (!validEdgeKinds.includes(edgeKindsRaw)) {
      console.error(`Error: --edge-kinds must be one of: ${validEdgeKinds.join(', ')}\n`);
      usage();
      return;
    }
    const edgeKinds = edgeKindsRaw as 'call' | 'type' | 'both';

    const branch = flag(args, '--branch');
    const maxLinesRaw = flag(args, '--max-lines');
    let maxLines: number | undefined;
    if (maxLinesRaw !== undefined) {
      const parsed = Number(maxLinesRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.error('Error: --max-lines must be a positive number.\n');
        usage();
        return;
      }
      maxLines = Math.floor(parsed);
    }

    const { openReadOnly } = await import('./lore-server/db.js');
    const {
      detectSymbolCycles,
      findConnectedComponents,
      clusterSymbols,
      buildCodebaseSummary,
    } = await import('./indexer/graph-analysis.js');

    const db = openReadOnly(dbPath);
    const opts = { edgeKinds, branch };

    let result: unknown;
    if (mode === 'cycles') {
      result = detectSymbolCycles(db, opts);
    } else if (mode === 'components') {
      result = findConnectedComponents(db, { ...opts, scope: 'symbol' });
    } else if (mode === 'clusters') {
      result = clusterSymbols(db, { ...opts, maxLinesPerCluster: maxLines });
    } else {
      result = buildCodebaseSummary(db, { ...opts, maxLinesPerModule: maxLines });
    }

    db.close();
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    usage();
    return;
  }
}

main().catch((err) => {
  console.error('lore: fatal error:', err);
  process.exit(1);
});
