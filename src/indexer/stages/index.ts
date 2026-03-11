/**
 * @module indexer/stages
 *
 * Concrete pipeline stages with real implementations.
 */

export { ScipSourceStage } from './scip-source.js';
export { SourceIndexStage } from './source-index.js';
export { DocsIndexStage } from './docs-index.js';
export { ImportResolutionStage } from './import-resolution.js';
export { DependencyApiStage } from './dependency-api.js';
export { ScipEnrichmentStage } from './scip-enrichment.js';
export { LspEnrichmentStage } from './lsp-enrichment.js';
export { EmbeddingStage } from './embedding.js';
