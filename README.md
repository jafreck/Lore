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

## MCP Server

Lore ships with a built-in [Model Context Protocol](https://modelcontextprotocol.io)
server that lets any MCP-compatible client (Claude Desktop, VS Code Copilot,
Cadre, AAMF, etc.) query a Lore knowledge base.

### Start via CLI

```bash
# stdio transport (default — works with all MCP clients)
npx @jafreck/lore mcp --db ./kb.db
```

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
