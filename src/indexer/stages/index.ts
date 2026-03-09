/**
 * @module indexer/stages
 *
 * Concrete pipeline stages with real implementations.
 */

export { SourceIndexStage, processFile, loadBuildCheckpoint, saveBuildCheckpoint } from './source-index.js';
export { DocsIndexStage, processDocumentationFile, upsertSeededDocumentationNote } from './docs-index.js';
export { ImportResolutionStage } from './import-resolution.js';
export { DependencyApiStage } from './dependency-api.js';
export { LspEnrichmentStage, enrichProjectRefs } from './lsp-enrichment.js';
export { ResolutionStage } from './resolution.js';
export { TestMapStage } from './test-map.js';
export { HistoryStage } from './history.js';
export { EmbeddingStage } from './embedding.js';
