<div align="center">

# Lore

[![CI](https://github.com/jafreck/Lore/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jafreck/Lore/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/jafreck/Lore/branch/main/graph/badge.svg)](https://codecov.io/gh/jafreck/Lore)
[![npm version](https://img.shields.io/npm/v/@jafreck/lore)](https://www.npmjs.com/package/@jafreck/lore)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0+-blue)](https://www.typescriptlang.org)

</div>

**Structured code intelligence for MCP agents.**

Lore stores recognized source snapshots and compiler/language-server facts in a
SQLite knowledge base. It resolves calls, type references, relationships, and
imports; can add Git history and vector embeddings; and exposes effective index
state through 11 MCP tools over stdio.

Lore is an index, not a compiler or source-search replacement. Structural facts
come from SCIP and LSP. There is no tree-sitter fallback, documentation corpus,
dependency-declaration crawler, or active complexity-metrics extractor. A file
can be snapshotted without receiving symbols when no usable structural provider
is available.

See [docs/architecture.md](docs/architecture.md) for internals and
[docs/execution-trust.md](docs/execution-trust.md) before enabling processes for
an untrusted checkout.

## Prerequisites and installation

- Node.js 22 or newer; the repository pins Node 22 in `.nvmrc`.
- A native C/C++ toolchain when prebuilt `better-sqlite3` or `sqlite-vec`
  binaries are unavailable.
- SCIP indexers and language servers for the languages that need structural
  coverage. Lore skips unavailable providers and records the result.

```bash
npm install @jafreck/lore
```

## Quick start

Provider requests default to enabled, but process execution defaults to denied.
The explicit subprocess grant below permits built-in SCIP indexers and language
servers; omit it when consuming only trusted precomputed SCIP data.

```bash
npx @jafreck/lore index \
  --root ./my-project \
  --db ./lore.db \
  --allow-subprocess-execution

npx @jafreck/lore doctor --db ./lore.db
npx @jafreck/lore mcp --db ./lore.db
```

For C/C++ projects, add `--allow-build-execution` only when Lore may run project
build configuration to create a missing compilation database.

## CLI

| Command | Required input | Purpose and key options |
|---|---|---|
| `lore index` | `--root <dir> --db <path>` | Build and promote a baseline. Supports walker, provider, history, embedding, validation, and execution options. |
| `lore refresh` | `--root <dir> --db <path>` | Hash effective snapshots and apply created/changed/deleted paths once, or run with `--watch` or `--poll`. |
| `lore mcp` | `--root <dir>` or `--db <path>` | Serve MCP over stdio. A root without a DB auto-indexes to `<root>/.lore/lore.db`; `--watch`/`--poll` require a root. |
| `lore doctor` | `--db <path>` | Read-only health, coverage, provenance, schema, and freshness report; `--json` is machine-readable. |
| `lore validate` | `--db <path>` | Alias for `lore doctor`. |
| `lore migrate` | `--db <path>` | Apply ordered schema migrations in place; `--json` reports the resulting schema. |
| `lore hooks` | `--root <dir> --db <path>` | Install refresh hooks for commit, merge, checkout, and rewrite events. |
| `lore analyze` | `--db <path>` | Emit graph analysis JSON; `--mode` selects `summary`, `cycles`, `components`, or `clusters`, and `--edge-kinds` selects `both`, `call`, or `type`. |
| `lore install-scip` | none | List with `--list` or install indexers, optionally filtered by repeatable `--language`. |

Important option groups:

- Walker: repeatable `--include`, `--exclude`, and `--language` on commands that
  expose source scope.
- Providers: `--lsp`/`--no-lsp` and `--scip`/`--no-scip` on `index`, `refresh`,
  and `hooks`. MCP auto-indexing resolves repository/default provider settings.
- Optional data: `--embeddings`, `--no-embeddings`, and `--embedding-model` on
  `index` and `refresh`; `--history`, `--history-depth`, and `--history-all`
  where accepted.
- Validation: `--validation-profile`, repeatable `--required`, count/rate
  thresholds, `--max-baseline-age-seconds`, and `--max-dirty-files` on
  `index`, `doctor`, and `validate` as defined by command scope.
- Execution: `--allow-subprocess-execution`, `--allow-build-execution`,
  `--allow-custom-indexer-commands`, `--allow-custom-lsp-commands`,
  `--allow-auto-install`, repeatable `--allow-command-cwd`, and repeatable
  `--allow-external-build-root`.
- Logging: every command accepts `--log-level` and `--log-file`.

The parser is strict and command-scoped. It rejects unknown options, positional
arguments, duplicate non-repeatable options, missing values, invalid choices or
numeric ranges, and conflicting pairs. `--watch` conflicts with `--poll`;
provider enable/disable pairs conflict; and embeddings cannot be disabled while
an embedding model is selected. Repeatability is allowed only where declared.

`--index-deps` and `--max-workers` are accepted on `index` (and
`--index-deps` on `refresh`), but neither activates a dependency crawler or
parse-worker pool. The only residual `--index-deps` behavior is to include
TypeScript when an active LSP-enrichment stage chooses which servers to start.

## Execution trust

`.lore.config` is repository-owned input. It may request provider settings,
timeouts, precomputed index locations, LSP supplementation, and validation, but
it cannot grant execution. Host authority comes only from CLI flags or the
programmatic `IndexBuilderOptions.execution` object.

- `--allow-subprocess-execution` permits built-in SCIP/LSP commands only.
- Custom SCIP and LSP registries need their matching custom-command grants.
- Build and automatic-install behavior need separate grants.
- `--allow-command-cwd` and `--allow-external-build-root` both add to the
  underlying host-approved root list; canonical paths and symlinks are checked.
- Executed SCIP indexers must write to a verified private temporary output.
- Precomputed SCIP files must remain in the checkout or one of those explicit
  host-approved roots after canonical path resolution.
- Existing compilation databases can be read without build permission, but
  every source and cwd must remain in the checkout or an approved external root.

Repository `false` values can narrow a host grant; repository `true` values
cannot widen it. Full capability implications and secure build/output rules are
in [docs/execution-trust.md](docs/execution-trust.md).

## Indexing model

The active order for build, reconciliation, and overlay runs is:

```
ScipIndexerStage → FileDiscoveryStage → LspExtractionStage
  → ImportResolutionStage → [LspEnrichmentStage + git-history]
  → symbol-resolution → ReverseDepsStage
  → EmbeddingStage → FtsRefreshStage
  → optional validation → baseline promotion
```

SCIP runs only for baseline layers. File discovery stores all remaining source
snapshots. LSP extracts changed-file overlays and also performs bounded baseline
supplementation for:

- every file not sourced by SCIP;
- SCIP-sourced C/C++ files with zero symbols; and
- SCIP-sourced C/C++ files with repairable spans.

Baseline supplementation defaults to 500 files and four concurrent file
requests. Reaching the cap records degradation; `supplementation.strict: true`
fails instead of truncating. LSP writes document symbols, outgoing calls, and
hover/definition metadata. SCIP remains authoritative for facts it supplied.

Baseline rows are built under a hidden, branch-scoped generation. Validation
runs against that candidate before one short fenced transaction advances the
promotion pointer, clears dirty overlays, publishes metadata, and finalizes the
run. Overlay updates use a single immediate transaction and generation `0`.
Persistent `effective_*` views select overlay rows for dirty paths and the
promoted baseline everywhere else. Target reconciliation remaps file imports and
re-resolves symbol IDs when an overlay replaces a file.

## Language coverage

Discovery and the default LSP registry recognize 23 languages:

> Bash, C, C++, C#, Elixir, Elm, Go, Haskell, Java, JavaScript, Julia,
> Kotlin, Lua, Objective-C, OCaml, PHP, Python, Ruby, Rust, Scala, Swift,
> TypeScript, and Zig.

The default SCIP registry contains TypeScript, Python, Java, Scala, Kotlin,
Rust, C, C++, C#, Ruby, PHP, Go, and Dart entries. Dart is not recognized by
the walker or default LSP registry. These lists describe discovery and registry
configuration, not guaranteed structural coverage: executable availability,
host grants, project configuration, and provider output determine actual facts.

Use `lore install-scip --list` to inspect installable indexers. Install required
language servers separately on `PATH`.

## Schema, migration, and validation

Lore writes SQLite schema v3. `lore_meta.schema_version` and SQLite
`user_version` must both be present and agree. Writable database opens apply the
ordered migration sequence `[1, 2, 3]`; a database claiming v3 with a missing or
disagreeing marker is rejected rather than silently repaired, and a database
marked newer than this build is rejected before mutation. Use the dedicated
command when migration should be the only action:

```bash
npx @jafreck/lore migrate --db ./lore.db
```

`lore doctor` and `lore validate` are read-only. They do not walk the checkout
or migrate the database. They report schema compatibility, file/symbol/edge and
import coverage, spans, duplicate effective rows, unresolved internal-looking
references, provider/compdb provenance, promoted generations, and overlay
freshness. An incompatible DB returns a structured `SCHEMA_MISSING`,
`SCHEMA_OUTDATED`, or `SCHEMA_NEWER` issue. MCP startup also requires an exactly
compatible schema.

```bash
npx @jafreck/lore doctor --db ./lore.db
npx @jafreck/lore doctor --db ./lore.db --json
npx @jafreck/lore doctor --db ./lore.db --root ./my-project \
  --validation-profile migration-grade \
  --include 'src/**' --exclude '**/*.generated.*' \
  --required 'src/core/**' --min-symbol-coverage 0.98
```

Validation profiles are cumulative:

- `standard` reports degradation and enforces explicit thresholds, required
  globs, and effective-path integrity.
- `strict` also requires structural symbols and valid spans, and rejects
  relevant failed, unavailable, or degraded provider/compdb attempts for the
  selected files.
- `migration-grade` additionally requires a completed successful baseline run
  aligned with the selected root, branch, promoted generation, and a successful
  SCIP or LSP provider for every selected language.

A `.lore.config` `validation` policy is enforced after the pipeline and before
baseline promotion. Failure preserves the prior promoted generation and leaves
the failed run/provider records available for diagnosis. The same report is
available through `validateIndex()` and `formatIndexHealthReport()`.

## Programmatic API

```ts
import { IndexBuilder } from '@jafreck/lore';

const builder = new IndexBuilder(
  './lore.db',
  {
    rootDir: './my-project',
    includeGlobs: ['src/**'],
    excludeGlobs: ['**/*.generated.ts'],
  },
  undefined,
  {
    scip: true,
    lsp: { supplementation: { maxFiles: 500, strict: true } },
    execution: { allowSubprocessExecution: true },
    validation: 'strict',
  },
);

await builder.build();
```

`IndexBuilder` construction stores arguments only. Repository configuration is
parsed by `resolveConfiguration()` or on first `build()`, `refresh()`, or
`baselineRebuild()` call.

| Member | Behavior |
|---|---|
| `resolveConfiguration()` | Merge defaults, repository requests, explicit provider settings, host grants, and validation without opening the DB |
| `build()` | Create and promote a complete hidden baseline generation |
| `update(changedFiles)` | Apply the supplied absolute paths as one overlay transaction |
| `refresh()` | Hash the configured scope, build if no baseline exists, otherwise update actual creations/changes/deletions; returns changed paths |
| `baselineRebuild()` | Reconcile overlays with a new full baseline generation |
| `validate(policy)` | Run the public read-only health report for this builder's DB |
| `lastValidationReport` | Return the report from the most recent policy-enforced run |
| `ingestSummary(symbolId, summary, model)` | Store a caller-generated symbol summary and optional summary vector |

`IndexBuilderOptions` includes `history`, `embeddings`, `embeddingModel`, `lsp`, `scip`,
host-owned `execution`, `signal`, `pipelineTimeoutMs`, `validation`, and
`responseFileLimits`. `indexDependencies` does not activate a dependency
crawler (apart from the TypeScript LSP-startup hint described above), and
`maxWorkers` has no active stage consumer. An explicit `EmbeddingProvider` can
be passed as the third constructor argument; `embeddings: false` suppresses
both that provider and persisted model reuse.

## MCP tools

The production registry contains exactly these tools:

| Tool | Purpose |
|---|---|
| `lore_lookup` | File lookup or exact, semantic, and fused symbol lookup with branch/name/kind/path/language filters |
| `lore_search` | Symbol-only FTS5 BM25, vector, or reciprocal-rank-fused retrieval |
| `lore_graph` | Stored call, import, inheritance, or type-dependency edges; anchored traversal follows at most five hops |
| `lore_snippet` | Persisted source lines for a required indexed path, using an optional range or unambiguous symbol in that file |
| `lore_blame` | Live Git blame, line history, or ownership, optionally targeted by an indexed symbol |
| `lore_history` | Indexed commits by file, SHA, author, ref, semantic message, or recency |
| `lore_trace` | Forward or point-to-point resolved call paths with stored-source snippets |
| `lore_diff` | Added, removed, and signature-changed exported symbols between indexed branches |
| `lore_cohesion` | Global directory cohesion and instability ranking |
| `lore_structure` | Directory import cycles, DFS back edges, and weak-link outliers |
| `lore_dependents` | Callers, importers, and subclasses up to five hops, plus direct type references, for a symbol or file |

Every result is serialized as JSON in one MCP text item. Object results receive
freshness metadata when possible: `source`, `baseline_age_s`, and
`dirty_file_count`.

Current limits:

- Tools query persisted effective rows; no query starts an LSP server.
- `lore_search` returns symbols only, not source-text or documentation hits.
- Semantic/fused lookup and search fall back to structural results when the
  model or compatible vectors are unavailable. Semantic history falls back to
  recent commits.
- `lore_history` needs history ingestion. `lore_blame` instead invokes Git
  against the live checkout and can differ from the stored snapshot.
- Exact lookup may read existing `external_symbols`, but indexing does not
  create them. `--index-deps` does not populate dependency APIs.
- `lore_metrics` is not registered, and indexing does not populate
  `symbol_metrics` or annotations.
- Graph traversal is capped at five hops and 1,000 total edges. Dependent
  traversal uses five hops and a 1,000-row query cap for each dependent
  category. Cohesion and structure inspect at most 10,000 relevant edges.
- Branch comparison requires both branches to have effective indexed data.
  `lore_diff` only compares symbols marked `is_exported = 1`; active SCIP and
  LSP ingestion do not currently populate that flag, so ordinary indexes can
  legitimately produce no diff rows unless export metadata was supplied by
  another producer.
- `lore_dependents` traverses callers, importers, and inheritance relationships
  up to five hops. Its `type_references` list contains only direct references to
  the target symbol (or symbols in the target file).

Example client configuration:

```json
{
  "mcpServers": {
    "lore": {
      "command": "npx",
      "args": ["@jafreck/lore", "mcp", "--db", "/path/to/lore.db"]
    }
  }
}
```

## Optional history and embeddings

Git history is disabled unless history options are supplied. Ingestion stores
commit metadata and parents, touched-file change statistics, and branch/tag
refs. It traverses all refs by default; `--history-depth <n>` caps the newest
commits and `--history-all` explicitly requests the default traversal.

For `lore index`, embeddings are disabled unless `--embeddings` or
`--embedding-model` is supplied; the default and explicit `--no-embeddings`
bypass any model persisted in an existing DB. `lore refresh` normally reuses a
persisted model so vectors stay current, while `--no-embeddings` suppresses
that reuse in one-shot, watch, and poll modes. Programmatic callers can use
`embeddings: false` for the same guarantee. The default model is
`onnx-community/Qwen3-Embedding-0.6B-ONNX`; Transformers.js runs it through ONNX
without Python, using CPU and `q8` by default. `LORE_EMBED_DEVICE` and
`LORE_EMBED_DTYPE` override those choices.

Lore embeds symbol signature/resolved-type text and, when history is enabled,
commit messages. Dimensions are detected and stored. Overlay updates hash
symbol embedding input and skip unchanged text. A different model or dimension
requires rebuilding into a new database. Query-time semantic modes degrade to
structural symbol search or recent commit history when vectors are unavailable.

## Keeping an index fresh

One-shot refresh hashes the configured walk against persisted effective
SHA-256 values and updates only creations, content changes, and deletions. If no
promoted baseline exists, it performs a full hidden-generation build first.

```bash
npx @jafreck/lore refresh --root ./my-project --db ./lore.db
npx @jafreck/lore refresh --root ./my-project --db ./lore.db --watch
npx @jafreck/lore refresh --root ./my-project --db ./lore.db --poll
npx @jafreck/lore hooks --root ./my-project --db ./lore.db
```

Watch mode batches filesystem events with a 300 ms debounce. Poll mode compares
mtimes every five seconds and prevents overlapping polls. Both run an initial
hash refresh, apply overlays with LSP when enabled and available, and—when SCIP
is enabled—schedule a full baseline reconciliation after ten quiet seconds.
Failed overlay batches and failed baseline reconciliations retain their
changed-path sets for a later retry.
Configured symbol embeddings are updated with each overlay.

The same repeatable include, exclude, and language scope is preserved across
one-shot refresh, watch, poll, and MCP live refresh. Git hooks preserve existing
non-Lore hook content, retain the selected `--history`, `--history-depth`, and
`--history-all` semantics, and invoke refresh after commit, merge, checkout,
and rewrite.

## Build, test, and contribute

Use Node 22 for every Node/npm/Vitest command:

```bash
nvm use 22
npm ci
npm run build
npm run typecheck
npm test
npm run coverage
```

Run the compiled CLI with `node dist/cli.js <command>`; do not use `tsx` as the
project CLI path. Keep changes focused, add behavior-level tests, and update the
README and [docs/architecture.md](docs/architecture.md) when public commands,
pipeline order, schema behavior, or MCP registration changes.

Contributions are licensed under [MIT](LICENSE).
