# CLAUDE.md

## What Lore Is

Lore is a code intelligence tool that enables AI agents and API consumers to understand large codebases more correctly, at a wider scale, and with less context usage. It indexes source code, relationships, documentation, and git history into a structured SQL database exposed via MCP (Model Context Protocol), so agents can query precise, pre-computed knowledge instead of re-reading files from scratch.

### Core Value Proposition

- **Correctness**: Pre-resolved symbols, call graphs, type relationships, and import edges give agents accurate structural facts rather than heuristic guesses.
- **Scale**: Lore indexes entire repositories — across 23 languages — into a compact database that agents query surgically, avoiding full-file reads.
- **Efficiency**: Across 6 benchmark repos (390 runs), Lore-enabled agents achieve up to +10pp higher correctness, up to 84% fewer tokens, and up to 62% faster wall-clock time compared to grep + file-read baselines.

### How It Works

1. **Indexing**: A SCIP-first strategy (with tree-sitter fallback) extracts symbols, imports, call refs, type refs, annotations, and documentation from source files. Git history (commits, diffs, refs) is indexed alongside.
2. **Storage**: Everything is persisted to a normalized SQLite database with optional vector embeddings for semantic search.
3. **Serving**: An MCP server exposes the database through purpose-built tools (`lore_lookup`, `lore_search`, `lore_graph`, `lore_trace`, `lore_dependents`, etc.) that any MCP-compatible client can call.
4. **Freshness**: The index dynamically updates based on local changes via watch mode, poll mode, or git hooks — each refresh only re-processes files whose content hash has changed. A baseline index is built for every commit.

## Pre-Release Software

Lore is pre-release software. This means:

- **No backwards compatibility obligation.** Breaking changes to APIs, schemas, CLI flags, MCP tool signatures, or internal interfaces are expected and acceptable.
- **No legacy code retention.** Dead code, deprecated paths, compatibility shims, and migration layers should be removed rather than maintained. If something is superseded, delete the old version.
- **Prefer clean breaks over gradual migration.** When a better approach exists, adopt it fully rather than supporting both old and new patterns side by side.
- **Ship the simplest correct thing.** Don't over-engineer for hypothetical future compatibility — the interfaces will change again before 1.0.

## Node.js Version

Always use **Node.js 22** when running commands in the terminal. Before executing any `node`, `npx`, `npm`, or `vitest` command, ensure the active Node version is 22 (e.g. via `nvm use 22`). The project requires `>=22.0.0` as specified in `package.json` `engines` and `.nvmrc`. Do **not** use Node 25 or any other version — native add-ons (tree-sitter) are only built for Node 22.

## Running the CLI

Use the compiled JS build, not tsx:

```sh
node dist/cli.js <command>
```

## Running Tests

```sh
npx vitest run <test-path>
```
