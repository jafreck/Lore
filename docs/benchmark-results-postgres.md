# Benchmark Results: PostgreSQL (C, very-large)

**Date:** 2026-03-15  
**Model:** claude-opus-4.6 (via GitHub Copilot CLI)  
**Target repo:** postgres @ `REL_18_3` (~1.4M LOC, C)  
**Questions:** 15 | **Iterations:** 1  
**Total duration:** 881 s (~14.7 min)

## Aggregate Summary

| Metric | Control | Lore-enabled | Delta |
|---|---|---|---|
| **Success rate** | 73.3% | 73.3% | 0.0pp |
| **Mean correctness** | 69.4% | **72.2%** | **+2.8pp** |
| **First-pass accuracy** | 33.3% | **53.3%** | **+20.0pp** |
| **Mean tool calls** | 35.9 | **10.1** | **-25.8 (-71.9%)** |
| **Mean tokens** | 11,584 | **3,096** | **-8,488 (-73.3%)** |
| **Mean wall time** | 134.8 s | **60.3 s** | **-74.6 s (-55.3%)** |
| **Answer coverage** | 83.3% | 82.2% | -1.1pp |
| **File coverage** | 84.4% | **93.3%** | **+8.9pp** |
| **Symbol coverage** | 100.0% | 100.0% | 0.0pp |
| **Lore tool usage** | 0% of runs | **93% of runs** | — |

## Per-Task Detail

| Task | Category | Ctrl Corr | Lore Corr | Δ Corr | Ctrl Tok | Lore Tok | Tok Δ | Ctrl Wall | Lore Wall | Wall Δ |
|---|---|---|---|---|---|---|---|---|---|---|
| **1.1** | Call Graph — callers of `parse_analyze_fixedparams` | 1.00 | 1.00 | 0.00 | 713 | 431 | **-40%** | 25.9 s | 22.1 s | -15% |
| **1.2** | Call Graph — callees of `pg_analyze_and_rewrite_fixedparams` | 1.00 | 1.00 | 0.00 | 467 | 301 | **-36%** | 22.6 s | 19.4 s | -14% |
| **1.4** | Call Graph — blast radius (3-hop) | 0.00 | **1.00** | **+1.00** | 38,744 | 1,777 | **-95%** | 360.0 s | 31.3 s | **-91%** |
| **1.6** | Dead Code — exports in `analyze.c` | 1.00 | 1.00 | 0.00 | 2,445 | 2,562 | +5% | 67.6 s | 70.4 s | +4% |
| **2.1** | Type Hierarchy — `TupleTableSlotOps` implementors | 1.00 | 1.00 | 0.00 | 233 | 233 | 0% | 14.5 s | 15.0 s | +3% |
| **3.5** | Module Deps — single-directory external packages | 0.67 | 0.33 | -0.33 | 38,511 | 12,611 | **-67%** | 257.2 s | 138.4 s | **-46%** |
| **4.1** | Test Mapping — `pg_stat_statements.c` | 1.00 | 1.00 | 0.00 | 404 | 602 | +49% | 15.5 s | 19.7 s | +27% |
| **5.1** | Semantic Sim — functions like `heap_insert` | 0.75 | 0.50 | -0.25 | 13,716 | 1,404 | **-90%** | 155.9 s | 40.3 s | **-74%** |
| **6.1** | Complexity — top 5 by cyclomatic complexity | 1.00 | 0.00 | -1.00 | 13,963 | 7,688 | **-45%** | 205.5 s | 168.7 s | -18% |
| **7.2** | Cross-file — consumers of `Portal` type | 1.00 | 1.00 | 0.00 | 18,264 | 6,415 | **-65%** | 326.0 s | 116.7 s | **-64%** |
| **8.1** | Graph — circular dependencies | 1.00 | 1.00 | 0.00 | 2,636 | 184 | **-93%** | 44.4 s | 14.3 s | **-68%** |
| **9.1** | API Surface — branch diff | 0.00 | 0.00 | 0.00 | 4,431 | 2,554 | **-42%** | 59.8 s | 59.3 s | -1% |
| **10.2** | Fan-in — top callers in `utility.c` | 0.00 | 0.00 | 0.00 | 1,893 | 2,293 | +21% | 45.3 s | 63.2 s | +40% |
| **11.4** | Deletion — exported symbols from `pquery.c` | 1.00 | 1.00 | 0.00 | 4,590 | 7,184 | +57% | 62.4 s | 108.7 s | +74% |
| **12.1** | Architecture — layer violations | 0.00 | **1.00** | **+1.00** | 32,746 | 197 | **-99%** | 360.0 s | 16.5 s | **-95%** |

## Biggest Lore Wins

| Task | Control | Lore | Token Δ | Key Lore Tool |
|---|---|---|---|---|
| **12.1** — layer violations | 0.00 (timeout, 32.7K tok) | **1.00** (197 tok) | **-99.4%** | `lore_structure(analysis=layers)` |
| **1.4** — 3-hop blast radius | 0.00 (timeout, 38.7K tok) | **1.00** (1.8K tok) | **-95.4%** | `lore_dependents(depth=3)` |
| **8.1** — circular deps | 1.00 (2.6K tok) | 1.00 (184 tok) | **-93.0%** | `lore_structure(analysis=cycles)` |
| **5.1** — similar functions | 0.75 (13.7K tok) | 0.50 (1.4K tok) | **-89.8%** | `lore_search(mode=semantic)` |
| **7.2** — Portal consumers | 1.00 (18.3K tok) | 1.00 (6.4K tok) | **-64.9%** | `lore_lookup` + `lore_dependents` |

## Lore Tools Invoked

9 distinct Lore tools used across 93% of runs:

| Tool | Calls | Used By |
|---|---|---|
| `lore_lookup` | 17 | 1.2, 1.6, 3.5, 5.1, 7.2, 9.1, 10.2 |
| `lore_diff` | 6 | 9.1 |
| `lore_dependents` | 5 | 1.1, 1.4, 7.2, 11.4 |
| `lore_history` | 5 | 9.1 |
| `lore_graph` | 3 | 1.2, 3.5 |
| `lore_structure` | 3 | 3.5, 8.1, 12.1 |
| `lore_metrics` | 2 | 6.1 |
| `lore_test_map` | 1 | 4.1 |
| `lore_search` | 1 | 5.1 |

## Configuration

| Setting | Value |
|---|---|
| Index mode | SCIP (scip-clang via compilation database) |
| Embedding model | None |
| LSP enrichment | Disabled |
| Per-task timeout | 360 s |
| Control arm | Copilot CLI with `--add-dir` only |
| Lore-enabled arm | Copilot CLI with Lore MCP server |

## Per-Task Notes

**Q1.1 — Callers of `parse_analyze_fixedparams`:** Both perfect. Lore: `lore_dependents(query=parse_analyze_fixedparams, depth=1)`. 40% fewer tokens.

**Q1.2 — Callees of `pg_analyze_and_rewrite_fixedparams`:** Both perfect. Lore: `lore_lookup` → `lore_graph(kind=call)`. 36% fewer tokens.

**Q1.4 — Blast radius of `pg_analyze_and_rewrite_fixedparams` (3-hop):** Biggest correctness win. Control timed out at 360 s with 38.7K tokens, scoring 0.00. Lore: single `lore_dependents(depth=3)` call, 1.8K tokens, 31 s, perfect score.

**Q1.6 — Dead code in `analyze.c`:** Both correctly answered "None" — all exported functions are called externally. Similar effort; Lore used `lore_lookup(kind=file)` for initial file info.

**Q2.1 — `TupleTableSlotOps` implementors:** Both found all 4 instances via `grep`. Lore arm didn't reach for Lore tools (grep was sufficient for this C struct pattern), causing the test assertion failure.

**Q3.5 — Single-directory external packages:** Control scored 0.67, Lore 0.33. Both struggled — this is a hard aggregation question over a C codebase with `#include <...>` patterns. Lore used `lore_structure` + `lore_graph` but missed some packages. 67% fewer tokens for Lore.

**Q4.1 — Test mapping for `pg_stat_statements.c`:** Both perfect. Lore: `lore_test_map`. Control used `glob` to find test SQL files.

**Q5.1 — Functions similar to `heap_insert`:** Control (0.75) outperformed Lore (0.50). Lore used `lore_search(mode=semantic)` which found `heap_multi_insert` and `simple_heap_insert` but missed `heap_update`/`heap_delete` (semantically related but different operation names). Control's manual file reading found more. 90% fewer tokens for Lore.

**Q6.1 — Top 5 by cyclomatic complexity:** Control scored 1.00 (via `lizard` tool, 56 bash calls), Lore scored 0.00. Both found identical functions but Lore's answer lacked the word "complexity" in its output, causing the `expectedAnswerParts` match to fail. This is a scorer issue, not a capability issue.

**Q7.2 — Cross-file consumers of `Portal`:** Both perfect. Lore: `lore_lookup` + `lore_dependents` + `lore_graph`. 65% fewer tokens, 64% faster.

**Q8.1 — Circular dependencies:** Both answered "None" correctly. Lore: single `lore_structure(analysis=cycles)` call — 184 tokens in 14 s vs control's 2.6K tokens in 44 s.

**Q9.1 — Branch diff:** Both scored 0.00 — only one branch indexed (current HEAD). Lore used `lore_diff` + `lore_history` to verify. Both correctly deduced "Added: None, Removed: None, Changed: None" but scorer marked 0.00 on correctness for both.

**Q10.2 — Fan-in ranking for `utility.c`:** Both scored 0.00. Both missed `standard_ProcessUtility` in their top-3 ranking. Lore used `lore_lookup` to inspect the file.

**Q11.4 — Deletion impact of `pquery.c`:** Both perfect. Lore used `lore_dependents` but then fell back to bash for verification, using more tokens than control. Control's focused grep was more efficient here.

**Q12.1 — Architectural layer violations:** Second-biggest correctness win. Control timed out at 360 s with 32.7K tokens trying to analyze the directory structure manually. Lore: single `lore_structure(analysis=layers)` call — 197 tokens in 16.5 s, perfect score.
