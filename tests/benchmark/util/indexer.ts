/**
 * @module benchmark/indexer
 *
 * Builds a Lore index for a benchmark repo using the IndexBuilder API.
 *
 * Indexing mode controls SCIP/LSP settings:
 *
 * - `snapshots`: No SCIP and no default LSP; stores discovered file snapshots.
 * - `scip`:      Enables SCIP baseline indexing; no default LSP.
 * - `full`:      Enables SCIP baseline indexing and LSP enrichment.
 *
 * Embeddings are controlled independently via `embeddingModel`:
 * pass a model name (e.g. 'onnx-community/Qwen3-Embedding-0.6B-ONNX') to enable,
 * or omit to disable. LSP can also be enabled independently via `lsp`.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { IndexBuilder } from '../../../src/indexer/index.js';
import { openDb } from '../../../src/db/schema.js';
import { LazyEmbeddingProvider } from '../../../src/embeddings/embedder.js';
import { resolveEffectiveScipSettings } from '../../../src/scip/config.js';
import { resolveEffectiveLspSettings } from '../../../src/lsp/config.js';
import type { WalkerConfig } from '../../../src/discovery/walker.js';
import type { EmbeddingProvider } from '../../../src/embeddings/embedder.js';
import type { RepoInstance, IndexOptions, IndexMode } from './types.js';

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
  const mode: IndexMode = options?.mode ?? 'snapshots';
  const historyDepth = options?.historyDepth ?? 100;
  const embeddingModel = options?.embeddingModel;
  const enableLsp = options?.lsp ?? (mode === 'full');

  const dbPath = join(instance.localPath, '.lore.db');
  const walkerConfig: WalkerConfig = {
    rootDir: instance.localPath,
  };

  // ── SCIP settings (for 'scip' and 'full' modes) ──────────────────────
  const scip = resolveEffectiveScipSettings(
    {},
    {
      enabled: mode === 'scip' || mode === 'full',
      ...(options?.scipIndexDir ? { indexDir: options.scipIndexDir } : {}),
    },
  );

  // ── Embedding provider (when a model is specified) ────────────────────
  let embedder: EmbeddingProvider | undefined;
  if (embeddingModel) {
    embedder = new LazyEmbeddingProvider(embeddingModel);
  }

  // ── LSP settings (when enabled) ───────────────────────────────────────
  const lsp = resolveEffectiveLspSettings({}, { enabled: enableLsp });

  const start = performance.now();

  try {
    const builder = new IndexBuilder(dbPath, walkerConfig, embedder, {
      history: { depth: historyDepth },
      indexDependencies: false,
      scip,
      lsp,
      execution: {
        allowSubprocessExecution: true,
        allowAutoInstall: true,
        ...(options?.scipIndexDir && {
          allowedCwdRoots: [resolve(instance.localPath, options.scipIndexDir)],
        }),
      },
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
