#!/usr/bin/env node
/**
 * @module cli
 *
 * Lore CLI — unified entry point for indexing and the MCP server.
 *
 * Usage:
 *   lore index --root <dir> --db <path> [--embedding-model <id>]
 *                              Index a codebase into a knowledge-base file.
 *   lore mcp --root <dir>                        Start the MCP server, indexing automatically if needed.
 *   lore mcp --db <path>                          Start the MCP server with a pre-indexed DB.
 *   lore refresh --db <path> --root <dir>       Run an incremental index update and exit.
 *   lore refresh --db <path> --root <dir> --watch  Watch for changes and refresh automatically.
 *   lore refresh --db <path> --root <dir> --poll   Poll for changes and refresh automatically.
 *   lore hooks --root <dir> --db <path>         Install git hooks for automatic Lore refresh.
 */

import { initLogger, LogLevel, LOG_LEVEL_NAMES } from './logger.js';
import { killAllTracked } from './process-tracker.js';
import { flag, usage } from './cli/args.js';
import { runIndexCommand } from './cli/commands/index-cmd.js';
import { runServeCommand } from './cli/commands/serve-cmd.js';
import { runRefreshCommand } from './cli/commands/refresh-cmd.js';
import { runHooksCommand } from './cli/commands/hooks-cmd.js';
import { runAnalyzeCommand } from './cli/commands/analyze-cmd.js';
import { runInstallScipCommand } from './cli/commands/install-scip-cmd.js';

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
    await runIndexCommand(args, log);
  } else if (subcommand === 'mcp') {
    await runServeCommand(args, log);
  } else if (subcommand === 'refresh') {
    await runRefreshCommand(args, log);
  } else if (subcommand === 'hooks') {
    await runHooksCommand(args, log);
  } else if (subcommand === 'analyze') {
    await runAnalyzeCommand(args, log);
  } else if (subcommand === 'install-scip') {
    await runInstallScipCommand(args, log);
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
