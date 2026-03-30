# Lore Architecture

Detailed view of Lore's indexing pipeline, storage schema, and MCP tool surface.

## High-level module layout

```
LoreRuntime              ← lifecycle owner (DB, embedder, LSP, watcher/poller)
  └─ IndexBuilder        ← façade over IndexPipeline
       └─ IndexPipeline  ← ordered, composable stage chain
            ├─ ScipIndexerStage
            ├─ FileDiscoveryStage
            ├─ LspExtractionStage
            ├─ ImportResolutionStage
            ├─ LspEnrichmentStage
            ├─ FtsRefreshStage        (inline)
            ├─ ResolutionStage        (inline)
            ├─ HistoryStage           (inline)
            ├─ ReverseDepsStage
            └─ EmbeddingStage
  └─ GraphAnalysis       ← SCC, connected components, clustering, summary
  └─ MCP Server
       └─ ToolRegistry   ← auto-registers tools from toolDef exports
```

`LoreRuntime` (`runtime.ts`) owns all long-lived resources — database handles,
embedding providers, LSP coordinators, and file-change refreshers. Both CLI
sub-commands and the MCP server dispatch through a single runtime instance.

`IndexBuilder` (`indexer/index.ts`) is now a thin **façade** (~310 lines, down
from ~1 230) that delegates to `IndexPipeline` for both full builds and
incremental updates.

`ToolRegistry` (`server/tool-registry.ts`) auto-discovers tool modules
and wires them into the MCP server from each module's exported `toolDef` /
`handler` — eliminating duplicate Zod schema definitions.

## Full pipeline

```mermaid
flowchart LR
    subgraph Codebase
        SRC[Source Files]
        GIT[Git Repo]
    end

    subgraph Lore Indexer
        SCIPIDX[SCIP Indexer<br/>pre-resolved symbols + refs]
        FILEDISCO[File Discovery<br/>fast-glob · extension map]
        LSPEXTRACT[LSP Extraction<br/>symbols · imports · call refs<br/>type refs · annotations]
        RESOLVE[ImportResolver<br/>internal ↔ external]
        DEPAPI[Dependency API Indexer<br/>direct deps · TS/Py/Go/Rust declarations]
        CALLGRAPH[Relationship Resolver<br/>3-tier resolution · topo sort]
        LSP[LSP Enrichment<br/>batch-pipelined hover + definition<br/>persisted metadata]
        EMBED[Embedder<br/>Transformers.js ONNX<br/>async init · overlapped batches]
        GITHIST[Git History Ingest<br/>commits · diffs · refs]
    end

    subgraph SQLite Lore
        FILES[(files)]
        SYM[(symbols · symbols_fts)]
        IMP[(file_imports · external_deps)]
        EXT[(external_symbols)]
        REFS[(symbol_refs)]
        TYPES[(symbol_relationships · type_refs)]
        ANN[(annotations)]
        VEC[(symbol_embeddings · symbol_semantic_embeddings<br/>commit_embeddings)]
        HIST[(commits · commit_files<br/>commit_refs)]
        META[(lore_meta · symbol_summaries)]
    end

    subgraph MCP Server
        LOOKUP[lore_lookup]
        SEARCH[lore_search<br/>BM25 · vector · fused]
        GRAPH[lore_graph]
        SNIPPET[lore_snippet]
        BLAME[lore_blame]
        HISTORY[lore_history]
        METRICS[lore_metrics]
        TRACE[lore_trace]
        DIFF[lore_diff]
        COHESION[lore_cohesion]
        DEPENDENTS[lore_dependents]
    end

    subgraph LLM_AGENTS[Agents]
        CLAUDE[Claude]
        COPILOT[GitHub Copilot]
        CUSTOM_AGENT[Custom Agents]
        CLAUDE ~~~ COPILOT ~~~ CUSTOM_AGENT
    end

    subgraph ENTRY[User Entrypoints]
        VSCODE[VS Code]
        CURSOR[Cursor]
        CHAT[Chat UI]
        ORCH[Agent Frameworks]
        VSCODE ~~~ CURSOR ~~~ CHAT ~~~ ORCH
    end

    SRC --> SCIPIDX --> FILES & SYM & REFS & TYPES
    SRC --> FILEDISCO --> LSPEXTRACT
    LSPEXTRACT --> RESOLVE --> IMP
    RESOLVE --> DEPAPI --> EXT
    LSPEXTRACT --> CALLGRAPH --> REFS
    LSPEXTRACT --> CALLGRAPH --> TYPES
    LSPEXTRACT --> ANN
    LSPEXTRACT --> LSP
    LSP --> SYM
    LSP --> REFS
    LSP --> TYPES
    LSP --> EXT
    LSPEXTRACT --> FILES & SYM
    EMBED -.->|optional| VEC
    GIT --> GITHIST --> HIST

    FILES & SYM & IMP & EXT & REFS & TYPES & ANN & VEC & HIST & META --- LOOKUP & SEARCH_TOOL & GRAPH & SNIPPET & BLAME & HISTORY & METRICS & TRACE & DIFF & COHESION & DEPENDENTS

    LOOKUP & SEARCH_TOOL & GRAPH & SNIPPET & BLAME & HISTORY & METRICS & TRACE & DIFF & COHESION & DEPENDENTS <--> LLM_AGENTS

    LLM_AGENTS <--- ENTRY
```

## Pipeline stages

The indexing pipeline is decomposed into composable `PipelineStage` objects
orchestrated by `IndexPipeline` (`pipeline.ts`). The stage ordering enforces
data dependencies structurally rather than by call-site discipline:

```
ScipIndexer → FileDiscovery → LspExtraction → ImportResolution
  → LspEnrichment → FtsRefresh → Resolution → ReverseDeps → History → Embedding
```

SCIP is the primary indexing strategy. `ScipIndexerStage` runs first,
producing symbols and pre-resolved edges directly from SCIP indexers.
`FileDiscoveryStage` discovers source files, and `LspExtractionStage`
extracts symbols, imports, and relationships via LSP. There is no tree-sitter
fallback — the pipeline is fully SCIP+LSP.

The **enrichment → resolution** ordering is load-bearing: `resolveSymbolEdges`
reads `definition_path` / `definition_line` columns that are only populated
during the LSP enrichment stage.

| Stage | Module | What it does |
|-------|--------|--------------|
| ScipIndexer | `stages/scip-indexer.ts` | Run SCIP indexers (or read pre-computed `.scip` files) for covered languages; populates symbols + refs with pre-resolved edges |
| FileDiscovery | `stages/file-discovery.ts` | Discover source files via `fast-glob`, map extensions to languages |
| LspExtraction | `stages/lsp-extraction.ts` | Extract symbols, imports, call refs, type refs, and annotations via LSP |
| ImportResolution | `stages/import-resolution.ts` | Resolve raw imports to file IDs using a bulk `Map<path, fileId>` lookup |
| LspEnrichment | `stages/lsp-enrichment.ts` | Batch-pipelined LSP hover + definition lookups (parallel per position, concurrent batches of 30); persists resolved type signature/return/definition metadata |
| FtsRefresh | inline | Refresh FTS5 full-text search indexes |
| Resolution | inline | 3-tier resolution via `call-graph.ts`: LSP containment → same-file name match → unique name match |
| ReverseDeps | `stages/reverse-deps.ts` | Build reverse dependency edges for blast-radius queries |
| History | inline | Git history ingestion via `simple-git` |
| Embedding | `stages/embedding.ts` | Overlapped batch embedding — fires next `embed()` while writing current batch to DB; handles scoped re-embedding in update mode |

### Supporting modules

| Module | What it does |
|--------|--------------|
| `discovery/walker.ts` | Discovers source files via `fast-glob`, maps extensions to languages |
| `resolution/resolver.ts` | Classifies each raw import as internal (resolved to a file ID) or external (third-party / stdlib) |
| `resolution/call-graph.ts` | 3-tier symbol resolution with SCIP/LSP-first ref resolution and name-based fallback; supports topo sort and cycle detection |
| `resolution/graph-analysis.ts` | Higher-level graph primitives: Tarjan SCC on symbol adjacency, union-find connected components, SCC-contracted bounded clustering, and condensed codebase summary |
| `scip/*` | SCIP index reading, enrichment coordinator, indexer config, and protobuf definitions |
| `embeddings/embedder.ts` | Optional — uses `@huggingface/transformers` (Transformers.js) to run ONNX embedding models natively in Node.js; default model `Qwen/Qwen3-Embedding-0.6B`; supports CoreML/WebGPU hardware acceleration, quantized ONNX dtype (fp32/fp16/q8/q4), skip-unchanged hash-based re-embedding, and lazy on-demand initialization |
| `process-tracker.ts` | Global registry of spawned child processes; `killAllTracked()` ensures cleanup on SIGINT/SIGTERM/exit |
| `git/history.ts` | Ingests commits, per-file diffs, and branch/tag refs via `simple-git` |
| `resolution/resolution-method.ts` | Authoritative taxonomy for `resolution_method` column values shared by writers and readers |




## Resolution method taxonomy

The `resolution_method` column on `symbol_refs`, `type_refs`, and
`symbol_relationships` uses an authoritative taxonomy defined in
`resolution-method.ts`. Tiers are ordered from highest to lowest confidence:

| Method | Confidence | Description |
|--------|------------|-------------|
| `lsp_definition` | Highest | LSP server returned a precise definition location mapped to the narrowest enclosing indexed symbol |
| `name_same_file` | High | No LSP data; callee/type name matched exactly one symbol in the same file |
| `name_unique` | Medium | No LSP data; callee/type name matched exactly one symbol in the entire index |
| `external_definition` | — | LSP definition path is outside the indexed file set (e.g. `node_modules`, stdlib) |
| `ambiguous_definition` | — | LSP definition maps to multiple equally-narrow candidates |
| `unresolved` | — | No resolution strategy succeeded; dangling name reference |

`RESOLVED_METHODS` (`lsp_definition`, `name_same_file`, `name_unique`) indicates a successfully resolved target with a non-NULL `target_id`. `UNRESOLVED_METHODS` are references where `target_id` is NULL.

## Performance optimizations

Key optimizations in the indexing pipeline (v0.3.0):

- **Batch-pipelined LSP requests** — hover + definition fire in parallel per position; all targets within a file are processed in concurrent batches of 30 instead of sequential round-trips
- **Hoisted prepared statements** — 21 prepared statements created once per build/update via `initPreparedStatements()` instead of re-compiled per file
- **Stat-based change detection** — `fs.statSync().size` checked against stored `size_bytes` before reading and hashing full file content on re-index
- **Overlapped embedding batches** — embedding methods (structural symbols and commit messages) fire the next batch `embed()` while writing the current batch to DB
- **Bulk file ID map** — single `Map<path, fileId>` built from one query instead of N individual `SELECT` lookups per import
- **Batched containment resolution** — refs grouped by `definition_path`, file + symbols loaded once per path instead of 2 queries per ref
- **Async embedder initialization** — `EmbedderRef` mutable container lets MCP server start and emit READY immediately while embedding model loads in background (`--blocking-embedder` available for full capability at startup)

## SQLite schema groups

| Table group | Tables | Purpose |
|-------------|--------|---------|
| Files | `files` | Indexed source files with path, branch, language, hash |
| Symbols | `symbols`, `symbols_fts` | Named code symbols + FTS5 full-text index; includes optional persisted LSP enrichment (`resolved_type_signature`, `resolved_return_type`, `definition_uri`, `definition_path`) |
| Imports | `file_imports`, `external_deps` | Import declarations resolved to file IDs or external packages |
| Dependency APIs | `external_symbols` | Exported/public declarations from direct dependency APIs across npm, Python, Go, and Rust (ecosystem/source/package/version + symbol metadata), stored separately from in-repo symbols; includes optional persisted LSP enrichment metadata |
| Relationships | `symbol_refs`, `symbol_relationships`, `type_refs` | Call-site edges, inheritance/implements-style relationships, and symbol → referenced-type edges, including optional persisted LSP enrichment metadata |
| Annotations | `annotations` | Indexed TODO/FIXME/HACK/NOTE-style source annotations with file and line metadata |
| Embeddings | `symbol_embeddings`, `symbol_semantic_embeddings`, `commit_embeddings` | vec0 virtual tables for semantic symbol retrieval and semantic commit-message history retrieval |
| History | `commits`, `commit_files`, `commit_refs` | Git commit metadata, touched files, and named refs |
| Metadata | `lore_meta`, `symbol_summaries`, `modules`, `file_modules` | Key-value config, LLM summaries, logical module groupings |

## MCP tools

| Tool | Purpose |
|------|---------|
| `lore_lookup` | Find symbols by name or files by path (optional branch filter), including external API symbol matches from `external_symbols` and persisted LSP-enrichment metadata when available |
| `lore_search` | Structural BM25, semantic vector, or fused RRF search; structural results are augmented by external symbol-name matches from `external_symbols`; returns persisted LSP-enrichment metadata fields when available |
| `lore_graph` | Query call, import, inheritance, or type-dependency edges with automatic transitive traversal (up to 5 hops); supports `source_id` for outbound and `target_id` for inbound/reverse queries; materializes virtual dispatch edges  |
| `lore_trace` | Trace execution paths between two symbols through the call graph |
| `lore_diff` | Diff exported API surfaces between branches |
| `lore_cohesion` | Compute module cohesion metrics for a file or directory |
| `lore_dependents` | Unified reverse-dependency / blast-radius query with automatic transitive traversal (up to 5 hops) across callers, importers, subclasses, and type refs |
| `lore_snippet` | Return snippets from indexed DB-backed file snapshots by file path + line range or by symbol name; path/symbol resolution is branch-aware and responses include containing-symbol context metadata when available |
| `lore_blame` | Query blame (`mode: "blame"`), line-range evolution (`mode: "history"`), or ownership aggregates (`mode: "ownership"`), including symbol-targeted range resolution |
| `lore_history` | Query history by file, commit, author, ref, recency, or semantic commit-message similarity (with graceful fallback to recent mode when vectors are unavailable) |
| `lore_metrics` | Return aggregate index metrics |

`lore_blame` response enrichment:
- Supports legacy `line`/`start_line`/`end_line` requests and symbol-driven targeting (`symbol` + optional `path`/`branch`), returning `resolved_symbol` when symbol resolution is used.
- History and ownership modes include enriched commit context (`commits` and per-entry `commit_context`) with commit message details, touched files, and refs/tags.
- All modes return risk indicators derived from recency, author dispersion, and churn (`risk.recency`, `risk.author_dispersion`, `risk.churn`, `risk.overall`).

`lore_lookup` request schema highlights:

- `match_mode` (`exact` | `prefix` | `contains`) is available for `kind="symbol"` lookups and defaults to `exact`.
- `symbol_kind`, `path_prefix`, and `language` are optional symbol filters.
- `limit` and `offset` are optional pagination inputs for empty-query symbol browsing (defaults: `20` and `0`).

External symbol retrieval flow:
1. Dependency API indexing is opt-in and reads declaration surfaces from direct dependencies only:
   - npm: top-level `package.json` direct deps (`dependencies` / `devDependencies` / `peerDependencies`)
   - Python: direct requirements from project dependency manifests, indexed via `.pyi` / `py.typed` declaration sources
   - Go: direct `require` entries from root `go.mod`
   - Rust: direct dependency entries from root `Cargo.toml`
2. Exported dependency declarations are persisted to `external_symbols` with package/version metadata.
3. Transitive dependencies are excluded in all ecosystems; Lore indexes only the direct boundary.
4. MCP retrieval paths include `external_symbols` for symbol-facing queries so dependency APIs can be returned alongside in-repo symbols in `lore_lookup` and structural `lore_search`.

Query-time behavior:
- LSP servers are index-time only. MCP/Lore query handlers do not spawn or call language servers.
- `lore_lookup` and `lore_search` read persisted enrichment fields directly from SQLite.
