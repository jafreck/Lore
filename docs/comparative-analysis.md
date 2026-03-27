# Compiler-Derived Call Graphs vs. AST Heuristics

A comparative analysis of Lore's SCIP-based indexing against tree-sitter-only
approaches to code intelligence, using
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) as the
representative AST-only system.

## The Fundamental Difference

Both tools build knowledge graphs from source code and expose them via MCP.
The difference is *where symbol resolution happens*:

**Tree-sitter-only (codebase-memory-mcp):** Parse source → extract raw callee
name strings (`"http.Get"`, `"MyClass.myMethod"`) → resolve those strings
against a registry using name-matching heuristics (import map → same-module →
unique name → suffix match). For 3 of 64 supported languages (Go, C, C++), a
hand-rolled type inference engine adds higher-confidence resolution.

**SCIP-first (Lore):** SCIP indexers — which wrap real compilers
(`scip-typescript` uses the TypeScript compiler, `scip-java` uses
`javac`/`semanticdb`, `scip-go` uses `gopls`'s type checker) — produce
pre-resolved symbol references. Each SCIP occurrence carries the **exact
definition location** and a globally-unique symbol identifier. These references
arrive in Lore's database already resolved. Tree-sitter extraction is Lore's
*fallback* for languages without SCIP coverage, not the primary path.

## What SCIP Carries That Tree-Sitter Cannot

A tree-sitter `call_expression` node gives you a raw callee string, a line
number, and AST structure. A SCIP occurrence gives you:

| Data | Tree-sitter | SCIP |
|------|------------|------|
| Callee identity | Raw text string | Globally-unique symbol ID |
| Definition location | None — must be inferred | Exact file + line + character |
| Cross-package resolution | Requires heuristic matching | Direct (package prefix in symbol ID) |
| Overload disambiguation | Cannot distinguish | Disambiguator in symbol string (e.g., `(+1)`) |
| Generic/template instantiation | Not represented | Encoded in type parameters |
| Type signatures | Not available | Inline metadata from compiler |
| Symbol roles | Guessed from AST position | Bitmask (Definition, Reference, Import, Read, Write, Test) |
| Enclosing scope | Estimated from braces/indentation | Exact `enclosingRange` from compiler |

## Resolution Confidence

Lore tracks resolution confidence explicitly via a `resolution_method` column
on every reference edge. The methods are ordered from highest to lowest
confidence:

| Method | Source | Description |
|--------|--------|-------------|
| `scip_definition` | Compiler | SCIP provided exact target — zero ambiguity |
| `lsp_definition` | Language server | LSP returned definition location, mapped to narrowest enclosing symbol |
| `name_same_file` | Heuristic | Callee name matched exactly one symbol in the same file |
| `name_single_file` | Heuristic | Multiple candidates, but all in same target file (e.g., overloads) |
| `name_unique` | Heuristic | Name matched exactly one symbol globally (excluding macros/constants) |
| `external_definition` | — | Definition is outside the indexed file set (stdlib, third-party) |
| `ambiguous_definition` | — | Multiple equally-narrow containment candidates |
| `unresolved` | — | All strategies failed |

The first two tiers (`scip_definition`, `lsp_definition`) are
compiler/language-server derived. The remaining tiers are the same
name-matching heuristics that tree-sitter-only tools rely on *exclusively*.

A tree-sitter-only system's entire resolution pipeline for most languages
operates at Lore's lowest confidence tiers.

## Where Heuristic Resolution Breaks Down

### Overloaded methods

Java's `ObjectMapper` in jackson-databind has 12 `readValue` overloads.
Tree-sitter sees the string `"readValue"` and cannot determine which overload
is called. SCIP produces a distinct symbol ID for each overload based on the
compiler's overload resolution — the same resolution the JVM will use at
runtime.

### Cross-package calls

In Go, `parser.ParseJSON(...)` could refer to any `ParseJSON` in any package.
A tree-sitter extractor captures the string; a registry tries import-map
lookup (if the import is `import "parser"`, map `parser` → package path →
find `ParseJSON`). This works for simple cases but fails with: dot imports,
renamed imports, vendored paths, internal packages, and
build-tag-conditional imports. SCIP resolves through the Go type checker — it
knows exactly which package's `ParseJSON` is being called, including through
interface satisfaction and embedded structs.

### Generics and templates

`vector<string>::push_back()` in C++ — a tree-sitter extractor sees
`push_back` as a callee string. Resolving this correctly requires knowing the
template instantiation, which requires the C++ type system. The actual
compiler does this; a hand-rolled approximation covers some cases but cannot
handle template specialization, SFINAE, concept constraints, or dependent
types.

### Virtual dispatch and interface satisfaction

When Go code calls `writer.Write(data)`, whether `writer` is `*os.File`,
`*bytes.Buffer`, or `*http.Response` changes the call target. The Go type
checker infers the concrete type from context; a tree-sitter extractor sees
only the method name `Write`.

### Dynamic language patterns

Python's `getattr(obj, method_name)()`, JavaScript's `obj[key]()`, Ruby's
`send(:method_name)` — these are invisible to tree-sitter and cannot be
resolved by any static heuristic. SCIP indexers for these languages also
cannot resolve fully dynamic dispatch, but they resolve the static subset
(direct calls, imports, class hierarchies) that compilers can see.

## Pipeline Architecture Consequences

The choice of resolution strategy shapes the entire indexing pipeline:

**Tree-sitter-only (multi-pass):** Because tree-sitter doesn't resolve
references, each extraction concern requires its own pass over source files:
definitions first, then imports to build a lookup table, then calls resolved
against that table, then HTTP links, then config, then tests. This
necessitates holding source text in memory across passes — codebase-memory-mcp
uses LZ4 HC compression on in-memory source buffers and fused Aho-Corasick
pattern matching to pre-screen files before decompressing them for later passes.

**SCIP-first (single-pass extraction):** Lore parses each file once with
tree-sitter, extracts everything in a single AST walk (symbols, imports, call
refs, type refs, annotations), and persists to SQLite. SCIP-covered files
arrive with pre-resolved references that go directly into the database. All
downstream stages (import resolution, call-graph construction, LSP
enrichment, embedding) operate on database rows, not source text. No source
re-reading, no multi-pass, no in-memory compression needed.

| Concern | Tree-sitter-only | SCIP-first |
|---------|------------------|------------|
| Source reads per file | 6+ (one per pass) | 1 |
| In-memory source cache | Required (LZ4 compressed) | Optional (`sourceCache` for LSP positions) |
| Resolution data source | Name-matching against registry | Pre-resolved from compiler |
| Call graph construction | Registry lookup after all files extracted | Direct from SCIP symbol IDs |

## Benchmark Evidence

Lore's benchmark suite runs identical tasks against 6 real open-source
repositories (390 total runs, 5 iterations per task), comparing a Copilot
agent with Lore's MCP tools vs. the same agent with only grep + file-read:

| Metric | Without Lore | With Lore | Delta |
|--------|-------------|-----------|-------|
| Correctness | 87.3% | 90.8% | **+3.5pp** |
| Success rate | 89.2% | 94.9% | **+5.6pp** |
| First-pass accuracy | 0.0% | 40.0% | **+40.0pp** |
| Mean tool calls | 30.7 | 18.4 | **−40.2%** |
| Mean tokens | 8,952 | 6,182 | **−30.9%** |

Two repos reach statistical significance (p < 0.05):

**esbuild (Go/TypeScript, p = 0.012):** +7.0pp correctness, 41% fewer tool
calls, 34% fewer tokens. Tasks targeting `MakeLineColumnTracker` (15
cross-file callers) and `ParseJSON` (4 cross-package callers) — cross-package
call-graph queries where compiler resolution dominates name-matching.

**jackson-databind (Java, p = 0.038):** +7.5pp correctness, 100% success
rate (vs. 92.3%), 59% fewer tool calls, 47% fewer tokens. Java's deep
inheritance hierarchies and method overloading make heuristic resolution
especially fragile — the control agent spent nearly 68 tool calls per task
iterating through files, while Lore resolved call chains directly.

Across all 6 repos, Lore improves or ties on success rate in every case,
improves correctness in 5 of 6, and achieves first-pass accuracy (the agent
navigates to relevant code on its first action) that the control arm never
reaches (0% by definition, since grep opens a directory listing or
unrelated file first).

## The Tradeoff

Tree-sitter-only tools optimize for **speed and breadth**: fast indexing (Linux
kernel in 3 minutes), many languages (64), zero dependencies (single static
binary). The cost is resolution quality — for most languages, call edges are
best-effort name matches with no ground-truth validation.

SCIP-first tools optimize for **correctness and depth**: compiler-grade
resolution for covered languages, explicit confidence tracking, real benchmark
validation against ground truth with statistical significance testing. The
cost is speed (SCIP indexers invoke real compilers), language coverage (23
languages with tree-sitter extraction, subset with SCIP indexers), and setup
complexity (requires Node.js and optionally SCIP indexer binaries).

The call graph Lore produces is the one the compiler would agree with. That
agreement is measurable: +3.5pp correctness across 390 benchmark runs, with
the largest gains (+7.0–7.5pp) on exactly the cross-package and
inheritance-heavy codebases where heuristic resolution is weakest.
