# Benchmark Results: Lore vs Baseline

**Date:** 2026-03-11
**Model:** claude-opus-4.6 (via GitHub Copilot CLI)
**Target repo:** lore-self @ `660be2bf`
**Iterations:** 3 per task (36 total runs)

## Aggregate Summary

| Metric | Control | Lore-enabled | Delta |
|---|---|---|---|
| **Mean correctness** | 68.0% | 66.2% | -1.8pp |
| **First-pass accuracy** | 25.0% | **72.2%** | **+47.2pp** |
| **Success rate** | 63.9% | 69.4% | +5.6pp |
| **Mean tool calls** | 18.7 | **5.8** | **-12.9 (-69%)** |
| **Mean tokens** | 5,828 | **1,112** | **-4,715 (-80.9%)** |
| **Mean wall time** | 94.7s | **71.9s** | **-22.8s (-24.1%)** |
| **Answer coverage** | 81.0% | 75.0% | -6.0pp |
| **File coverage** | 89.1% | 89.6% | +0.5pp |
| **Symbol coverage** | 98.1% | 98.1% | 0.0pp |
| **Lore tool usage** | 0% of runs | **100% of runs** | — |
| **Statistical significance** | — | — | p=0.863 (not significant at p<0.05) |
| **Total benchmark wall time** | — | — | 13.6 minutes |

## Per-Task Detail (3-iteration averages)

| Task | Prompt | Ctrl Corr | Lore Corr | Δ Corr | Ctrl Tok | Lore Tok | Tok Δ | Ctrl Wall | Lore Wall | Wall Δ |
|---|---|---|---|---|---|---|---|---|---|---|
| **1.1** | Callers of `openDb` | 0.80 | **1.00** | **+0.20** | 3,690 | 272 | **-93%** | 67.5s | 21.0s | **-69%** |
| **1.2** | Callees of `build` | 0.90 | **1.00** | **+0.10** | 2,054 | 314 | **-85%** | 47.1s | 22.2s | **-53%** |
| **1.4** | Blast radius (3-hop) | 0.67 | 0.67 | 0.00 | 6,186 | 996 | **-84%** | 123.9s | 83.4s | **-33%** |
| **2.1** | `SymbolExtractor` impls | 1.00 | 1.00 | 0.00 | 308 | 455 | +48% | 16.6s | 21.1s | +27% |
| **4.1** | Tests for `parser.ts` | 1.00 | 1.00 | 0.00 | 4,974 | 1,086 | **-78%** | 65.1s | 34.3s | **-47%** |
| **6.1** | Top 5 complexity | 0.67 | **1.00** | **+0.33** | 5,893 | 173 | **-97%** | 131.8s | 15.0s | **-89%** |
| **7.2** | Cross-file consumers of `EmbeddingProvider` | 0.29 | 0.00 | -0.29 | 5,970 | 499 | **-92%** | 155.4s | 180.0s | +16% |
| **8.1** | Import cycles | 1.00 | 1.00 | 0.00 | 11,030 | 817 | **-93%** | 110.3s | 29.2s | **-74%** |
| **3.3** | Module dependency summary | 0.50 | 0.61 | +0.11 | 9,006 | 4,342 | **-52%** | 118.7s | 151.0s | +27% |
| **10.2** | Call fan-in ranking for `read-only.ts` | 0.00 | 0.00 | 0.00 | 4,100 | 2,537 | **-38%** | 157.8s | 126.0s | **-20%** |
| **11.1** | Tests + coverage + reviewer | 0.67 | 0.67 | 0.00 | 7,149 | 1,575 | **-78%** | 109.4s | 104.2s | -5% |
| **11.4** | Deletion impact of `walker.ts` | 0.67 | 0.67 | 0.00 | 2,582 | 1,284 | **-50%** | 52.2s | 76.5s | +47% |

> **Note:** Tool counts exclude `report_intent` calls (present in every run) for readability.

### Where Lore Won

| Task | Advantage | Token Savings | Time Savings |
|---|---|---|---|
| **6.1** (complexity) | `lore_metrics` → 1 call vs bash scanning | **-97%** | **-89%** |
| **8.1** (import cycles) | `lore_graph(import)` → 1 call | **-93%** | **-74%** |
| **1.1** (callers) | `lore_lookup` + `lore_graph(call)` | **-93%** | **-69%** |
| **1.2** (callees) | `lore_lookup` + `lore_graph(call)` | **-85%** | **-53%** |
| **1.4** (blast radius) | `lore_graph(call, depth=3)` | **-84%** | **-33%** |
| **4.1** (test map) | `lore_test_map` → 1 call | **-78%** | **-47%** |

### Where Lore Lost or Tied

| Task | Issue |
|---|---|
| **7.2** (cross-file consumers) | New task — both arms struggled; Lore timed out on 2/3 iters |
| **10.2** (call fan-in) | New task — both scored 0.00; ranking format mismatch |
| **2.1** (inheritance) | Simple grep was optimal; Lore added overhead (+48% tokens) |

### Lore Tools Used

| Tool | Calls | Description |
|---|---|---|
| `lore_lookup` | 28 | Symbol/file lookup by name |
| `lore_graph` | 26 | Call, inheritance, import graph queries |
| `lore_search` | 6 | Full-text/structural search |
| `lore_coverage` | 8 | Test coverage data |
| `lore_blame` | 7 | Git blame / ownership |
| `lore_test_map` | 6 | Source → test file mapping |
| `lore_metrics` | 3 | Complexity metrics |

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
| Index time | ~5,138 ms |

### Copilot CLI Configuration

| Setting | Value |
|---|---|
| `BENCHMARK_COPILOT` | `1` |
| `BENCHMARK_REPO` | `lore-self` |
| `BENCHMARK_MODEL` | `claude-opus-4.6` |
| `BENCHMARK_INDEX_MODE` | `scip` |
| `BENCHMARK_ITERATIONS` | `3` |
| Per-task timeout | 180 s |
| Control arm | Copilot CLI with `--add-dir` only |
| Lore-enabled arm | Copilot CLI with Lore MCP server (`--additional-mcp-config`) |

---

## Per-Task Notes

**Q1.1 — Callers of `openDb`:** Lore calls: `lore_lookup(kind=symbol, query=openDb)` → `lore_graph(kind=call, target_id=400)`. Control missed `docsAutoNotes1` in all 3 iterations; Lore found all callers via the pre-indexed call graph every time.

**Q1.2 — Callees of `build`:** Lore calls: `lore_lookup(kind=symbol, query=build)` → `lore_graph(kind=call, source_id=1830, compact=true)`. Control missed `<constructor>` (SCIP-specific callee name); Lore's graph contains it.

**Q1.4 — Blast radius of `resolveSymbolEdges` (3-hop):** Both arms scored 0.67 avg (one iteration had CLI timeouts). Lore used `lore_graph(kind=call, depth=3)` for transitive closure.

**Q2.1 — Implementations of `SymbolExtractor`:** Both found all 23 implementations. Control's single `grep implements SymbolExtractor` was simpler. Lore: `lore_lookup` + `lore_graph(kind=inheritance, target_id=940)`.

**Q4.1 — Test files for `parser.ts`:** Lore: `lore_test_map(source_path=src/parsing/parser.ts)`. Pre-indexed test mapping + follow-up greps. Lore used 78% fewer tokens than control.

**Q6.1 — Top 5 by cyclomatic complexity:** Lore: `lore_metrics(limit=5)`. Single call to pre-indexed `symbol_metrics` table. Lore scored 1.00 all 3 iters; control failed on 1 of 3 (timed out scanning files).

**Q7.2 — Cross-file consumers of `EmbeddingProvider` (NEW):** Both arms struggled with this new task. Lore used `lore_lookup` + `lore_graph` but timed out on 2 of 3 iterations. Control scored 0.29 avg (one iteration found some consumers via view). The task requires tracing type_refs across 13 files — challenging even with tools.

**Q8.1 — Circular import dependencies:** Lore: `lore_graph(kind=import)`. Both correctly answered "None" in all iterations. Lore: 93% fewer tokens, 74% less time.

**Q3.3 — Module dependency summary:** Mixed results. Lore used `lore_graph` in 2 of 3 iters. Both arms had formatting issues mapping import statements to the expected module dependency format.

**Q10.2 — Call fan-in ranking for `read-only.ts` (NEW):** Both arms scored 0.00 correctness — the ranking format proved difficult. Both found many of the right functions but didn't produce the exact ranked format. Lore used `lore_lookup` + `lore_search` but still needed 38% fewer tokens.

**Q11.1 — Tests + coverage + reviewer for `resolveSymbolEdges`:** Lore: `lore_test_map` + `lore_coverage` + `lore_blame`. One iteration saw Lore timeout; the other two scored 1.00. Control: 1.00 in 2 of 3.

**Q11.4 — Exported symbols from `walker.ts` + consumers:** Both scored 0.67 avg. Lore used `lore_lookup` + `lore_graph` in iteration 1 but fell back to bash-only in iters 2–3.
