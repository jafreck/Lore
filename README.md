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

### 1 — Index your codebase

```bash
# Index a TypeScript project (skipping tests and generated files)
npx @jafreck/lore index \
  --root ./my-project \
  --db ./my-project-kb.db \
  --language typescript \
  --exclude "**/node_modules/**" \
  --exclude "**/*.test.ts" \
  --exclude "**/dist/**"
```

### 2 — Query via MCP

Start the MCP server and point any MCP-compatible client at it:

```bash
npx @jafreck/lore mcp --db ./my-project-kb.db
```

Then configure your client (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "lore": {
      "command": "npx",
      "args": ["@jafreck/lore", "mcp", "--db", "/absolute/path/to/my-project-kb.db"]
    }
  }
}
```

Your AI assistant can now call `kb_search`, `kb_lookup`, `kb_graph`, and more against your live knowledge base.

### Programmatic API

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
| `--include <glob>` | *(none)* | Glob pattern of files to include (repeatable; e.g. `src/**/*.ts`) |
| `--exclude <glob>` | *(none)* | Glob pattern of files to exclude (repeatable; e.g. `**/node_modules/**`) |
| `--language <lang>` | *(none)* | Restrict indexing to a language (repeatable; e.g. `typescript`, `rust`) |

**Example**

```bash
npx @jafreck/lore index --root ./my-project --db ./kb.db
# with a custom embedding model:
npx @jafreck/lore index --root ./my-project --db ./kb.db --embedding-model sentence-transformers/all-MiniLM-L6-v2
# index only TypeScript and Python source files, skipping tests:
npx @jafreck/lore index --root ./my-project --db ./kb.db \
  --language typescript --language python \
  --include "src/**" --exclude "**/*.test.ts"
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

### Programmatic usage

```ts
import { createKbMcpServer, openReadOnly } from "@jafreck/lore";

const db = openReadOnly("/path/to/kb.db");
const server = createKbMcpServer(db, "/path/to/kb.db");
// Connect to your preferred transport...
```

## Build from source

```bash
git clone https://github.com/jafreck/Lore.git
cd Lore
npm install
npm run build
```

## License

[MIT](LICENSE)
