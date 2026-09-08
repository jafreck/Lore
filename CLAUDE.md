# CLAUDE.md

## What Lore Is

Lore is a code intelligence tool that enables AI agents and API consumers to understand large codebases with structured, pre-computed facts. It stores source snapshots and SCIP/LSP-derived symbols and relationships in SQLite, optionally adds Git history and embeddings, and exposes the result through MCP (Model Context Protocol).

### Core Value Proposition

- **Correctness**: Compiler-produced SCIP facts and persisted LSP metadata reduce reliance on name-only resolution; remaining heuristic edges retain their resolution method.
- **Scale**: The walker and LSP registry recognize 23 languages. Baseline structural coverage depends on an available SCIP index/indexer; changed-file overlays depend on an available language server.
- **Efficiency**: In the historical March 2026 six-repository/390-run snapshot, Lore improved overall correctness by 3.5 percentage points while using 31% fewer tokens; per-repository peaks were +7.5 points correctness, 48% fewer tokens, and 22% faster wall time. The current benchmark harness has since changed.

### How It Works

1. **Indexing**: `ScipIndexerStage` builds baseline symbols/imports/relationships/refs. `FileDiscoveryStage` stores recognized source snapshots. `LspExtractionStage` handles changed-file overlays, and LSP enrichment persists hover/definition metadata. There is no tree-sitter or documentation-indexing path.
2. **Storage**: Data is persisted to SQLite. Baseline and overlay rows coexist, with `dirty_files` and `effective_*` views selecting active rows where those views are used.
3. **Serving**: The MCP server registers 11 tools (`lore_lookup`, `lore_search`, `lore_graph`, `lore_trace`, `lore_dependents`, and related history/structure tools). `lore_metrics` exists as a module but is not registered.
4. **Optional data**: Git history ingestion stores commit metadata, touched-file stats, and refs only when requested. Embeddings cover symbol signature/type text and, with history enabled, commit messages.
5. **Freshness**: One-shot refresh, watch mode, poll mode, and Git hooks produce overlays; watch/poll can schedule a deferred full SCIP baseline reconciliation.

## Pre-Release Software

Lore is pre-release software. This means:

- **No backwards compatibility obligation.** Breaking changes to APIs, schemas, CLI flags, MCP tool signatures, or internal interfaces are expected and acceptable.
- **No legacy code retention.** Dead code, deprecated paths, compatibility shims, and migration layers should be removed rather than maintained. If something is superseded, delete the old version.
- **Prefer clean breaks over gradual migration.** When a better approach exists, adopt it fully rather than supporting both old and new patterns side by side.
- **Ship the simplest correct thing.** Don't over-engineer for hypothetical future compatibility — the interfaces will change again before 1.0.

## Node.js Version

Always use **Node.js 22** when running commands in the terminal. Before executing any `node`, `npx`, `npm`, or `vitest` command, ensure the active Node version is 22 (e.g. via `nvm use 22`). The project declares `>=22.0.0` in `package.json`, pins 22 in `.nvmrc`, and uses native dependencies including `better-sqlite3` and `sqlite-vec`. Tree-sitter is no longer a dependency and is not the reason for the pin.

## Running the CLI

Use the compiled JS build, not tsx:

```sh
node dist/cli.js <command>
```

## Running Tests

```sh
npx vitest run <test-path>
```
