/**
 * @module indexer/stages/resolution
 *
 * Pipeline stage: resolve symbol edges using the 3-tier resolution strategy.
 *
 * ## Resolution tiers (in order)
 *
 * 1. **LSP containment mapping** (`lsp_definition`) — map `definition_path` +
 *    `definition_line` to the narrowest enclosing indexed symbol.
 * 2. **Same-file name match** (`name_same_file`) — if the ref name matches
 *    exactly one symbol in the same file, resolve it.
 * 3. **Globally unique name** (`name_unique`) — if the ref name matches
 *    exactly one symbol across the entire index, resolve it.
 *
 * ## Data dependency
 *
 * **Must run after `LspEnrichmentStage`.**  This stage reads `definition_path` /
 * `definition_line` columns that are only populated during LSP enrichment.
 * Running this stage before enrichment yields only name-based fallback results.
 */

import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { resolveSymbolEdges } from '../call-graph.js';

/**
 * Wraps `resolveSymbolEdges()` as a pipeline stage.
 *
 * The underlying function resolves edges in `symbol_refs`, `type_refs`, and
 * `symbol_relationships` using LSP containment mapping, then falls back to
 * name-based matching.
 */
export class ResolutionStage implements PipelineStage {
  readonly name = 'symbol-resolution';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    resolveSymbolEdges(context.db);
  }
}
