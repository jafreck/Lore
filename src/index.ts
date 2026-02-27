export { IndexBuilder } from './indexer/index.js';
export { openDb, setKbMeta, getKbMeta, createVec0Tables } from './indexer/db.js';
export type { Database } from './indexer/db.js';
export { buildCallGraph, topoSort, detectCycles } from './indexer/call-graph.js';
export { walkFiles } from './indexer/walker.js';
export type { WalkerConfig, FileEntry } from './indexer/walker.js';
export { ImportResolver } from './indexer/resolver.js';
export { ParserPool } from './indexer/parser.js';
export { ensurePythonDeps } from './indexer/ensure-python-deps.js';
export { SentenceTransformersProvider, Qwen3EmbeddingProvider, DEFAULT_EMBEDDING_MODEL } from './indexer/embedder.js';
export type { EmbeddingProvider } from './indexer/embedder.js';
export type {
  ExtractionResult,
  RawCallRef,
  RawImport,
  RawSymbol,
  SymbolExtractor,
} from './indexer/extractors/types.js';

// ── File watcher / poller ─────────────────────────────────────────────────────
export { FileWatcher } from './indexer/watcher.js';
export type { WatcherOptions } from './indexer/watcher.js';
export { FilePoller } from './indexer/poller.js';
export type { PollerOptions } from './indexer/poller.js';

// ── MCP server ────────────────────────────────────────────────────────────────
export { createKbMcpServer } from './kb-server/server.js';
export {
  openReadOnly,
  getSymbolById,
  getSymbolsByName,
  listSymbols,
  getFileById,
  getFileByPath,
  listFiles,
} from './kb-server/db.js';
export type { SymbolRow, FileRow } from './kb-server/db.js';
