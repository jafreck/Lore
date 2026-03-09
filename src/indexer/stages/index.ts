/**
 * @module indexer/stages
 *
 * Barrel export for all concrete pipeline stages.
 */

export { SourceIndexStage } from './source-index.js';
export { DocsIndexStage } from './docs-index.js';
export { ImportResolutionStage } from './import-resolution.js';
export { DependencyApiStage } from './dependency-api.js';
export { LspEnrichmentStage } from './lsp-enrichment.js';
export { ResolutionStage } from './resolution.js';
export { TestMapStage } from './test-map.js';
export { HistoryStage } from './history.js';
export { EmbeddingStage } from './embedding.js';
