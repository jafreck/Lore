/**
 * @module index
 *
 * Public API surface for the Lore knowledge-base toolkit.
 *
 * Exports are intentional and small. Internal helpers like `ParserPool`,
 * `normalizeTypeName`, etc., are not exposed. `buildCallGraph` has been
 * removed — use `resolveSymbolEdges` instead.
 *
 * Layering: runtime → domain services → storage → shared types
 */

// ── Indexing API ──────────────────────────────────────────────────────────────
export { IndexBuilder } from './indexer/index.js';
export { openDb, setLoreMeta, getLoreMeta, createVec0Tables } from './indexer/db.js';
export type { Database } from './indexer/db.js';
export { resolveSymbolEdges, topoSort, detectCycles } from './indexer/call-graph.js';
export { walkFiles, detectLanguageForPath } from './indexer/walker.js';
export type { WalkerConfig, FileEntry } from './indexer/walker.js';
export { ImportResolver } from './indexer/resolver.js';

export { installGitHooks } from './indexer/git-hooks.js';
export type { InstallGitHooksOptions } from './indexer/git-hooks.js';
export type { EffectiveLspSettings, LspSettingsOverrides } from './indexer/lsp/config.js';
export { TransformersJsProvider, DEFAULT_EMBEDDING_MODEL } from './indexer/embedder.js';
export type { EmbeddingProvider } from './indexer/embedder.js';
export type {
  ExtractionResult,
  RawCallRef,
  RawImport,
  RawSymbol,
  SymbolExtractor,
} from './indexer/extractors/types.js';

// ── Resolution method taxonomy (shared constant) ─────────────────────────────
export { RESOLUTION_METHODS, RESOLVED_METHODS, UNRESOLVED_METHODS } from './indexer/resolution-method.js';
export type { ResolutionMethod } from './indexer/resolution-method.js';

// ── Pipeline (composable indexing stages) ─────────────────────────────────────
export { IndexPipeline } from './indexer/pipeline.js';
export type { PipelineContext, PipelineStage } from './indexer/pipeline.js';
export {
  SourceIndexStage,
  DocsIndexStage,
  ImportResolutionStage,
  DependencyApiStage,
  LspEnrichmentStage,
  EmbeddingStage,
} from './indexer/stages/index.js';


// ── Runtime ───────────────────────────────────────────────────────────────────
export { LoreRuntime } from './runtime.js';
export type { RuntimeConfig, Refresher } from './runtime.js';

// ── File watcher / poller ─────────────────────────────────────────────────────
export { FileWatcher } from './indexer/watcher.js';
export type { WatcherOptions } from './indexer/watcher.js';
export { FilePoller } from './indexer/poller.js';
export type { PollerOptions } from './indexer/poller.js';

// ── MCP server ────────────────────────────────────────────────────────────────
export { createLoreMcpServer, createLoreMcpServerAsync } from './lore-server/server.js';
export type { LoreServerOptions } from './lore-server/server.js';
export type { SearchObservation, SearchObserver } from './lore-server/tools/search.js';
export { registerTools } from './lore-server/tool-registry.js';
export type { ToolModule, ToolDefinition } from './lore-server/tool-registry.js';
export {
  openReadOnly,
  getSymbolById,
  getSymbolsByName,
  listSymbols,
  getFileById,
  getFileByPath,
  listFiles,
  listResolvedEdges,
} from './lore-server/db.js';
export type { SymbolRow, FileRow, ResolvedEdge, ListResolvedEdgesOptions } from './lore-server/db.js';

// ── Logging ───────────────────────────────────────────────────────────────────
export { LoreLogger, LogLevel, LOG_LEVEL_NAMES, initLogger, getLogger, resetLogger } from './logger.js';
export type { LoreLoggerOptions, LogEntry, ToolCallFields, StartupFields } from './logger.js';

// ── Process lifecycle ─────────────────────────────────────────────────────────
export { trackProcess, untrackProcess, killAllTracked, trackedCount } from './process-tracker.js';
