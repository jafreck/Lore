/**
 * @module indexer/stages
 *
 * Concrete pipeline stages with real implementations.
 */

export { ScipIndexerStage } from './scip-indexer.js';
export { FileDiscoveryStage } from './source-index.js';
export { LspExtractionStage } from './lsp-extraction.js';
export { ImportResolutionStage } from './import-resolution.js';
export { LspEnrichmentStage } from './lsp-enrichment.js';
export { EmbeddingStage } from './embedding.js';
export { ReverseDepsStage } from './reverse-deps.js';
export { OverlayCleanupStage } from './overlay-cleanup.js';
export type { OverlayCleanupOptions } from './overlay-cleanup.js';
