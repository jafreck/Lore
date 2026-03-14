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
export { openDb, setLoreMeta, getLoreMeta, createVec0Tables } from './db/schema.js';
export type { Database } from './db/schema.js';
export { resolveSymbolEdges, topoSort, detectCycles } from './resolution/call-graph.js';
export {
  detectSymbolCycles,
  findConnectedComponents,
  clusterSymbols,
  buildCodebaseSummary,
} from './resolution/graph-analysis.js';
export type {
  EdgeKind,
  GraphAnalysisOptions,
  ConnectedComponentsOptions,
  ClusterOptions,
  SymbolCluster,
  CodebaseSummaryOptions,
  CodebaseSummary,
  ModuleSummary,
} from './resolution/graph-analysis.js';
export { walkFiles, detectLanguageForPath } from './discovery/walker.js';
export type { WalkerConfig, FileEntry } from './discovery/walker.js';
export { ImportResolver } from './resolution/resolver.js';

export { installGitHooks } from './git/hooks.js';
export type { InstallGitHooksOptions } from './git/hooks.js';
export type { EffectiveLspSettings, LspSettingsOverrides } from './lsp/config.js';
export type { EffectiveScipSettings, ScipSettingsOverrides } from './scip/config.js';
export { TransformersJsProvider, LazyEmbeddingProvider, DEFAULT_EMBEDDING_MODEL, tokenAwareBatch, hashEmbeddingText, buildStructuralEmbeddingText } from './embeddings/embedder.js';
export type { EmbeddingProvider, OnnxDtype } from './embeddings/embedder.js';
export type {
  ExtractionResult,
  RawCallRef,
  RawImport,
  RawSymbol,
  SymbolExtractor,
} from './parsing/extractors/types.js';

// ── Resolution method taxonomy (shared constant) ─────────────────────────────
export { RESOLUTION_METHODS, RESOLVED_METHODS, UNRESOLVED_METHODS } from './resolution/resolution-method.js';
export type { ResolutionMethod } from './resolution/resolution-method.js';

// ── Pipeline (composable indexing stages) ─────────────────────────────────────
export { IndexPipeline } from './indexer/pipeline.js';
export type { PipelineContext, PipelineStage } from './indexer/pipeline.js';
export {
  ScipIndexerStage,
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
export { FileWatcher } from './discovery/watcher.js';
export type { WatcherOptions } from './discovery/watcher.js';
export { FilePoller } from './discovery/poller.js';
export type { PollerOptions } from './discovery/poller.js';

// ── MCP server ────────────────────────────────────────────────────────────────
export { createLoreMcpServer, createLoreMcpServerAsync } from './server/server.js';
export type { LoreServerOptions } from './server/server.js';
export type { SearchObservation, SearchObserver } from './server/tools/search.js';
export { registerTools } from './server/tool-registry.js';
export type { ToolModule, ToolDefinition } from './server/tool-registry.js';
export {
  openReadOnly,
  getSymbolById,
  getSymbolsByName,
  listSymbols,
  getFileById,
  getFileByPath,
  listFiles,
  listResolvedEdges,
  listTypeRefs,
  listSymbolRelationships,
} from './db/read-only.js';
export type {
  SymbolRow,
  FileRow,
  ResolvedEdge,
  ListResolvedEdgesOptions,
  TypeRefEdge,
  ListTypeRefsOptions,
  SymbolRelationshipEdge,
  ListSymbolRelationshipsOptions,
} from './db/read-only.js';

// ── Logging ───────────────────────────────────────────────────────────────────
export { LoreLogger, LogLevel, LOG_LEVEL_NAMES, initLogger, getLogger, resetLogger } from './logger.js';
export type { LoreLoggerOptions, LogEntry, ToolCallFields, StartupFields } from './logger.js';

// ── Process lifecycle ─────────────────────────────────────────────────────────
export { trackProcess, untrackProcess, killAllTracked, trackedCount } from './process-tracker.js';
