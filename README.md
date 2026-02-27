# Lore

**The teammate who's read every commit.** Lore is your codebase's institutional memory — it knows what was built, why it changed, and how it all connects.

Language-aware codebase indexer — tree-sitter parsing, symbol extraction,
call-graph construction, and optional embeddings for semantic search.

Lore is designed to be consumed by agent orchestration frameworks (e.g. AAMF,
Cadre) that need a structured knowledge base of a source repository.

## Features

- **Source-tree walking** with language detection and configurable ignore patterns
- **Tree-sitter parsing** with extractors for C, C++, C#, Go, Java, JavaScript, Python, Rust, and TypeScript
- **Symbol extraction** — functions, classes, methods, interfaces, enums, type aliases, and more
- **Import resolution** and **call-graph construction** across files
- **SQLite persistence** with a normalised schema for symbols, references, and files
- **Optional embedding pipeline** for semantic search via `sqlite-vec`
- **Built-in MCP server** — expose the knowledge base to any MCP-compatible AI agent or IDE

## Install

```bash
npm install @jafreck/lore
```

> **Note:** Lore uses native add-ons (`tree-sitter`, `better-sqlite3`). A
> working C/C++ toolchain is required on first install.

## Quick start

```ts
import { runKbIndex } from "@jafreck/lore";

await runKbIndex({
  rootDir: "/path/to/source",
  dbPath: "/path/to/kb.db",
  languages: ["c", "rust"],
  embeddings: { enabled: false },
});
```

## CLI

### `lore index` — build or update the knowledge base

```bash
npx @jafreck/lore index --root <dir> --db <path> [--embedding-model <id>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--root <dir>` | *(required)* | Root directory of the source tree to index |
| `--db <path>` | *(required)* | Path to the SQLite knowledge-base file (created if absent) |
| `--embedding-model <id>` | `Qwen/Qwen3-Embedding-4B` | Hugging Face model ID used to generate embeddings for semantic search |

**Example**

```bash
npx @jafreck/lore index --root ./my-project --db ./kb.db
# or with a custom embedding model:
npx @jafreck/lore index --root ./my-project --db ./kb.db --embedding-model sentence-transformers/all-MiniLM-L6-v2
```

## MCP Server

Lore ships with a built-in [Model Context Protocol](https://modelcontextprotocol.io)
server that lets any MCP-compatible client (Claude Desktop, VS Code Copilot,
Cadre, AAMF, etc.) query a Lore knowledge base.

### Start via CLI

```bash
# stdio transport (default — works with all MCP clients)
npx @jafreck/lore mcp --db ./kb.db
```

> **Note:** If the embedding model fails to initialise at startup (e.g. the
> model weights are unavailable), semantic search is silently disabled and the
> MCP server continues to start normally. Structural (`bm25`) search remains
> fully functional.

### MCP client configuration

Add to your MCP config (Claude Desktop, VS Code, etc.):

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

### Available tools

| Tool | Description |
|------|-------------|
| `kb_lookup` | Look up symbols by name or files by path |
| `kb_search` | BM25 structural, semantic (cosine), or fused (RRF) search |
| `kb_graph` | Query call-graph or import-graph edges |
| `kb_snippet` | Extract source-code snippets by file and line range |
| `kb_metrics` | Aggregate codebase metrics (symbol/file/import counts) |
| `kb_writeback` | Persist LLM-generated symbol summaries back to the KB |
| `kb_history` | Query git commit history by file, SHA, author, or recency |

## Commit History Indexing

Lore can ingest your repository's git commit history and expose it through the `kb_history` MCP tool.

### Enabling history ingestion

Pass `history: true` (or a config object) to `IndexBuilder`:

```ts
import { IndexBuilder } from "@jafreck/lore";

// Enable with defaults (depth: 500)
await new IndexBuilder("/path/to/kb.db", { rootDir: "/path/to/source" }, undefined, {
  history: true,
}).build();

// Or configure a custom depth
await new IndexBuilder("/path/to/kb.db", { rootDir: "/path/to/source" }, undefined, {
  history: { depth: 200 },
}).build();
```

### What is stored

- **`commits` table** — sha, author, author_email, timestamp, message, parents (JSON array of parent SHAs)
- **`commit_files` table** — commit_sha, file_path, change_type (A/M/D/R), and diff stats (insertions/deletions) when available

### Querying with `kb_history`

The `kb_history` tool supports four query modes:

| Mode | Required `query` | Description |
|------|-----------------|-------------|
| `file` | file path | All commits that touched the given file |
| `commit` | full or partial SHA | Look up a specific commit with its file list |
| `author` | name or email substring | All commits by the matching author |
| `recent` | — | Most recent commits |

All modes accept an optional `limit` (default 20, max 200).

**Example invocations:**

```json
// Most recent commits
{ "mode": "recent", "limit": 10 }

// Commits that touched a file
{ "mode": "file", "query": "src/indexer/db.ts" }

// Look up a commit by SHA prefix
{ "mode": "commit", "query": "a1b2c3d" }

// Commits by an author
{ "mode": "author", "query": "alice@example.com" }
```

### Programmatic usage

```ts
import { createKbMcpServer, openReadOnly } from "@jafreck/lore";

const db = openReadOnly("/path/to/kb.db");
const server = createKbMcpServer(db, "/path/to/kb.db");
// Connect to your preferred transport...
```

## Index Refresh

Lore supports three modes for keeping the index up to date after an initial build:

### Manual refresh (recommended for CI/scripted use)

Performs an incremental update over all files in the root directory and exits.
This is the safest option because it is idempotent and has no long-running process to manage.

```bash
npx @jafreck/lore refresh --db ./kb.db --root ./src
```

### Watch mode

Uses native filesystem events (`fs.watch`) to detect file changes and trigger
incremental updates automatically. Watch mode is **low-latency** — changes are
picked up within milliseconds — but may **miss events** on network file systems,
some Linux configurations, or WSL2 environments where kernel inotify limits apply.

```bash
npx @jafreck/lore refresh --db ./kb.db --root ./src --watch
```

### Poll mode

Periodically walks the directory tree, compares file modification times against
a snapshot, and triggers an incremental update for any files that changed.
Poll mode is **reliable** on all platforms and file systems, but incurs a
**higher CPU and I/O cost** proportional to the size of the tree and the polling
interval (default: 5 s).

```bash
npx @jafreck/lore refresh --db ./kb.db --root ./src --poll
```

| Mode | Latency | Reliability | Cost |
|------|---------|-------------|------|
| Manual | on-demand | highest | none (run once) |
| `--watch` | low (~ms) | platform-dependent | minimal |
| `--poll` | ~interval | highest | moderate (CPU/IO) |

## Build from source

```bash
git clone https://github.com/jafreck/Lore.git
cd Lore
npm install
npm run build
```

## Contributing

### Setup

```bash
git clone https://github.com/jafreck/Lore.git
cd Lore
npm install
```

### Build

```bash
npm run build
```

### Tests

```bash
npm test
```

### Coverage

```bash
npm run coverage
```

CI enforces a minimum of **95% code coverage**. Pull requests that drop coverage below this threshold will fail the CI check.

## License

[MIT](LICENSE)
