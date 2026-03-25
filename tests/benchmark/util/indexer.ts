/**
 * @module benchmark/indexer
 *
 * Builds a Lore index for a benchmark repo using the IndexBuilder API.
 *
 * Indexing mode controls parsing stages:
 *
 * - `tree-sitter`: Tree-sitter parsing only (fastest, no external tools).
 * - `scip`:        SCIP (primary) + tree-sitter (fallback). Standard
 *                  production indexing with accurate cross-references.
 * - `full`:        SCIP + tree-sitter + LSP enrichment.
 *                  Maximum structural quality: resolved types.
 *
 * Embeddings are controlled independently via `embeddingModel`:
 * pass a model name (e.g. 'onnx-community/Qwen3-Embedding-0.6B-ONNX') to enable,
 * or omit to disable. LSP can also be enabled independently via `lsp`.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { IndexBuilder } from '../../../src/indexer/index.js';
import { openDb } from '../../../src/db/schema.js';
import { LazyEmbeddingProvider } from '../../../src/embeddings/embedder.js';
import { resolveEffectiveScipSettings } from '../../../src/scip/config.js';
import { resolveEffectiveLspSettings } from '../../../src/lsp/config.js';
import type { WalkerConfig } from '../../../src/discovery/walker.js';
import type { EmbeddingProvider } from '../../../src/embeddings/embedder.js';
import type { RepoCoverageConfig, RepoInstance, IndexOptions, IndexMode } from './types.js';

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;

/**
 * Run the Lore indexer on a repo checkout, producing a .lore.db file.
 *
 * @param instance  The repo to index.
 * @param options   Indexing configuration (mode, history depth, etc.).
 * @returns Updated RepoInstance with dbPath, timing, and mode info.
 */
export async function indexRepo(
  instance: RepoInstance,
  options?: IndexOptions,
): Promise<RepoInstance> {
  const mode: IndexMode = options?.mode ?? 'tree-sitter';
  const historyDepth = options?.historyDepth ?? 100;
  const embeddingModel = options?.embeddingModel;
  const enableLsp = options?.lsp ?? (mode === 'full');

  const dbPath = join(instance.localPath, '.lore.db');
  const walkerConfig: WalkerConfig = {
    rootDir: instance.localPath,
  };

  // ── SCIP settings (for 'scip' and 'full' modes) ──────────────────────
  const scip = mode === 'scip' || mode === 'full'
    ? resolveEffectiveScipSettings(
        {},
        {
          enabled: true,
          ...(options?.scipIndexDir ? { indexDir: options.scipIndexDir } : {}),
        },
      )
    : undefined;

  // ── Embedding provider (when a model is specified) ────────────────────
  let embedder: EmbeddingProvider | undefined;
  if (embeddingModel) {
    embedder = new LazyEmbeddingProvider(embeddingModel);
  }

  // ── LSP settings (when enabled) ───────────────────────────────────────
  const lsp = enableLsp
    ? resolveEffectiveLspSettings({}, { enabled: true })
    : undefined;

  const start = performance.now();

  try {
    const builder = new IndexBuilder(dbPath, walkerConfig, embedder, {
      history: { depth: historyDepth },
      indexDependencies: false,
      scip: scip ?? undefined,
      lsp: lsp ?? undefined,
    });

    await builder.build();
  } finally {
    // Dispose the embedder to release ONNX resources
    if (embedder) {
      await embedder.dispose().catch(() => {});
    }
  }

  const elapsed = Math.round(performance.now() - start);

  return {
    ...instance,
    dbPath,
    indexed: true,
    indexTimeMs: elapsed,
    indexMode: mode,
  };
}

async function ingestBenchmarkCoverage(
  instance: RepoInstance,
  dbPath: string,
  config: RepoCoverageConfig,
): Promise<void> {
  for (const command of config.commands ?? []) {
    await execFileAsync(command.command, command.args ?? [], {
      cwd: instance.localPath,
      env: { ...process.env, ...(command.env ?? {}) },
      timeout: command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
  }

  const reportPath = join(instance.localPath, config.reportPath);
  if (!existsSync(reportPath)) {
    throw new Error(`Coverage report not found after benchmark prep: ${reportPath}`);
  }

  const db = openDb(dbPath);
  try {
      db,
      rootDir: instance.localPath,
      reportPath,
      format: config.format,
      commitSha: instance.spec.sha,
      sourceMtime: Math.floor(statSync(reportPath).mtimeMs / 1000),
    });

    if (config.perTestReportsDir) {
      const reportsDir = join(instance.localPath, config.perTestReportsDir);
      if (!existsSync(reportsDir)) {
        throw new Error(`Per-test coverage reports directory not found after benchmark prep: ${reportsDir}`);
      }

        db,
        reportsDir,
        rootDir: instance.localPath,
        commitSha: instance.spec.sha,
        format: config.perTestFormat ?? config.format,
        separator: config.perTestSeparator,
      });
    }
  } finally {
    db.close();
  }
}
