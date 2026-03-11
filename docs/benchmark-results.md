# Benchmark Results: Lore vs Baseline

**Date:** 2026-03-11
**Model:** claude-sonnet-4.6 (via GitHub Copilot CLI)
**Target repo:** lore-self @ `660be2bf`

## Aggregate Summary

| Metric | Control | Lore-enabled | Delta |
|---|---|---|---|
| **Success rate** | 58.3% | 66.7% | **+8.3pp** |
| **Mean correctness** | 82.1% | 84.2% | **+2.1pp** |
| **First-pass accuracy** | 25.0% | 58.3% | **+33.3pp** |
| **Mean tool calls** | 16.0 | 6.1 | **-9.9 (-62%)** |
| **Mean tokens** | 3,448 | 846 | **-2,601 (-75.5%)** |
| **Mean wall time** | 69.9s | 28.0s | **-41.9s (-59.9%)** |
| **Answer coverage** | 93.8% | 95.8% | +2.1pp |
| **File coverage** | 75.0% | 66.7% | -8.3pp |
| **Symbol coverage** | 73.6% | 73.6% | 0.0pp |
| **Lore tool usage** | 0% of runs | 100% of runs | — |
| **Total benchmark wall time** | — | — | 3.7 minutes (concurrent) |

## Per-Task Detail

| Task | Prompt | Ctrl Correct | Lore Correct | Correct Δ | Ctrl Tokens | Lore Tokens | Token Δ | Ctrl Wall | Lore Wall | Wall Δ | Ctrl Tools | Lore Tools |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **1.1** | Callers of `openDb` | 0.80 | **1.00** | **+0.20** | 6,192 | 266 | **-96%** | 117.5s | 18.0s | **-85%** | bash×11, view×9, grep×3 | lore_lookup×1, lore_graph×1 |
| **1.2** | Callees of `build` | 0.80 | **1.00** | **+0.20** | 766 | 418 | **-45%** | 26.3s | 20.8s | -21% | grep×2, view×2 | lore_lookup×2, lore_graph×1 |
| **1.4** | Blast radius of `resolveSymbolEdges` (3-hop) | 0.75 | 0.75 | 0.00 | 7,059 | 2,300 | **-67%** | 180.0s | 50.0s | **-72%** | bash×15, view×14, grep×4 | lore_lookup×9, bash×6, lore_graph×1 |
| **2.1** | Implementations of `SymbolExtractor` | 1.00 | 1.00 | 0.00 | 280 | 418 | +49% | 14.0s | 17.8s | +27% | grep×1 | lore_graph×2, lore_lookup×1 |
| **4.1** | Test files for `parser.ts` | 1.00 | 1.00 | 0.00 | 6,064 | 1,086 | **-82%** | 94.0s | 34.5s | **-63%** | view×10, bash×9, grep×4 | grep×3, lore_test_map×1 |
| **6.1** | Top 5 by cyclomatic complexity | 0.50 | 0.50 | 0.00 | 2,017 | 168 | **-92%** | 50.5s | 13.6s | **-73%** | bash×5 | lore_metrics×1 |
| **7.2** | Functions/classes related to `embedding` | **1.00** | 0.86 | -0.14 | 683 | 1,562 | +129% | 25.7s | 38.9s | +51% | bash×2, grep×1 | bash×5, lore_search×2, lore_lookup×1 |
| **8.1** | Circular import dependencies | 1.00 | 1.00 | 0.00 | 885 | 614 | -31% | 73.5s | 22.6s | **-69%** | bash×3 | lore_graph×1, bash×1 |
| **3.3** | Module dependency summary | 0.00 | 0.00 | 0.00 | 10,003 | 1,106 | **-89%** | 107.7s | 31.8s | **-70%** | view×26, bash×18 | lore_architecture×1, lore_docs×1, view×1, bash×1 |
| **10.2** | Symbols defined in `call-graph.ts` | 1.00 | 1.00 | 0.00 | 302 | 473 | +57% | 17.4s | 21.6s | +24% | view×1 | lore_lookup×1, lore_search×1, view×1 |
| **11.1** | Tests + coverage + reviewer for `resolveSymbolEdges` | 1.00 | 1.00 | 0.00 | 6,018 | 1,024 | **-83%** | 98.5s | 31.3s | **-68%** | bash×17, view×6, glob×4 | lore_coverage×2, bash×2, lore_test_map×1, lore_blame×1, lore_lookup×1 |
| **11.4** | Deletion impact of `walker.ts` | 1.00 | 1.00 | 0.00 | 1,101 | 720 | -35% | 33.3s | 35.0s | +5% | grep×5 | grep×4, lore_lookup×1 |

### Lore Index Configuration

| Setting | Value |
|---|---|
| Index mode | SCIP (primary) + tree-sitter (fallback + metrics) |
| SCIP indexer | scip-typescript (auto-detected) |
| Embedding model | None (embeddings disabled for benchmark) |
| LSP enrichment | Disabled |
| History depth | 100 commits |
| Docs auto-notes | Enabled |
| Index dependencies | Disabled |
| Index time | ~3,400 ms |

### Copilot CLI Configuration

| Setting | Value |
|---|---|
| `BENCHMARK_COPILOT` | `1` |
| `BENCHMARK_REPO` | `lore-self` |
| `BENCHMARK_MODEL` | `claude-sonnet-4.6` |
| `BENCHMARK_INDEX_MODE` | `scip` |
| Per-task timeout | 180 s |
| Control arm | Copilot CLI with `--deny-tool` for all `lore_*` tools |
| Lore-enabled arm | Copilot CLI with Lore MCP server (`--additional-mcp-config`) |
| Concurrency | All 12 tasks run concurrently; control + lore arms run in parallel per task |

---

## Per-Task Narrative

### Q1.1 — Call Graph: Callers

> What functions or methods directly call `openDb`? Answer with ONLY a newline-separated list of function/method names, nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 0.80 | **1.00** | **+0.20** |
| Tokens | 6,192 | 266 | **-96%** |
| Wall time | 117.5s | 18.0s | **-85%** |
| Tool calls | 24 (bash×11, view×9, grep×3, report_intent×1) | 3 (report_intent×1, lore_lookup×1, lore_graph×1) | -87% |

Lore calls: `lore_lookup(kind=symbol, query=openDb)`, `lore_graph(kind=call, target_id=400)`

---

### Q1.2 — Call Graph: Callees

> What does the function/method `build` call? Answer with ONLY a newline-separated list of the direct callee function/method names, nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 0.80 | **1.00** | **+0.20** |
| Tokens | 766 | 418 | **-45%** |
| Wall time | 26.3s | 20.8s | -21% |
| Tool calls | 6 (grep×2, view×2, report_intent×1) | 4 (lore_lookup×2, report_intent×1, lore_graph×1) | -33% |

Lore calls: `lore_lookup(kind=symbol, query=build, symbol_kind=function)`, `lore_lookup(kind=symbol, query=build)`, `lore_graph(kind=call, source_id=1830, compact=true)`

---

### Q1.4 — Call Graph: Blast Radius (Transitive)

> If I change the function `resolveSymbolEdges` in `src/resolution/call-graph.ts`, what is the blast radius? Use transitive dependency analysis if available (follow callers of callers, up to 3 hops). Answer with ONLY a newline-separated list of files and functions that transitively depend on it, nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 0.75 | 0.75 | 0.00 |
| Tokens | 7,059 | 2,300 | **-67%** |
| Wall time | 180.0s | 50.0s | **-72%** |
| Tool calls | 34 (bash×15, view×14, grep×4, report_intent×1) | 17 (lore_lookup×9, bash×6, report_intent×1, lore_graph×1) | -50% |

Lore calls: `lore_graph(kind=call, target_id=428, depth=3, compact=true)`, followed by `lore_lookup` calls to resolve symbol details. **Agent used `depth=3` for transitive closure in a single graph query.**

---

### Q2.1 — Inheritance: Interface Implementations

> What classes or types implement the interface `SymbolExtractor`? Answer with ONLY a newline-separated list of class/type names, nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 1.00 | 1.00 | 0.00 |
| Tokens | 280 | 418 | +49% |
| Wall time | 14.0s | 17.8s | +27% |
| Tool calls | 2 (report_intent×1, grep×1) | 4 (lore_graph×2, report_intent×1, lore_lookup×1) | +100% |

Lore calls: `lore_lookup(kind=symbol, query=SymbolExtractor)`, `lore_graph(kind=inheritance)`, `lore_graph(kind=inheritance, target_id=940)`. Both arms found all 23 implementations. Control's single `grep` for `implements SymbolExtractor` was faster for this pattern.

---

### Q4.1 — Test Mapping

> What test files should I run after modifying `src/parsing/parser.ts`? Answer with ONLY a newline-separated list of test file paths relative to the repo root, nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 1.00 | 1.00 | 0.00 |
| Tokens | 6,064 | 1,086 | **-82%** |
| Wall time | 94.0s | 34.5s | **-63%** |
| Tool calls | 26 (view×10, bash×9, grep×4, report_intent×1, glob×1, task×1) | 7 (grep×3, report_intent×1, lore_test_map×1, glob×1) | -73% |

Lore calls: `lore_test_map(source_path=src/parsing/parser.ts)`. Single pre-indexed lookup vs 26-call grep search.

---

### Q6.1 — Complexity Ranking

> What are the 5 most complex functions in this codebase, ranked by cyclomatic complexity? Use pre-indexed complexity metrics if available rather than scanning source files. Answer with ONLY a numbered list of function names, one per line, in descending order.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 0.50 | 0.50 | 0.00 |
| Tokens | 2,017 | 168 | **-92%** |
| Wall time | 50.5s | 13.6s | **-73%** |
| Tool calls | 8 (bash×5, report_intent×1, glob×1) | 2 (report_intent×1, lore_metrics×1) | -75% |

Lore calls: `lore_metrics(limit=5)`. Single call to pre-indexed `symbol_metrics` table vs bash-based scanning. Both arms achieved 0.50 correctness (partial match against expected top-5).

---

### Q7.2 — Symbol Search by Concept

> Find all functions and classes related to `embedding` in this codebase. Answer with ONLY a newline-separated list of symbol names, nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 1.00 | 0.86 | -0.14 |
| Tokens | 683 | 1,562 | +129% |
| Wall time | 25.7s | 38.9s | +51% |
| Tool calls | 4 (bash×2, report_intent×1, grep×1) | 10 (bash×5, lore_search×2, report_intent×1, lore_lookup×1, grep×1) | +150% |

Lore calls: `lore_search(query=embedding, mode=structural)` ×2, `lore_lookup(kind=symbol)`. Control's `grep -r embedding` was faster and found more results by matching file paths. Lore's FTS5 search matches on symbol names/signatures only, missing symbols where "embedding" only appears in the file path.

---

### Q8.1 — Graph Analysis: Circular Dependencies

> Are there any circular dependencies (import cycles) between source files in this codebase? Answer with ONLY a list of the cycle(s), or "None" if the codebase is acyclic.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 1.00 | 1.00 | 0.00 |
| Tokens | 885 | 614 | -31% |
| Wall time | 73.5s | 22.6s | **-69%** |
| Tool calls | 6 (bash×3, report_intent×1, write_bash×1, read_bash×1) | 3 (report_intent×1, lore_graph×1, bash×1) | -50% |

Lore calls: `lore_graph(kind=import, limit=500, compact=true)`. Both correctly answered "None". Control needed a multi-step bash script to walk imports; Lore queried the pre-indexed import graph in one call.

---

### Q3.3 — Module Dependency Summary

> What are the top-level modules/components and how do they depend on each other? Answer with a brief list of each module and its direct dependencies.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 0.00 | 0.00 | 0.00 |
| Tokens | 10,003 | 1,106 | **-89%** |
| Wall time | 107.7s | 31.8s | **-70%** |
| Tool calls | 46 (view×26, bash×18, report_intent×1, task×1) | 5 (report_intent×1, lore_architecture×1, lore_docs×1, view×1, bash×1) | -89% |

Lore calls: `lore_architecture()`, `lore_docs(action=get, path=docs/architecture.md)`. Both arms correctly identified all modules and dependencies. Exact-match correctness is 0.00 because the expected answer format (`module → deps`) is too rigid — both gave correct but differently-formatted answers.

---

### Q10.2 — File Symbol Listing

> What functions, classes, and interfaces are defined in `src/resolution/call-graph.ts`? Answer with ONLY a newline-separated list in the format "name (kind)", nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 1.00 | 1.00 | 0.00 |
| Tokens | 302 | 473 | +57% |
| Wall time | 17.4s | 21.6s | +24% |
| Tool calls | 2 (report_intent×1, view×1) | 4 (report_intent×1, lore_lookup×1, lore_search×1, view×1) | +100% |

Lore calls: `lore_lookup(kind=symbol, path_prefix=src/resolution/call-graph.ts)`, `lore_search(query=call-graph)`. Control's single `view` of the file was simpler and faster for this task.

---

### Q11.1 — Composite: Modify Workflow

> I need to modify `resolveSymbolEdges` in `src/resolution/call-graph.ts`. What test files should I run, what is the coverage of those test paths, and who should review the change? Answer with ONLY three lines: 1. Test files (comma-separated paths) 2. Coverage percentage 3. Reviewer name

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 1.00 | 1.00 | 0.00 |
| Tokens | 6,018 | 1,024 | **-83%** |
| Wall time | 98.5s | 31.3s | **-68%** |
| Tool calls | 30 (bash×17, view×6, glob×4, report_intent×1, grep×1, task×1) | 10 (lore_coverage×2, bash×2, report_intent×1, lore_test_map×1, lore_blame×1, lore_lookup×1, glob×1) | -67% |

Lore calls: `lore_test_map(source_path=src/resolution/call-graph.ts)`, `lore_coverage(symbol_name=resolveSymbolEdges)`, `lore_blame(symbol=resolveSymbolEdges, mode=ownership)`, `lore_lookup(kind=symbol, query=resolveSymbolEdges)`, `lore_coverage(path=src/resolution/call-graph.ts)`. All three sub-questions answered correctly by chaining Lore tools.

---

### Q11.4 — Deletion Impact

> What would break if I deleted `src/discovery/walker.ts`? Answer with ONLY a newline-separated list of file paths that directly import or depend on it, nothing else.

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Correctness | 1.00 | 1.00 | 0.00 |
| Tokens | 1,101 | 720 | -35% |
| Wall time | 33.3s | 35.0s | +5% |
| Tool calls | 6 (grep×5, report_intent×1) | 6 (grep×4, report_intent×1, lore_lookup×1) | 0% |

Lore calls: `lore_lookup(kind=file, query=src/discovery/walker.ts)`. Both found the same set of dependent files. Lore scored higher on task success (1.0 vs 0.5) due to better file coverage in the structured answer.
