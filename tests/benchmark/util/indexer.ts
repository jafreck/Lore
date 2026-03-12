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

import { join } from 'node:path';
import { IndexBuilder } from '../../../src/indexer/index.js';
import { LazyEmbeddingProvider } from '../../../src/embeddings/embedder.js';
import { resolveEffectiveScipSettings } from '../../../src/scip/config.js';
import { resolveEffectiveLspSettings } from '../../../src/lsp/config.js';
import type { WalkerConfig } from '../../../src/discovery/walker.js';
import type { EmbeddingProvider } from '../../../src/embeddings/embedder.js';
import type { RepoInstance, IndexOptions, IndexMode } from './types.js';

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
      docsAutoNotes: true,
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
