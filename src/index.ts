export { IndexBuilder } from './indexer/index.js';
export { openDb, setLoreMeta, getLoreMeta, createVec0Tables } from './indexer/db.js';
export type { Database } from './indexer/db.js';
export { buildCallGraph, topoSort, detectCycles } from './indexer/call-graph.js';
export { walkFiles, detectLanguageForPath } from './indexer/walker.js';
export type { WalkerConfig, FileEntry } from './indexer/walker.js';
export { ImportResolver } from './indexer/resolver.js';
export { ParserPool } from './indexer/parser.js';
export { ensurePythonDeps } from './indexer/ensure-python-deps.js';
export { installGitHooks } from './indexer/git-hooks.js';
export type { InstallGitHooksOptions } from './indexer/git-hooks.js';
export type { EffectiveLspSettings, LspSettingsOverrides } from './indexer/lsp/config.js';
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
export { createLoreMcpServer } from './lore-server/server.js';
export type { LoreServerOptions } from './lore-server/server.js';
export type { SearchObservation, SearchObserver } from './lore-server/tools/search.js';
export {
  openReadOnly,
  getSymbolById,
  getSymbolsByName,
  listSymbols,
  getFileById,
  getFileByPath,
  listFiles,
} from './lore-server/db.js';
export type { SymbolRow, FileRow } from './lore-server/db.js';

// ── Logging ───────────────────────────────────────────────────────────────────
export { LoreLogger, LogLevel, LOG_LEVEL_NAMES, initLogger, getLogger, resetLogger } from './logger.js';
export type { LoreLoggerOptions, LogEntry, ToolCallFields, StartupFields } from './logger.js';
