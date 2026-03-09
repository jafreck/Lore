# Target Dependency Diagram

Authoritative layering and module boundaries for the Lore refactoring effort.

## Module map

```
                         ┌─────────────────────────────────────────────────┐
                         │                  CLI / Runtime                   │
                         │  cli.ts — argument parsing + dispatch only       │
                         │  runtime.ts — LoreRuntime owns all lifecycles    │
                         └──────────────────────┬──────────────────────────┘
                                                │
          ┌─────────────────────────────────────┼──────────────────────────────────┐
          │                                     │                                  │
          ▼                                     ▼                                  ▼
┌───────────────────┐              ┌──────────────────────┐              ┌─────────────────┐
│   MCP Server      │              │   Indexing Pipeline   │              │   Storage        │
│   lore-server/    │              │   indexer/pipeline.ts  │              │   storage/       │
│   tool-registry   │              │   indexer/stages/*     │              │   indexer/db.ts  │
│   tools/*         │              │                        │              │   lore-server/   │
│                   │              │   Stages:              │              │     db.ts        │
│   Does NOT import │              │   SourceIndexStage     │              └────────┬────────┘
│   from indexer/   │              │   DocsIndexStage       │                       │
│   except through  │              │   ImportResolutionStage│                       │
│   shared types    │              │   DependencyApiStage   │                       │
│   and storage     │              │   LspEnrichmentStage   │                       │
│   layer.          │              │   ResolutionStage      │                       │
│                   │              │   CoverageStage        │                       │
│                   │              │   TestMapStage         │                       │
│                   │              │   HistoryStage         │                       │
│                   │              │   EmbeddingStage       │                       │
│                   │              │   CheckpointService    │                       │
└───────┬───────────┘              └──────────┬─────────────┘                       │
        │                                     │                                    │
        └─────────────────┬───────────────────┘                                    │
                          │                                                        │
                          ▼                                                        │
                ┌─────────────────────────┐                                        │
                │   Domain Services       │                                        │
                │                         │◄───────────────────────────────────────┘
                │   Write-side:           │
                │     FileRepository      │
                │     SymbolRepository    │
                │     RefRepository       │
                │     DocsRepository      │
                │     HistoryRepository   │
                │     CoverageRepository  │
                │     NotesRepository     │
                │     EmbeddingRepository │
                │                         │
                │   Read-side:            │
                │     SymbolQueryService  │
                │     DocsQueryService    │
                │     GraphQueryService   │
                │     HistoryQueryService │
                │     CoverageQueryService│
                │     NotesQueryService   │
                └─────────┬───────────────┘
                          │
                          ▼
                ┌─────────────────────────┐
                │   Shared Types          │
                │                         │
                │   resolution-method.ts  │
                │   extractors/types.ts   │
                │   walker.ts types       │
                │   embedder.ts types     │
                │   logger.ts             │
                └─────────────────────────┘
```

## Layering rules

1. **runtime → domain services → storage → shared types**
   - Upper layers may depend on lower layers, never the reverse.
   - `cli.ts` depends only on `runtime.ts` and lazy imports for subcommands.

2. **MCP tools depend on domain query services, not raw SQL.**
   - No tool file imports from `indexer/db.ts` directly.
   - Each tool depends on at most one domain query service.

3. **Pipeline stages depend on domain repositories, not raw SQL.**
   - Write-side operations go through repository classes.
   - Stages share a `PipelineContext`, not raw DB handles.

4. **Enrichment → Resolution ordering is structural.**
   - `IndexPipeline` enforces stage ordering.
   - `ResolutionStage` always runs after `LspEnrichmentStage`.

5. **`resolution_method` taxonomy is owned by `resolution-method.ts`.**
   - Writers (call-graph.ts, RefRepository) import from there.
   - Readers (graph.ts, GraphQueryService) import from there.
   - No bare string literals for resolution methods anywhere.

6. **One authoritative schema owner per table.**
   - DDL lives in domain-specific migration sets.
   - No single monolithic DDL blob.

## Public APIs to preserve

| API | Export from | Status |
|-----|------------|--------|
| `IndexBuilder` | `src/index.ts` | Preserve (becomes façade) |
| `openDb` | `src/index.ts` | Preserve |
| `resolveSymbolEdges` | `src/index.ts` | Preserve |
| `createLoreMcpServer` | `src/index.ts` | Preserve |
| `createLoreMcpServerAsync` | `src/index.ts` | Preserve |
| `LoreRuntime` / `RuntimeConfig` | `src/index.ts` | Preserve (new) |
| `IndexPipeline` / `PipelineStage` | `src/index.ts` | Preserve (new) |
| `RESOLUTION_METHODS` / `ResolutionMethod` | `src/index.ts` | Preserve (new) |
| `registerTools` / `ToolModule` | `src/index.ts` | Preserve (new) |
| `walkFiles` / `WalkerConfig` | `src/index.ts` | Preserve |
| `LoreLogger` / `initLogger` | `src/index.ts` | Preserve |

## APIs to intentionally remove

| API | Reason |
|-----|--------|
| `buildCallGraph` | Deprecated alias for `resolveSymbolEdges` |
| `ParserPool` (if exported) | Internal implementation detail |
| `listConfigEntries` | No DDL, stale reader — replaced with stub returning `[]` |
| `normalizeTypeName` | Internal helper, not part of public contract |

## Feature status decisions (Phase 5)

| Feature | Decision | Action taken |
|---------|----------|-------------|
| `modules` / `file_modules` | Keep DDL, defer writer | LEFT JOINs return NULL gracefully; documented as unimplemented |
| `config_entries` | Remove stale reader | `listConfigEntries()` replaced with stub returning `[]` |
| `external_symbols` | Internal enrichment data | Written during dependency indexing; consumed by `lore_lookup` and `lore_search` internally; no dedicated MCP tool needed |
| `annotations` | Complete | Writer in `processFile()`, reader via `lore_annotations` tool |

## Resolution method taxonomy

Defined in `src/indexer/resolution-method.ts`:

```typescript
export const RESOLUTION_METHODS = [
  'lsp_definition',      // LSP returned precise definition
  'name_same_file',      // Unique name match within same file
  'name_unique',         // Unique name match globally
  'external_definition', // Definition outside indexed set
  'ambiguous_definition',// Multiple equally-narrow candidates
  'unresolved',          // No strategy succeeded
] as const;
```

Consumed by:
- **Writers**: `call-graph.ts` (`resolveSymbolEdges`), `RefRepository`
- **Readers**: `graph.ts` (MCP tool), `GraphQueryService`
