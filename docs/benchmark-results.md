# Benchmark Results: Lore vs Baseline

**Date:** 2026-03-11  
**Model:** claude-opus-4.6  
**Target repo:** lore-self @ `660be2bf`  
**Index mode:** SCIP  
**Index time:** 2,548 ms  

## Per-Task Results

| Task | Question | Ctrl Correct. | Lore Correct. | Ctrl Tokens | Lore Tokens | Token Δ | Ctrl Wall | Lore Wall | Speedup | Lore Tools Used |
|---|---|---|---|---|---|---|---|---|---|---|
| **1.1** | Callers of `openDb` | 1.00 | 1.00 | 1,273 | 272 | **−79%** | 41.8s | 20.2s | **2.1×** | `lore_lookup`, `lore_graph` |
| **1.2** | Callees of `build` | 1.00 | 0.83 | 780 | 310 | **−60%** | 38.2s | 23.0s | **1.7×** | `lore_lookup`, `lore_graph` |
| **1.4** | Blast radius of `resolveSymbolEdges` | 1.00 | 1.00 | 11,086 | 13,830 | +25% | 180.0s | 180.0s | 1.0× | `lore_lookup`, `lore_graph`, `lore_snippet` |
| **3.1** | Imports of `server.ts` | 1.00 | 1.00 | 970 | 1,551 | +60% | 66.4s | 44.8s | **1.5×** | `lore_lookup`, `lore_graph` |
| **3.2** | Reverse deps of `schema.ts` | 1.00 | 1.00 | 503 | 1,067 | +112% | 17.8s | 38.3s | 0.5× | `lore_graph`, `lore_lookup` |
| **4.1** | Test map for `parser.ts` | 1.00 | 1.00 | 2,018 | 459 | **−77%** | 49.9s | 23.7s | **2.1×** | `lore_test_map` |
| **6.1** | Top 5 complex functions | 0.00 | 0.00 | 10,899 | 54,156 | +397% | 180.0s | 180.0s | 1.0× | `lore_metrics` |
| **7.1** | Domain expert for `parser.ts` | 1.00 | — | 290 | — | — | 19.0s | — | — | *(not invoked)* |
| **9.1** | Architecture overview | 0.92 | 0.92 | 220 | 308 | +40% | 16.3s | 24.2s | 0.7× | `lore_architecture` |
| **9.5** | TypeScript file count | 0.00 | — | 317 | — | — | 20.1s | — | — | *(not invoked)* |
| **11.1** | Modify workflow for `resolveSymbolEdges` | 1.00 | 1.00 | 5,109 | 3,257 | **−36%** | 152.9s | 102.8s | **1.5×** | `lore_test_map`, `lore_coverage`, `lore_blame` |
| **11.4** | Deletion impact of `walker.ts` | **0.57** | **1.00** | 263 | 2,634 | +901% | 15.6s | 66.8s | 0.2× | `lore_graph`, `lore_lookup` |

## Aggregate Summary (10 comparable tasks)

Tasks 7.1 and 9.5 are excluded because the Lore-enabled agent answered them
with native tools (git blame, find) and did not invoke any Lore MCP tools.

| Metric | Control | Lore-enabled | Δ |
|---|---|---|---|
| **Mean correctness** | 0.79 | 0.88 | +9 pp |
| **Full-correctness tasks** (≥ 1.00) | 7 / 10 | 7 / 10 | — |
| **Mean tokens** | 3,392 | 7,783 | +129% |
| **Median tokens** | 1,122 | 1,309 | +17% |
| **Mean wall time** | 76.9s | 70.4s | −8% |
| **Total wall time** | 769s | 704s | −8% |

### Where Lore Wins

| Signal | Tasks | Detail |
|---|---|---|
| **Correctness improvement** | 11.4 | Control scored 0.57; Lore scored 1.00 — found all 7 dependents vs only 3 |
| **Token savings ≥ 36%** | 1.1, 1.2, 4.1, 11.1 | 36–79% fewer tokens with the same or higher correctness |
| **Wall-time speedup ≥ 1.5×** | 1.1, 1.2, 3.1, 4.1, 11.1 | 1.5–2.1× faster |
| **Best single task** | 4.1 (test mapping) | `lore_test_map` answered in 1 tool call (459 tokens, 23.7s) vs grep-based search (2,018 tokens, 49.9s) |

### Where Lore Regresses

| Signal | Tasks | Detail |
|---|---|---|
| **Token overhead** | 6.1 | `lore_metrics` looped 135 tool calls burning 54k tokens (vs 11k control) — both timed out |
| **Slower wall time** | 3.2, 9.1 | Graph/architecture queries added overhead but maintained correctness |
| **Marginal accuracy loss** | 1.2 | Lore found 5/6 callees (0.83) vs control finding all 6 (1.00); still faster and cheaper |

## Lore MCP Tools Observed

| Tool | Invocations | Tasks |
|---|---|---|
| `lore_lookup` | 7 tasks | 1.1, 1.2, 1.4, 3.1, 3.2, 11.4 |
| `lore_graph` | 7 tasks | 1.1, 1.2, 1.4, 3.1, 3.2, 11.4 |
| `lore_test_map` | 2 tasks | 4.1, 11.1 |
| `lore_architecture` | 1 task | 9.1 |
| `lore_metrics` | 1 task | 6.1 |
| `lore_snippet` | 1 task | 1.4 |
| `lore_coverage` | 1 task | 11.1 |
| `lore_blame` | 1 task | 11.1 |

## Test Failures

| Test | Reason |
|---|---|
| 7.1 lore-enabled | Agent used native `git log` instead of Lore; assertion `loreToolsCalled.length > 0` failed |
| 9.5 lore-enabled | Agent used native `find` instead of Lore; same assertion |
| Aggregate test | Timed out at 600 s (re-runs all 24 tasks from scratch) |

## Configuration

```
BENCHMARK_COPILOT=1
BENCHMARK_REPO=lore-self
BENCHMARK_INDEX_MODE=scip
BENCHMARK_MODEL=claude-opus-4.6
```
