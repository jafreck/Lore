# CLAUDE.md

## Project

Lore is a pre-release code-intelligence service. It stores recognized source
snapshots and SCIP/LSP-derived facts in SQLite, can add Git history and vector
embeddings, and serves the effective index through 11 MCP tools. It has no
tree-sitter extraction path, documentation corpus, dependency crawler, or
active complexity-metrics producer.

## Architecture invariants

- The active stage order is `ScipIndexerStage` → `FileDiscoveryStage` →
  `LspExtractionStage` → `ImportResolutionStage` →
  [`LspEnrichmentStage` + `git-history`] → `symbol-resolution` →
  `ReverseDepsStage` → `EmbeddingStage` → `FtsRefreshStage`.
- Baseline validation and generation promotion occur after the stage pipeline.
  Promotion is not an active pipeline stage.
- SCIP is the primary baseline structural source and does not run for overlay
  updates. LSP extracts changed-file overlays.
- Baseline LSP supplementation selects every non-SCIP-sourced file and
  SCIP-sourced C/C++ files with no symbols or repairable spans. It is bounded by
  `supplementation.maxFiles` and `fileConcurrency`; strict mode fails rather
  than truncating the plan.
- Schema v3 uses branch-scoped promoted generations, dirty-file selectors,
  persistent `effective_*` views, and connection-local staging views. Keep
  candidate generations hidden until validation succeeds.
- Public query paths use effective state. When overlays replace targets,
  reconcile stored file IDs and requeue symbol targets before resolution.
- Repository `.lore.config` values are requests, never execution authority.
  Host grants must remain separate and explicit.

## Change policy

Lore may make clean breaking changes before 1.0. Remove dead implementations
instead of maintaining parallel APIs, and prefer the smallest complete design.

The current schema contract is different from a compatibility shim: writable
opens must apply the declared ordered migrations `[1, 2, 3]`, both schema
markers must be present and agree, and read-only consumers must reject
incompatible databases.
Any schema change must deliberately update the version, migration sequence,
capability inspection, and tests. Do not remove required migration behavior
merely because the product is pre-release.

## Toolchain

Always use **Node.js 22**. Before `node`, `npx`, `npm`, or `vitest`, run
`nvm use 22`. The package requires native `better-sqlite3` and `sqlite-vec`
dependencies.

Build before using the CLI, and run compiled JavaScript rather than `tsx`:

```sh
npm run build
node dist/cli.js <command>
```

Run focused tests with:

```sh
npx vitest run <test-path>
```

Before finishing a change, run `npm run build`, `npm run typecheck`, and
`npm test` on Node 22.
