# Pipeline Simplification: Post Tree-Sitter Cleanup

## Status

Proposed — follow-up to the SCIP+LSP migration (`feat/scip-lsp-migration`).

## Problem

The migration removed tree-sitter but preserved the pipeline stage ordering that existed to accommodate it. Several stages are now vestigial or redundant:

| Stage | Issue |
|---|---|
| `ScipRefStage` | Exists only because tree-sitter needed to patch `end_line` before ref insertion. Without tree-sitter, refs can be inserted inline in `ScipIndexerStage`. |
| `SourceIndexStage` | Was the tree-sitter extraction stage (~1,100 LOC). Now just walks files and populates `sourceCache`. Naming is misleading. |
| `DependencyApiStage` | No-op stub. Clears `external_symbols` and logs a message. |
| `LspEnrichmentStage` | Runs hover+definition on SCIP-produced symbols. Overlaps with `LspExtractionStage` which does documentSymbol+callHierarchy on overlay. |
| `resolutionStage` | Resolves `unresolved` refs. With SCIP producing `scip_definition` and LSP producing `lsp_call_hierarchy`, only non-SCIP/non-LSP languages have unresolved refs — and without tree-sitter, those languages produce no symbols. |

The stash/defer pattern (`context.scipRefData`) adds indirection for a constraint that no longer exists.

## Proposed Pipeline

### Baseline build

```
ScipStage                 ← merge ScipIndexerStage + ScipRefStage: symbols, refs,
                            imports, relationships, virtual dispatch — all in one pass
FileDiscoveryStage        ← rename SourceIndexStage: walk files, populate sourceCache,
                            insert file rows for non-SCIP files
LspEnrichmentStage        ← hover + definition enrichment (unchanged for baseline)
ImportResolutionStage     ← resolve file_imports.resolved_id
HistoryStage              ← git history ingestion
ftsRefreshStage           ← rebuild symbols_fts
ReverseDepsStage          ← build reverse dependency index
EmbeddingStage            ← vector embeddings
```

### Overlay update

```
FileDiscoveryStage        ← walk changed files, populate sourceCache, insert file rows
LspExtractionStage        ← documentSymbol + callHierarchy + hover + definition
                            (merge current LspEnrichment into this for overlay mode)
ImportResolutionStage     ← resolve new imports
ftsRefreshStage           ← rebuild symbols_fts
ReverseDepsStage          ← update reverse deps
EmbeddingStage            ← update embeddings for changed symbols
```

### Baseline rebuild (quiet-period flush)

Same as baseline build + `OverlayCleanupStage` at the end.

## Changes

### 1. Merge ScipRefStage into ScipIndexerStage

The sole reason ScipRefStage was split out was to defer ref insertion until after `SourceIndexStage` patched symbol `end_line` values with tree-sitter spans. Tree-sitter is gone. The `end_line` values now come from SCIP `enclosingRange` (already populated in ScipIndexerStage).

**Action:** Move the containment index build and ref insertion loop from `ScipRefStage.execute()` into `ScipIndexerStage.execute()`, after symbol insertion. Delete `ScipRefStage`. Remove `context.scipRefData` stash.

### 2. Rename SourceIndexStage → FileDiscoveryStage

The current `SourceIndexStage` is 197 lines that walk files and insert `files` rows. It no longer extracts symbols. The name "source-index" implies extraction. Rename to `FileDiscoveryStage` to reflect its actual responsibility.

### 3. Delete DependencyApiStage

It's a no-op. External symbol resolution is handled natively by SCIP's symbol definition map. Remove the stage from the pipeline and delete the file.

### 4. Merge LspEnrichmentStage into LspExtractionStage (overlay only)

Currently:
- `LspExtractionStage` (overlay): documentSymbol + callHierarchy → symbols + call graph
- `LspEnrichmentStage` (both): hover + definition → type signatures + definition locations

For overlay mode, these are two passes over the same files with the same LSP client. Merge hover+definition into `LspExtractionStage` so each file is opened/closed once.

For baseline mode, keep `LspEnrichmentStage` as-is (SCIP handles enrichment inline for most symbols; LSP fills gaps).

### 5. Remove resolutionStage (conditional)

With SCIP and LSP both producing pre-resolved refs, the resolution stage only runs on `unresolved` refs from languages without SCIP or LSP coverage. If no such languages exist in the project, it's a no-op. Keep it but make it skip early when there are zero unresolved refs.

## Stages Removed

| Stage | Lines | Reason |
|---|---|---|
| `ScipRefStage` | ~150 | Merged into ScipIndexerStage |
| `DependencyApiStage` | 32 | No-op stub |
| `context.scipRefData` stash | ~30 | Indirection for removed constraint |

## Stages Renamed

| Old | New |
|---|---|
| `SourceIndexStage` | `FileDiscoveryStage` |

## Stage Count

| Pipeline | Before | After |
|---|---|---|
| Baseline | 11 stages | 8 stages |
| Overlay | 11 stages | 6 stages |

## Migration

Each change is independently shippable. Suggested order:

1. Merge ScipRefStage into ScipIndexerStage (largest impact, simplest — just move code)
2. Delete DependencyApiStage (trivial)
3. Rename SourceIndexStage → FileDiscoveryStage (trivial, lots of import updates)
4. Merge LspEnrichment into LspExtraction for overlay mode
5. Add early-exit to resolutionStage
