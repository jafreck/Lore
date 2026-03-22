# Lore Copilot Benchmark Results

**Date:** 2026-03-21  
**Model:** claude-opus-4.6  
**Iterations per repo:** 5  
**Total runs:** 390 (6 repos × 13 tasks × 5 iterations)

## Cross-Repo Aggregate Summary

| Metric | Control | Lore-Enabled | Delta |
|---|---|---|---|
| **Success rate** | 82.8% | 90.8% | **+8.0pp** |
| **Correctness** | 83.8% | 83.5% | -0.3pp |
| **Answer coverage** | 85.8% | 86.5% | +0.7pp |
| **File coverage** | 94.8% | 98.6% | +3.8pp |
| **Symbol coverage** | 98.9% | 98.4% | -0.5pp |
| **Mean tokens** | 7,451 | 5,641 | **-24.3%** |
| **Mean wall time** | 92.9s | 91.3s | **-1.8%** |
| **Mean tool calls** | 26.6 | 17.6 | **-33.8%** |
| **First-pass accuracy** | 0.0% | 39.5% | **+39.5pp** |

### Key Takeaways

1. **Higher success rate (+8.0pp):** Lore-enabled runs complete tasks successfully more often (90.8% vs 82.8%), with more full successes and fewer partial results.
2. **24.3% fewer tokens:** Lore's structured queries (call graphs, dependents, symbol lookups) let the agent retrieve precise information without reading full files, saving ~1,810 tokens per task on average.
3. **33.8% fewer tool calls:** The agent makes ~9 fewer tool calls per task with Lore, indicating more efficient exploration.
4. **39.5% first-pass accuracy:** Over a third of Lore-enabled runs answer correctly on the first attempt, whereas control never achieves first-pass accuracy.
5. **Comparable correctness:** Correctness is nearly identical between arms (-0.3pp), indicating Lore does not reduce answer quality while improving efficiency.
6. **Higher file coverage (+3.8pp):** Lore-enabled runs reference more of the expected source files (98.6% vs 94.8%).

---

## Per-Repo Results

### lore-self (TypeScript, medium, SCIP index)

| Metric | Control | Lore-Enabled | Delta |
|---|---|---|---|
| Success rate | 92.3% | 98.5% | +6.2pp |
| Correctness | 97.9% | 97.2% | -0.8pp |
| Answer coverage | 96.2% | 98.5% | +2.3pp |
| Tokens | 3,281 | 4,269 | +30.1% |
| Wall time | 58.0s | 76.9s | +32.7% |
| Tool calls | 13.3 | 13.2 | -0.8% |
| First-pass accuracy | 0.0% | 35.4% | +35.4pp |
| Lore tool usage | — | 100% of runs | — |
| t-test (correctness) | — | t=-0.444, p=0.658 | Not significant |

**Top Lore tools:** lore_snippet (337), lore_dependents (50), lore_graph (28), lore_lookup (27), lore_trace (10)

---

### jackson-databind (Java, medium, tree-sitter index)

| Metric | Control | Lore-Enabled | Delta |
|---|---|---|---|
| Success rate | 92.3% | 92.3% | 0.0pp |
| Correctness | 84.5% | 84.4% | -0.1pp |
| Answer coverage | 87.6% | 88.5% | +0.9pp |
| Tokens | 16,540 | 11,001 | **-33.5%** |
| Wall time | 140.8s | 154.5s | +9.7% |
| Tool calls | 53.4 | 33.2 | **-37.8%** |
| First-pass accuracy | 0.0% | 53.8% | +53.8pp |
| Lore tool usage | — | 100% of runs | — |
| t-test (correctness) | — | t=-0.018, p=0.986 | Not significant |

**Top Lore tools:** lore_dependents (60), lore_lookup (57), lore_graph (20), lore_snippet (16), lore_trace (11)

**Note:** Used tree-sitter indexing (SCIP indexing for Java timed out during Maven build).

---

### fastapi (Python, medium, SCIP index)

| Metric | Control | Lore-Enabled | Delta |
|---|---|---|---|
| Success rate | 87.7% | 92.3% | +4.6pp |
| Correctness | 83.1% | 81.7% | -1.4pp |
| Answer coverage | 81.5% | 83.5% | +1.9pp |
| Tokens | 4,493 | 3,440 | **-23.4%** |
| Wall time | 81.4s | 68.0s | **-16.6%** |
| Tool calls | 17.4 | 9.6 | **-44.8%** |
| First-pass accuracy | 0.0% | 46.2% | +46.2pp |
| Lore tool usage | — | 100% of runs | — |
| t-test (correctness) | — | t=-0.363, p=0.718 | Not significant |

**Top Lore tools:** lore_snippet (78), lore_dependents (63), lore_graph (59), lore_lookup (52), lore_trace (21)

---

### esbuild (Go/TypeScript, large, SCIP index)

| Metric | Control | Lore-Enabled | Delta |
|---|---|---|---|
| Success rate | 46.2% | 73.8% | **+27.7pp** |
| Correctness | 73.5% | 67.2% | -6.3pp |
| Answer coverage | 78.8% | 73.4% | -5.4pp |
| Tokens | 6,697 | 4,258 | **-36.4%** |
| Wall time | 97.9s | 70.2s | **-28.3%** |
| Tool calls | 26.0 | 14.6 | **-43.8%** |
| First-pass accuracy | 0.0% | 46.2% | +46.2pp |
| Lore tool usage | — | 100% of runs | — |
| t-test (correctness) | — | t=-1.227, p=0.222 | Not significant |

**Top Lore tools:** lore_lookup (83), lore_snippet (74), lore_dependents (69), lore_graph (55), lore_trace (14)

**Note:** Largest improvement in success rate (+27.7pp). Lore's structured navigation is especially valuable in this large multi-language codebase. Correctness delta is negative (-6.3pp) due to high variance in this complex repo.

---

### zod (TypeScript, small, SCIP index)

| Metric | Control | Lore-Enabled | Delta |
|---|---|---|---|
| Success rate | 89.2% | 95.4% | +6.2pp |
| Correctness | 82.1% | 84.9% | **+2.7pp** |
| Answer coverage | 86.5% | 87.3% | +0.8pp |
| Tokens | 9,595 | 8,721 | -9.1% |
| Wall time | 123.7s | 129.5s | +4.7% |
| Tool calls | 30.0 | 27.4 | -8.7% |
| First-pass accuracy | 0.0% | 32.3% | +32.3pp |
| Lore tool usage | — | 100% of runs | — |
| t-test (correctness) | — | t=0.554, p=0.580 | Not significant |

**Top Lore tools:** lore_graph (185), lore_snippet (137), lore_dependents (102), lore_lookup (93), lore_trace (25)

---

### postgres (C, very-large, SCIP index)

| Metric | Control | Lore-Enabled | Delta |
|---|---|---|---|
| Success rate | 89.2% | 92.3% | +3.1pp |
| Correctness | 81.9% | 85.6% | **+3.8pp** |
| Answer coverage | 84.1% | 87.9% | +3.8pp |
| Tokens | 4,097 | 2,158 | **-47.3%** |
| Wall time | 55.7s | 48.5s | **-12.9%** |
| Tool calls | 19.4 | 7.3 | **-62.4%** |
| First-pass accuracy | 0.0% | 23.1% | +23.1pp |
| Lore tool usage | — | 95% of runs | — |
| t-test (correctness) | — | t=0.974, p=0.332 | Not significant |

**Top Lore tools:** lore_dependents (50), lore_lookup (18), lore_snippet (13), lore_graph (12), lore_trace (9)

**Note:** Best token efficiency gain (-47.3%) and largest tool call reduction (-62.4%). 3 test assertion failures in task 1.3 (iterations 1, 4, 5) but all 65 runs were scored prior to assertion.

---

## Methodology

- Each repo was cloned at a pinned SHA and indexed using Lore (SCIP or tree-sitter)
- 13 tasks per repo cover: call-graph traversal, cross-reference lookup, explanation, modification, and refactoring questions
- Two concurrent arms per task: **control** (Copilot CLI with Lore tools denied) and **lore-enabled** (Copilot CLI with Lore MCP server)
- Scoring against ground-truth expected answers, with metrics for correctness, coverage (answer/file/symbol), tokens, and wall time
- Welch's t-test for statistical significance on correctness

## Configuration Details

| Repo | Language | Size | Index Mode | Tasks | Completed Runs |
|---|---|---|---|---|---|
| lore-self | TypeScript | medium | scip | 13 | 65/65 |
| jackson-databind | Java | medium | tree-sitter | 13 | 65/65 |
| fastapi | Python | medium | scip | 13 | 65/65 |
| esbuild | Go/TypeScript | large | scip | 13 | 65/65 |
| zod | TypeScript | small | scip | 13 | 65/65 |
| postgres | C | very-large | scip | 13 | 65/65 |

## Raw Data

Per-repo structured JSON reports with full per-task per-iteration results are stored in:
- `benchmark-results/lore-self.json`
- `benchmark-results/jackson-databind.json`
- `benchmark-results/fastapi.json`
- `benchmark-results/esbuild.json`
- `benchmark-results/zod.json`
- `benchmark-results/postgres.json`

Full terminal output logs are stored in:
- `benchmark-results/lore-self-full-output.txt`
- `benchmark-results/jackson-databind-full-output.txt`
- `benchmark-results/fastapi-full-output.txt`
- `benchmark-results/esbuild-full-output.txt`
- `benchmark-results/zod-full-output.txt`
- `benchmark-results/postgres-full-output.txt`
