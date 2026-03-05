# Lore Architecture

Detailed view of Lore's indexing pipeline, storage schema, and MCP tool surface.

## Full pipeline

```mermaid
flowchart LR
    subgraph Codebase
        SRC[Source Files]
        DOCSRC[Documentation Files]
        GIT[Git Repo]
        COVREP[Coverage Reports]
    end

    subgraph Lore Indexer
        WALK[Walker<br/>fast-glob · extension map]
        PARSE[ParserPool<br/>tree-sitter grammars]
        EXTRACT[Extractors<br/>symbols · imports · call refs]
        RESOLVE[ImportResolver<br/>internal ↔ external]
        DEPAPI[Dependency API Indexer<br/>direct deps · TS/Py/Go/Rust declarations]
        CALLGRAPH[Call-Graph Builder<br/>callee resolution · topo sort]
        DOCINGEST[Docs Ingest<br/>discover · classify · chunk]
        DOCNOTES[Doc Note Seeding<br/>README · architecture · ADR]
        LSP[LSP Enrichment<br/>hover · definition<br/>persisted metadata]
        COVER[Coverage Ingest<br/>LCOV · Cobertura]
        EMBED[Embedder<br/>sentence-transformers<br/>Python subprocess]
        GITHIST[Git History Ingest<br/>commits · diffs · refs]
    end

    subgraph SQLite KB
        FILES[(files)]
        SYM[(symbols · symbols_fts)]
        IMP[(file_imports · external_deps)]
        EXT[(external_symbols)]
        REFS[(symbol_refs)]
        DOCS[(docs · doc_sections)]
        NOTES[(notes)]
        COV[(coverage_runs · coverage_files<br/>coverage_lines)]
        VEC[(symbol_embeddings · symbol_semantic_embeddings<br/>doc_section_embeddings)]
        HIST[(commits · commit_files<br/>commit_refs)]
        META[(kb_meta · symbol_summaries)]
    end

    subgraph MCP Server
        LOOKUP[kb_lookup]
        SEARCH[kb_search<br/>BM25 · vector · fused]
        DOCS_TOOL[kb_docs]
        GRAPH[kb_graph]
        SNIPPET[kb_snippet]
        BLAME[kb_blame]
        HISTORY[kb_history]
        METRICS[kb_metrics]
        KB_COVERAGE[kb_coverage]
        WRITEBACK[kb_writeback]
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

    SRC --> WALK --> PARSE --> EXTRACT
    EXTRACT --> RESOLVE --> IMP
    RESOLVE --> DEPAPI --> EXT
    EXTRACT --> CALLGRAPH --> REFS
    EXTRACT --> LSP
    LSP --> SYM
    LSP --> REFS
    LSP --> EXT
    EXTRACT --> FILES & SYM
    DOCSRC --> DOCINGEST --> DOCS
    DOCINGEST --> DOCNOTES --> NOTES
    COVER --> COV
    COVREP --> COVER
    EMBED -.->|optional| VEC
    GIT --> GITHIST --> HIST

    FILES & SYM & IMP & EXT & REFS & DOCS & NOTES & COV & VEC & HIST & META --- LOOKUP & SEARCH & DOCS_TOOL & GRAPH & SNIPPET & BLAME & HISTORY & METRICS & KB_COVERAGE & WRITEBACK

    LOOKUP & SEARCH & DOCS_TOOL & GRAPH & SNIPPET & BLAME & HISTORY & METRICS & KB_COVERAGE & WRITEBACK <--> LLM_AGENTS

    LLM_AGENTS <--- ENTRY
```

## Indexer stages

| Stage | Module | What it does |
|-------|--------|--------------|
| Walk | `walker.ts` | Discovers source files via `fast-glob`, maps extensions to languages |
| Parse | `parser.ts` | Lazily creates one tree-sitter `Parser` per language, caches for reuse |
| Extract | `extractors/*` | Language-specific visitors that pull symbols, imports, and call refs from the AST |
| Resolve | `resolver.ts` | Classifies each raw import as internal (resolved to a file ID) or external (third-party / stdlib) |
| Dependency APIs | `index.ts` dependency API pass | Optional (`--index-deps`) declaration-only indexing from direct dependencies across npm (`.d.ts`), Python (`.pyi` / `py.typed`), Go (direct `go.mod` requirements), and Rust (direct `Cargo.toml` crates); excludes transitive dependencies and implementation bodies |
| Call-Graph | `call-graph.ts` | Matches raw callee names in `symbol_refs` to concrete symbol IDs; supports topo sort and cycle detection |
| Docs ingest | `docs.ts` + `IndexBuilder` | Discovers docs from default/configured globs, infers kind/title, persists docs plus retrievable sections/chunks, and optionally seeds doc-scoped notes |
| LSP Enrichment | `lsp/enrichment.ts` | Optional index-time language-server hover/definition lookups; persists resolved type signature/return/definition metadata into SQLite |
| Coverage | `coverage.ts` | Parses LCOV/Cobertura reports, normalizes per-file/per-line hit data, and persists a run linked to commit SHA/source mtime |
| Embed | `embedder.ts` | Optional — spawns a Python subprocess running sentence-transformers to produce dense vectors |
| Git History | `git-history.ts` | Ingests commits, per-file diffs, and branch/tag refs via `simple-git` |

Coverage ingestion accepts reports from auto-detected paths (`coverage/lcov.info`, `coverage/cobertura-coverage.xml`, `coverage.xml`) during build/update/refresh, plus manual CLI ingestion from an explicit `--file` and `--format`. LCOV/Cobertura inputs are normalized into a run (`coverage_runs`), per-file totals (`coverage_files`), and per-line hits (`coverage_lines`), which are then consumed by MCP coverage-aware tools.

Documentation ingestion runs during build and update. Defaults cover README variants, `docs/**`, ADR-style paths, and top-level architecture/design/guide/changelog files across `.md`, `.rst`, `.adoc`, and `.txt`. Markdown docs are chunked by heading hierarchy (stored with `heading_path`, line ranges, and content hashes in `doc_sections`), while non-Markdown files are stored as a single retrievable chunk.

When docs auto-notes are enabled (default), `IndexBuilder` seeds/updates notes for README, architecture, and ADR docs with deterministic keys and `doc:<path>@<branch>` scopes. Each seeded note writes `source_hash = docs.content_hash`, which allows staleness checks to tie note freshness directly to indexed doc content.

## SQLite schema groups

| Table group | Tables | Purpose |
|-------------|--------|---------|
| Files | `files` | Indexed source files with path, branch, language, hash |
| Symbols | `symbols`, `symbols_fts` | Named code symbols + FTS5 full-text index; includes optional persisted LSP enrichment (`resolved_type_signature`, `resolved_return_type`, `definition_uri`, `definition_path`) |
| Imports | `file_imports`, `external_deps` | Import declarations resolved to file IDs or external packages |
| Dependency APIs | `external_symbols` | Exported/public declarations from direct dependency APIs across npm, Python, Go, and Rust (ecosystem/source/package/version + symbol metadata), stored separately from in-repo symbols; includes optional persisted LSP enrichment metadata |
| Call refs | `symbol_refs` | Call-site edges from caller symbol to callee symbol, including optional persisted LSP enrichment metadata |
| Docs | `docs`, `doc_sections` | Indexed docs keyed by `(path, branch)` plus chunked sections with heading metadata |
| Notes | `notes` | User/system notes keyed by `(key, scope)`; doc-scoped notes use `source_hash` to track staleness against `docs.content_hash` |
| Coverage | `coverage_runs`, `coverage_files`, `coverage_lines` | Coverage ingestion run metadata plus normalized per-file and per-line hit data |
| Embeddings | `symbol_embeddings`, `symbol_semantic_embeddings`, `doc_section_embeddings` | vec0 virtual tables for semantic symbol/doc-section retrieval |
| History | `commits`, `commit_files`, `commit_refs` | Git commit metadata, touched files, and named refs |
| Metadata | `kb_meta`, `symbol_summaries`, `modules`, `file_modules` | Key-value config, LLM summaries, logical module groupings |

## MCP tools

| Tool | Purpose |
|------|---------|
| `kb_lookup` | Find symbols by name or files by path (optional branch filter), including external API symbol matches from `external_symbols` and persisted LSP-enrichment metadata when available |
| `kb_search` | Structural BM25, semantic vector, or fused RRF search; semantic/fused modes can return docs section hits and structural results are augmented by external symbol-name matches from `external_symbols`; returns persisted LSP-enrichment metadata fields when available |
| `kb_docs` | List indexed docs, fetch full docs with optional sections, or search indexed sections |
| `kb_graph` | Query call, import, module, or inheritance edges (`call` edges include `callee_coverage_percent`) |
| `kb_snippet` | Return source snippets by file path and line range |
| `kb_blame` | Query blame (`mode: "blame"`), line-range evolution (`mode: "history"`), or ownership aggregates (`mode: "ownership"`), including symbol-targeted range resolution |
| `kb_history` | Query history by file, commit, author, ref, or recency |
| `kb_metrics` | Return aggregate index metrics plus global coverage totals and staleness metadata (`coverage_commit`, `current_commit`, `commits_behind`, `stale`) |
| `kb_coverage` | Return symbol-level coverage, uncovered lines, and staleness metadata for the latest coverage run |
| `kb_notes_read` / `kb_notes_write` | Persist notes and read note freshness metadata (`source_hash_mismatch`, `doc_missing`, etc.) |
| `kb_writeback` | Persist symbol summaries into `symbol_summaries` |

`kb_blame` response enrichment:
- Supports legacy `line`/`start_line`/`end_line` requests and symbol-driven targeting (`symbol` + optional `path`/`branch`), returning `resolved_symbol` when symbol resolution is used.
- History and ownership modes include enriched commit context (`commits` and per-entry `commit_context`) with commit message details, touched files, and refs/tags.
- All modes return risk indicators derived from recency, author dispersion, and churn (`risk.recency`, `risk.author_dispersion`, `risk.churn`, `risk.overall`).

External symbol retrieval flow:
1. Dependency API indexing is opt-in and reads declaration surfaces from direct dependencies only:
   - npm: top-level `package.json` direct deps (`dependencies` / `devDependencies` / `peerDependencies`)
   - Python: direct requirements from project dependency manifests, indexed via `.pyi` / `py.typed` declaration sources
   - Go: direct `require` entries from root `go.mod`
   - Rust: direct dependency entries from root `Cargo.toml`
2. Exported dependency declarations are persisted to `external_symbols` with package/version metadata.
3. Transitive dependencies are excluded in all ecosystems; Lore indexes only the direct boundary.
4. MCP retrieval paths include `external_symbols` for symbol-facing queries so dependency APIs can be returned alongside in-repo symbols in `kb_lookup` and structural `kb_search`.

Query-time behavior:
- LSP servers are index-time only. MCP/KB query handlers do not spawn or call language servers.
- `kb_lookup` and `kb_search` read persisted enrichment fields directly from SQLite.
