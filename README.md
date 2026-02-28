# Lore

The teammate who has read your codebase and git history.

Lore indexes source code into a SQLite knowledge base with symbols, imports,
call relationships, summaries, and git history. It also ships an MCP server so
agents and IDEs can query that knowledge base directly.

## What Lore does

- Parses source files with tree-sitter and extracts symbols/imports/call refs
- Resolves internal vs external imports and builds call/import graph edges
- Stores everything in a normalized SQLite schema with optional vector search
- Indexes git history (commits, touched files, refs/branches/tags)
- Supports line-level git blame through MCP (`kb_blame`)
- Supports automatic refresh via watch mode, poll mode, and git hooks

## Supported languages

Lore currently supports extractors for:

- C, C++, C#
- Rust, Go, Java, Kotlin, Scala, Swift, Objective-C, Zig, Dart
- Python, JavaScript, TypeScript, PHP, Ruby, Lua, Bash, Elixir
- OCaml, Haskell, Julia, Elm

## Install

```bash
npm install @jafreck/lore
```

Note: Lore uses native add-ons (`tree-sitter`, `better-sqlite3`). A working
C/C++ toolchain is required the first time dependencies are built.

## Quick start (CLI)

```bash
# 1) Build an index
npx @jafreck/lore index --root ./my-project --db ./kb.db

# 2) Start MCP server over stdio
npx @jafreck/lore mcp --db ./kb.db
```

## Quick start (programmatic)

```ts
import { IndexBuilder } from '@jafreck/lore';

const builder = new IndexBuilder(
  './kb.db',
  { rootDir: './my-project' },
  undefined,
  { history: true },
);

await builder.build();
```

## CLI reference

### lore index

Build or update a knowledge base.

```bash
npx @jafreck/lore index --root <dir> --db <path> [--embedding-model <id>] [--history] [--history-depth <n>] [--history-all] [--include <glob>] [--exclude <glob>] [--language <lang>]
```

Key flags:

- `--root <dir>` required source root
- `--db <path>` required SQLite output path
- `--embedding-model <id>` embedding model identifier
- `--history` enable git history ingestion
- `--history-depth <n>` cap number of ingested commits
- `--history-all` traverse all refs (branches/tags)
- `--include` repeatable glob include filter
- `--exclude` repeatable glob exclude filter
- `--language` repeatable language filter (mapped to extensions)

### lore refresh

Incremental refresh flow for an existing index.

```bash
npx @jafreck/lore refresh --db <path> --root <dir> [--history] [--history-depth <n>] [--history-all]
npx @jafreck/lore refresh --db <path> --root <dir> --watch [--history]
npx @jafreck/lore refresh --db <path> --root <dir> --poll [--history]
```

Modes:

- Manual: one-shot incremental refresh and exit
- Watch: filesystem event driven (`fs.watch`), low latency
- Poll: periodic mtime diffing, most reliable across filesystems

### lore hooks

Install repo-local git hooks that trigger Lore refresh automatically on:

- `post-commit`
- `post-merge`
- `post-checkout`
- `post-rewrite`

```bash
npx @jafreck/lore hooks --root <repo> --db <path>
npx @jafreck/lore hooks --root <repo> --db <path> --history
```

Note: for `lore hooks`, any history-related flag currently enables history in
hook-triggered refreshes.

### lore mcp

Start the built-in MCP server over stdio.

```bash
npx @jafreck/lore mcp --db <path>
```

If the embedding model cannot initialize at runtime, semantic/fused search
gracefully degrades to structural search.

## MCP tools

| Tool | Purpose |
|------|---------|
| `kb_lookup` | Find symbols by name or files by path (optional branch filter) |
| `kb_search` | Structural BM25, semantic vector, or fused RRF search |
| `kb_graph` | Query call or import edges (optional source/branch filters) |
| `kb_snippet` | Return source snippets by file path and line range |
| `kb_blame` | Return git blame metadata for a line or line range |
| `kb_metrics` | Return aggregate index metrics and per-branch breakdown |
| `kb_writeback` | Persist symbol summaries into `symbol_summaries` |
| `kb_history` | Query history by file, commit, author, ref, or recency |

### MCP config example

```json
{
  "mcpServers": {
    "lore": {
      "command": "npx",
      "args": ["@jafreck/lore", "mcp", "--db", "/path/to/kb.db"]
    }
  }
}
```

## Git history indexing

Lore can ingest full git history and expose it through `kb_history`.

### Indexed history tables

- `commits`: sha, author, author_email, timestamp, message, parents
- `commit_files`: per-commit touched paths with change type and diff stats
- `commit_refs`: refs currently pointing at commits (`branch`/`tag`/`other`)

### kb_history modes

- `recent`: newest commits
- `file`: commits that touched a path
- `commit`: full/prefix sha lookup (+files +refs)
- `author`: commits by author/email substring
- `ref`: commits matching branch/tag ref name substring

## Blame queries

Use `kb_blame` for line-level attribution.

Examples:

```json
{ "path": "/repo/src/index.ts", "line": 120 }
{ "path": "/repo/src/index.ts", "start_line": 120, "end_line": 140 }
{ "path": "/repo/src/index.ts", "line": 120, "ref": "main" }
```

## Automatic freshness patterns

If you want Lore to stay updated without explicit requests:

1. Run `lore hooks` once in the repo (git lifecycle updates)
2. Optionally run `lore refresh --watch` in a background session for near-real-time updates during active editing
3. Use `--poll` on filesystems where watch events are unreliable

## Build from source

```bash
git clone https://github.com/jafreck/Lore.git
cd Lore
npm install
npm run build
```

## Contributing

```bash
npm test
npm run coverage
```

CI enforces a minimum 95% coverage threshold.

## License

[MIT](LICENSE)
