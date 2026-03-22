/**
 * @module indexer/resolution-method
 *
 * Authoritative taxonomy for the `resolution_method` column stored on
 * `symbol_refs`, `type_refs`, and `symbol_relationships`.
 *
 * Consumers should import from here rather than using string literals so that
 * writers (call-graph.ts) and readers (graph.ts) stay in sync.
 */

/**
 * Resolution confidence tiers, ordered from highest to lowest confidence.
 *
 * - `scip_definition` — the SCIP index provided a precise definition that was
 *   directly resolved during SCIP-primary source indexing.
 * - `lsp_definition` — the LSP server returned a precise definition location
 *   that was mapped to the narrowest enclosing indexed symbol.
 * - `name_same_file` — no LSP data was available; the callee/type name matched
 *   exactly one symbol *in the same file* as the reference.
 * - `name_single_file` — no LSP data was available; the callee/type name matched
 *   multiple symbols (e.g. overloads) but all reside in *the same target file*.
 *   The first match is used (overloads are co-located, so the file is correct).
 * - `name_unique` — no LSP data was available; the callee/type name matched
 *   exactly one symbol *in the entire index*.
 * - `external_definition` — the LSP server returned a definition location whose
 *   path is not in the indexed file set (e.g. node_modules, stdlib).
 * - `ambiguous_definition` — the LSP server returned a definition location that
 *   maps to multiple equally-narrow candidate symbols. Manual disambiguation is
 *   needed.
 * - `unresolved` — no resolution strategy succeeded. The reference remains a
 *   dangling name.
 */
export const RESOLUTION_METHODS = [
  'scip_definition',
  'lsp_definition',
  'name_same_file',
  'name_single_file',
  'name_unique',
  'external_definition',
  'ambiguous_definition',
  'overlay_stale',
  'unresolved',
] as const;

/** Union type of all valid `resolution_method` column values. */
export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];

/**
 * Set of resolution methods that indicate a successfully resolved target.
 * Useful for filtering edges to only include high-confidence results.
 */
export const RESOLVED_METHODS: ReadonlySet<ResolutionMethod> = new Set([
  'scip_definition',
  'lsp_definition',
  'name_same_file',
  'name_single_file',
  'name_unique',
]);

/**
 * Set of resolution methods where the target_id is expected to be NULL.
 * These represent references that could not be mapped to an indexed symbol.
 */
export const UNRESOLVED_METHODS: ReadonlySet<ResolutionMethod> = new Set([
  'external_definition',
  'ambiguous_definition',
  'overlay_stale',
  'unresolved',
]);
