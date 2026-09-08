# Lore architecture

This document describes the implementation represented by the current source
tree. The public front door is the repository README; this file defines storage,
indexing, and serving internals.

## System boundaries

- `src/cli.ts` parses one of nine commands and dispatches to command handlers.
- `IndexBuilder` owns configuration resolution, writer serialization, database
    lifetime, pipeline construction, validation, and baseline promotion.
- `IndexPipeline` executes ordered `PipelineStage` entries. An array entry runs
    concurrently with `Promise.allSettled`; every stage is disposed after success
    or failure.
- `LoreRuntime` owns long-lived embedding and watch/poll resources. Index-time
    LSP coordinators remain stage-owned.
- `createLoreMcpServer()` opens no writers. It requires a schema-compatible
    read-only database and registers a fixed list of 11 tool modules.

The source index consists of persisted snapshots plus SCIP and LSP facts. There
is no tree-sitter source extractor, documentation index, dependency-declaration
crawler, or active complexity-metrics extractor.

## SQLite schema v3

The on-disk version is `3`. It is recorded independently in
`lore_meta.schema_version` and SQLite `user_version`; both markers must be
present and agree. A database claiming v3 with either marker missing or
disagreeing is incompatible rather than a repair candidate. A marker newer
than this build is rejected before WAL mode or another mutating pragma is
applied.

Writable `openDb()` calls apply the ordered migration sequence `[1, 2, 3]` and
then run capability inspection. The sequence is contiguous:

1. create or complete the relational schema;
2. add generation-aware incremental storage; and
3. install the current effective-view and target-reconciliation semantics
     without guessing that an unpromoted generation is valid.

`lore migrate` is the dedicated in-place migration command and runs under the
same writer lock as indexing. `lore doctor` and its `lore validate` alias open
the database read-only. They return a structured `SCHEMA_MISSING`,
`SCHEMA_OUTDATED`, or `SCHEMA_NEWER` issue rather than changing it. The MCP
server also uses the read-only compatibility gate and does not migrate at
startup.

### Table groups

| Group | Tables | Role |
|---|---|---|
| Source | `files`, `symbols` | Absolute source paths, branches, snapshots, hashes, spans, signatures, and enrichment metadata |
| Edges | `symbol_refs`, `type_refs`, `symbol_relationships` | Calls, type use, inheritance/implementation, target IDs, coordinates, and resolution provenance |
| Imports | `file_imports`, `external_deps` | Raw imports/includes, internal file targets, and external package classification |
| Visibility | `baseline_generations`, `dirty_files` | Branch promotion pointers and path-level overlay selectors |
| Derived | `symbols_fts`, `reverse_deps` | FTS5 symbol retrieval and file-level reverse dependencies |
| Provenance | `index_runs`, `indexer_runs`, `lore_meta` | Run status, provider attempts, configuration, generation, model, and compdb details |
| Git | `commits`, `commit_files`, `commit_refs` | Commit metadata, touched-file statistics, and branch/tag refs |
| Optional vectors | `symbol_embeddings`, `symbol_semantic_embeddings`, `commit_embeddings` | `sqlite-vec` tables created after an embedding provider reports dimensions |
| Other public storage | `symbol_summaries`, `modules`, `file_modules` | Caller-ingested summaries and optional module mappings |

`annotations`, `symbol_metrics`, and `external_symbols` remain schema/query
surfaces, but the active pipeline does not populate them. Exact symbol lookup
can read existing `external_symbols` rows. `IndexBuilder.ingestSummary()` writes
`symbol_summaries` and, when configured, `symbol_semantic_embeddings`.

## Effective and staging views

Source rows carry `layer` (`baseline` or `overlay`) and `generation`. New
baseline reservations are positive and overlays use generation `0`. A branch
row in `baseline_generations` identifies the visible baseline. `dirty_files` is
keyed by `(path, branch)`.

Persistent views provide current state:

- `effective_files`
- `effective_symbols`
- `effective_symbol_refs`
- `effective_type_refs`
- `effective_symbol_relationships`
- `effective_annotations`
- `effective_file_imports`
- `effective_symbol_metrics`

For a dirty path, `effective_files` selects its overlay row; a dirty deletion
sentinel can intentionally select no row. For every other path it selects only
the branch's promoted baseline generation. Child views join through that file
set. Public file, symbol, edge, semantic, graph-analysis, cohesion, and structure
queries use effective state.

A baseline writer installs TEMP views with the same names on its connection.
SQLite resolves TEMP objects first, so pipeline stages see only their hidden
candidate generation while all other connections continue to use the persistent
views and the promoted generation.

## Writer coordination and run atomicity

Every `IndexBuilder` writer operation enters `withDbWriter()`:

1. a process-wide queue serializes operations by canonical database path;
2. a filesystem lease directory records a random owner token and PID, receives
     heartbeats, and supports stale-owner recovery; and
3. the owner atomically claims a monotonic `writer_generation` in SQLite.

Long-running stages periodically assert the database fence. Promotion and
cleanup assert it again, so a process whose filesystem lease was recovered
cannot publish stale work. SQLite runs in WAL mode with foreign keys enabled.

Overlay updates run the complete stage pipeline inside one `BEGIN IMMEDIATE`
transaction. Failure rolls back stage writes and dirty selectors; the retained
run record is then finalized as failed.

Baseline builds and reconciliations cannot hold a writer transaction across
SCIP processes, LSP requests, and model calls. They therefore use a fenced
generation lifecycle:

1. reserve a globally increasing generation and record an `index_runs` row;
2. write bounded batches into the hidden generation through staging views;
3. compute provider degradation and validate the candidate when a policy is
     configured;
4. drop the TEMP views and, in one short immediate transaction, assert the
     writer fence, advance the branch promotion pointer, clear branch dirty
     selectors, publish staged metadata and HEAD state, and finalize the run;
5. reclaim inactive baseline and overlay file rows in batches of 200.

If pipeline or validation fails, candidate source rows and their derived symbol
rows are removed while the prior promoted baseline remains visible. Provider
provenance and the failed run remain available for diagnosis. Cleanup after a
successful visibility switch is retryable and cannot turn the published run
into a failure.

The atomic visibility claim applies to generation-scoped source state. Git
history tables and provider-run rows are global rather than generation-scoped;
their writes may be observable before a baseline candidate is promoted.

## Active pipeline

Every build, baseline reconciliation, and overlay update uses this exact stage
order:

```
ScipIndexerStage
    → FileDiscoveryStage
    → LspExtractionStage
    → ImportResolutionStage
    → [LspEnrichmentStage + git-history]
    → symbol-resolution
    → ReverseDepsStage
    → EmbeddingStage
    → FtsRefreshStage
    → optional validation
    → baseline promotion (baseline runs only)
```

Promotion is managed by `IndexBuilder` after the pipeline. The exported
`OverlayCleanupStage` wraps promotion helpers for direct composition but is not
an entry in the active builder pipeline.

| Stage | Current responsibility |
|---|---|
| `ScipIndexerStage` | Baseline only. Read precomputed indexes or run authorized available indexers; normalize coordinates; write files, symbols, imports, calls, type refs, relationships, enrichment metadata, and virtual-dispatch calls. |
| `FileDiscoveryStage` | Walk the configured source scope, store snapshots and SHA-256 hashes for files not already inserted by SCIP, populate the byte-budget source cache, handle overlay replacements/deletions, and reconcile hidden targets. It performs no AST extraction. |
| `LspExtractionStage` | For baseline supplementation or changed overlay files, use `documentSymbol`, outgoing call hierarchy, hover, and definition requests to write symbols, call refs, and metadata. It does not create general type refs, imports, or annotations. |
| `ImportResolutionStage` | Extract literal C/C++ includes missing from SCIP, resolve effective imports to effective files or external dependencies, and use validated compdb include paths before bounded path heuristics. |
| `LspEnrichmentStage` | Enrich remaining eligible symbols and edges with hover/definition metadata in three-file batches. Overlay extraction already enriches ordinary changed files. |
| Git history | When requested, upsert commits, per-file change statistics, refs, and the ingestion watermark concurrently with LSP enrichment. |
| Symbol resolution | Reconcile effective targets, then resolve still-unresolved call, type, and relationship edges. |
| `ReverseDepsStage` | Build candidate reverse dependencies for baselines or refresh outgoing and inbound rows for affected overlay paths. |
| `EmbeddingStage` | When a provider exists, embed eligible effective symbols and optional commit messages; overlay work deletes hidden IDs and hashes inputs to skip unchanged text. |
| `FtsRefreshStage` | Insert candidate FTS rows for a baseline or replace only stale/changed overlay symbol rows. |

## Data-source roles

### File discovery

`fast-glob` enumerates configured include patterns, merges built-in and caller
exclusions, maps extensions to languages, follows symlinks, canonicalizes every
path, rejects links that leave the indexed root, and de-duplicates physical
files. Discovery guarantees a snapshot for recognized in-scope files; it does
not guarantee structural symbols.

The walker and default LSP registry share 23 language names: Bash, C, C++, C#,
Elixir, Elm, Go, Haskell, Java, JavaScript, Julia, Kotlin, Lua, Objective-C,
OCaml, PHP, Python, Ruby, Rust, Scala, Swift, TypeScript, and Zig.

### SCIP baseline

The default SCIP registry has entries for TypeScript, Python, Java, Scala,
Kotlin, Rust, C, C++, C#, Ruby, PHP, Go, and Dart. Dart is not in the walker or
default LSP registry, so the registry entry alone does not make `.dart` files
part of a normal discovery pass.

SCIP is baseline-only and compiler/indexer output is authoritative when
present. Lore converts each document's SCIP position encoding to zero-based
UTF-16 storage coordinates, constructs parent relationships, classifies refs,
maps definitions to concrete IDs, preserves unresolved/external refs, and
materializes implementation dispatch edges. Multiple available detected
indexers may contribute to one baseline.

Precomputed `index.scip` or per-language files under `scip.indexDir` are read
without process permission, but the configured directory and each canonical
file target must remain under the indexed project root or an explicit
host-approved root. Ungranted lexical `..` escapes and symlinks to unapproved
files are rejected. Executed indexers require an explicit host grant, must
declare an `{output}` argument, and write to a securely verified private
temporary output. See
[execution-trust.md](execution-trust.md) for the complete boundary.

### Compilation databases and C/C++

Lore checks, in order, `compile_commands.json`, `build/compile_commands.json`,
`builddir/compile_commands.json`, and `.lore-compdb/compile_commands.json`.
Reading an existing candidate requires no build grant. Parsing is bounded,
never invokes a shell, expands response files under per-entry budgets, and
validates every translation unit and working directory against the project root
plus host-approved external roots.

With an explicit build grant, Lore can run CMake, Meson, or Bear/Make (and
`configure` when needed) to create `.lore-compdb/compile_commands.json`.
`scip-clang` receives only a usable database with at least one live source/cwd
pair. Compdb hashes, validation counts, indexer identity, and degradation detail
are persisted in run provenance and C/C++ reproducibility metadata.

The compilation database also supplies include paths for import resolution and
C/C++ header-language evidence. Literal includes then fall back to suffix or
basename matching only when the result is uniquely determined by indexed path
and nearest-directory evidence.

### LSP extraction and enrichment

LSP is enabled as a request by default, but a server starts only with a host
grant and an available executable. One stage-owned coordinator multiplexes
servers by language and disposes them at the end of the stage.

For a baseline, `planBaselineLspSupplementation()` selects:

- every file not sourced by SCIP;
- a SCIP-sourced C/C++ file with zero symbols; and
- a SCIP-sourced C/C++ file containing a repairable symbol span.

The default limit is 500 files with four concurrent file requests. Reaching the
cap records degradation and omits remaining files from structural
supplementation; `strict: true` fails the build instead. Stable one-to-one
symbol reconciliation uses exact path, selection, kind, parent chain, range,
and signature evidence. For C/C++, unconditional raw `#define` declarations
may be added; conditional macros are added only when the language server
exposes the declaration.

For overlays, LSP processes changed files after discovery. It writes document
symbols and outgoing calls, then enriches those files in the same coordinator
pass. Unavailable or failed servers are recorded; affected snapshots can remain
symbol-less.

LSP is index-time only. MCP query handlers never start a language server.

## Overlay replacement and target repair

Changing a path creates or replaces a generation-0 overlay row and inserts its
`dirty_files` selector. Deleting or excluding an indexed path leaves the dirty
selector without an overlay file row, hiding the baseline path.

Replacing a file changes both file and symbol row IDs. Current-state edges in
unchanged files may still point at the hidden IDs, so schema v3 repairs targets
at three points: the dirty-file insertion trigger, file discovery after all
changes, and symbol resolution before it counts unresolved work.

- Import targets are remapped by stable `(path, branch)` when a replacement
    file exists; otherwise they become stale and are reconsidered by import
    resolution.
- Call, type, and relationship target IDs are cleared when they no longer join
    to `effective_symbols`; their stored definition coordinates and names remain
    available for the resolver.
- A stale edge whose target path becomes effective again returns to unresolved
    work.

Resolution therefore scans branch-scoped effective state even during an
overlay-only run. Reverse dependencies and FTS rows are then refreshed for both
outbound and inbound effects of every affected path.

## Edge and import resolution

SCIP can write a resolved `scip_definition` directly. Remaining symbol edges
use these passes:

1. map an LSP definition path and UTF-16 position to an exact selection/start
     or the uniquely narrowest containing symbol (`lsp_definition`);
2. accept a unique same-file name (`name_same_file`);
3. accept a globally unique name (`name_unique`), excluding macro, constant,
     and enum-member kinds from cross-file matching; and
4. when all eligible overloads reside in one target file, select the first
    candidate (`name_single_file`).

`RESOLVED_METHODS` contains those five methods. Null-target states are
`external_definition`, `ambiguous_definition`, `overlay_stale`, and
`unresolved`. Every edge retains its method so consumers can distinguish
compiler/LSP evidence from name matching.

Imports have a separate taxonomy: `filesystem_exact`,
`compilation_database`, `include_basename_unique`,
`include_basename_nearest`, `include_suffix_unique`,
`include_suffix_nearest`, `external_dependency`, `overlay_stale`, and
`unresolved`. Validation reports exact internal, external, heuristic internal,
and unresolved coverage separately.

## FTS, vectors, and Git data

`symbols_fts` indexes symbol name, kind, signature, resolved type, and resolved
return type. A hidden baseline inserts rows under globally unique candidate
symbol IDs without deleting active rows. Queries join FTS row IDs through
`effective_symbols`; post-promotion cleanup removes inactive IDs. Overlay
refresh deletes stale IDs and rewrites only changed-file symbols.

Embeddings are optional. The default provider is Transformers.js using
`onnx-community/Qwen3-Embedding-0.6B-ONNX`, CPU, and `q8`; dimensions are
detected at initialization and recorded with the model. Structural embedding
text combines signature, resolved type, resolved return type, and name. Batches
are bounded by estimated tokens and item count, and overlay hashes skip
unchanged input. Semantic and fused query modes fall back to structural search
when a compatible query provider or vector table is unavailable. An explicit
disabled policy prevents both provider use and reuse of the model recorded in
`lore_meta`.

Git ingestion is optional and traverses all refs unless configured otherwise.
It stores commit headers, parents, touched paths and line statistics, and refs.
When both history and embeddings are enabled, commit messages receive vectors;
semantic history falls back to recent commits without them.

## MCP registry and limits

`buildToolModules()` dynamically imports a fixed source list; it does not scan a
directory. Every handler returns one MCP text item containing JSON. The wrapper
logs the call and adds `{source, baseline_age_s, dirty_file_count}` freshness to
object results when available.

| Tool | Current behavior |
|---|---|
| `lore_lookup` | File lookup or exact/semantic/fused symbol lookup with branch, name, kind, path, language, and browse controls |
| `lore_search` | Symbol-only FTS5 BM25, vector, or reciprocal-rank-fused search |
| `lore_graph` | Call, import, inheritance, or type-dependency edges; anchored traversal is fixed at five hops and 1,000 edges |
| `lore_snippet` | Lines from persisted source snapshots for a required indexed path, with an optional range or unambiguous symbol in that file |
| `lore_blame` | Live Git blame, line history, or ownership, optionally targeted by an indexed symbol |
| `lore_history` | Indexed commits by file, SHA, author, ref, semantic message, or recency |
| `lore_trace` | Forward DFS or shortest point-to-point paths over resolved calls with bounded stored-source snippets |
| `lore_diff` | Added, removed, and signature-changed exported symbols between two indexed branches |
| `lore_cohesion` | Global directory cohesion/instability over at most 10,000 resolved call edges |
| `lore_structure` | Branch-filterable directory import cycles, DFS back edges, and weak-link outliers over at most 10,000 imports |
| `lore_dependents` | Callers, importers, and subclasses with fixed five-hop traversal, plus direct target type references; each category has a 1,000-row query cap |

Current serving limits:

- `lore_search` has no file-content or documentation result type.
- Exact `lore_lookup` can return pre-existing `external_symbols`; indexing does
    not create them. `--index-deps` does not activate a crawler; it only adds
    TypeScript to active LSP-enrichment server selection.
- `lore_metrics` is not registered and the pipeline does not populate
    `symbol_metrics`.
- `lore_diff` depends on `is_exported = 1` data and requires two indexed
    branches. Active SCIP/LSP ingestion does not populate `is_exported`, so
    ordinary indexes can return no rows unless another producer supplies that
    metadata.
- `lore_dependents` traverses callers, importers, and subclasses. Type-reference
    results are direct references to the requested symbol or symbols in the
    requested file; they are not recursively expanded.
- `lore_history` requires prior history ingestion. Its semantic mode requires
    commit vectors and otherwise returns recent commits.
- `lore_blame` invokes Git against the live checkout, so it requires the path to
    remain in a repository and can describe a newer working state than the stored
    source snapshot.
- `lore_cohesion` has no branch or path filter and ranks all effective branches
    together.
- Query tools expose persisted facts; they do not repair missing structural
    coverage at request time.
