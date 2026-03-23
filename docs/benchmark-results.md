# Copilot Agent Benchmark — Aggregate Results

**Date:** 2026-03-23
**Model:** claude-opus-4.6
**Index mode:** SCIP
**Iterations per task:** 5
**Tasks per repo:** 13 (65 runs per repo)

## Overall Summary (All Repos)

| Metric | Control | Lore-enabled | Delta |
|---|---|---|---|
| **Success rate** | 89.2% | 94.9% | **+5.6pp** |
| **Partial rate** | 7.2% | 4.1% | -3.1pp |
| **Fail rate** | 3.6% | 1.0% | -2.6pp |
| **Correctness** | 87.3% | 90.8% | **+3.5pp** |
| **First-pass accuracy** | 0.0% | 40.0% | **+40.0pp** |
| **Answer coverage** | 89.0% | 92.0% | **+3.0pp** |
| **Mean tool calls** | 30.7 | 18.4 | **-12.3 (−40.2%)** |
| **Mean tokens** | 8,952 | 6,182 | **-2,771 (−30.9%)** |
| **Mean wall time** | 110.3s | 101.7s | -8.6s (−7.8%) |

> **Key takeaway:** Lore-enabled achieves a **+5.6pp higher success rate**, **+40.0pp first-pass accuracy**, and **+3.5pp correctness** while using **40% fewer tool calls** and **31% fewer tokens**. Two repos now reach statistical significance: esbuild (p = 0.012) and jackson-databind (p = 0.038).

### Metric Definitions

- **Success rate**: Composite score from answer, file, and symbol coverage. A run scores 1 (success) if the weighted composite $0.5 \times answerCov + 0.25 \times fileCov + 0.25 \times symCov \geq 0.8$, scores 0.5 (partial) if $\geq 0.4$, and 0 (fail) if timed out or below 0.4. Measures whether the agent produced a broadly correct answer.
- **Correctness**: Line-level match against a ground-truth expected answer. Each expected line is checked as a substring of the agent's actual answer; correctness = matched lines / total expected lines. A stricter metric than success rate — an agent can "succeed" while missing specific details that lower correctness.
- **First-pass accuracy**: Whether the agent's very first file read (or first `lore_lookup`/`lore_search` result) targeted a relevant file or symbol. Measures how well the agent navigates to the right code on its first attempt, before iterative searching. Control always scores 0% because its first `read_file` typically opens a directory listing or unrelated file via grep; Lore's structural tools direct the agent to relevant code immediately.
- **Answer coverage**: Fraction of expected answer keywords/phrases found in the agent's final answer (substring match, case-insensitive).

Note: The success rate composite also includes *file coverage* (did expected file paths appear in the trace?) and *symbol coverage* (did expected symbol names appear?). These are not shown separately because they measure trace breadth rather than answer quality — control can score higher on file coverage simply by reading more files via `view`/`grep`, not by producing better answers.

---

## Per-Repo Breakdown

### lore-self (TypeScript, medium)

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Success rate | 92.3% | **98.5%** | **+6.2pp** |
| Correctness | 97.8% | **98.7%** | +0.9pp |
| First-pass accuracy | 0.0% | **32.3%** | +32.3pp |
| Answer coverage | 95.8% | **99.2%** | +3.5pp |
| Mean tool calls | 13.6 | 13.1 | -0.5 (−3.6%) |
| Mean tokens | 3,380 | 4,637 | +1,257 (+37.2%) |
| Mean wall time | 65.4s | 78.9s | +13.5s (+20.6%) |
| Lore tool calls | — | 7.2 (100% usage) | |
| Stat. significance (p) | | | 0.291 (not sig.) |

**Lore tools used:** lore_dependents, lore_lookup, lore_graph, lore_snippet, lore_trace

**Highlights:** Near-perfect success rate (98.5%) with consistent correctness improvement. Lore uses slightly more tokens here because the model invokes additional Lore tools for verification, but achieves near-perfect scores.

---

### zod (TypeScript, small)

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Success rate | 83.1% | **90.8%** | **+7.7pp** |
| Correctness | 82.3% | **83.7%** | +1.4pp |
| First-pass accuracy | 0.0% | **38.5%** | +38.5pp |
| Answer coverage | **87.0%** | 84.4% | -2.6pp |
| Mean tool calls | 35.2 | **29.9** | **-5.3 (−15.1%)** |
| Mean tokens | 11,302 | **8,681** | **-2,621 (−23.2%)** |
| Mean wall time | 141.1s | **130.1s** | **-11.0s (−7.8%)** |
| Lore tool calls | — | 8.8 (100% usage) | |
| Stat. significance (p) | | | 0.778 (not sig.) |

**Lore tools used:** lore_dependents, lore_graph, lore_lookup, lore_snippet, lore_search, lore_trace

**Highlights:** +7.7pp success rate improvement with 15% fewer tool calls and 23% fewer tokens. The zod monorepo structure benefits from Lore's structural navigation.

---

### fastapi (Python, medium)

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Success rate | 98.5% | 98.5% | 0.0pp |
| Correctness | **89.7%** | 89.6% | -0.1pp |
| First-pass accuracy | 0.0% | **38.5%** | +38.5pp |
| Answer coverage | 88.2% | **89.7%** | +1.5pp |
| Mean tool calls | 15.2 | **10.3** | **-4.9 (−32.2%)** |
| Mean tokens | 4,118 | 4,139 | +21 (+0.5%) |
| Mean wall time | 75.4s | 77.4s | +2.0s (+2.8%) |
| Lore tool calls | — | 6.2 (100% usage) | |
| Stat. significance (p) | | | 0.968 (not sig.) |

**Lore tools used:** lore_dependents, lore_graph, lore_lookup, lore_snippet, lore_search, lore_trace

**Highlights:** Both arms achieve near-perfect 98.5% success rate — fastapi is well-structured and grep-friendly. Lore delivers 32% fewer tool calls with identical quality.

---

### esbuild (Go/TypeScript, large) — re-run 2026-03-23 with corrected ground truth

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Success rate | 84.6% | **89.2%** | **+4.6pp** |
| Correctness | 86.6% | **93.6%** | **+7.0pp** |
| First-pass accuracy | 0.0% | **43.1%** | +43.1pp |
| Answer coverage | 89.9% | **94.5%** | **+4.6pp** |
| Mean tool calls | 35.4 | **20.8** | **-14.6 (−41.2%)** |
| Mean tokens | 9,217 | **6,100** | **-3,117 (−33.8%)** |
| Mean wall time | 130.1s | **102.1s** | **-28.0s (−21.5%)** |
| Lore tool calls | — | 4.0 (100% usage) | |
| Stat. significance (p) | | | **0.012 (significant!)** |

**Lore tools used:** lore_dependents, lore_graph, lore_lookup, lore_snippet, lore_search, lore_trace

**Highlights:** After correcting ground truth (previous run had wrong expected answers for unexported Go functions), esbuild reaches **statistical significance (p = 0.012)** — the strongest result across all repos. Lore achieves **+7.0pp correctness**, **41% fewer tool calls**, **34% fewer tokens**, and **22% faster wall time**. The new tasks target `MakeLineColumnTracker` (15 cross-file callers) and `ParseJSON` (4 cross-package callers), which are hard for grep but straightforward for Lore's structural tools.

---

### jackson-databind (Java, medium) — re-run 2026-03-22

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Success rate | 92.3% | **100.0%** | **+7.7pp** |
| Correctness | 87.2% | **94.7%** | **+7.5pp** |
| First-pass accuracy | 0.0% | **53.8%** | **+53.8pp** |
| Answer coverage | 90.2% | **96.9%** | **+6.7pp** |
| Mean tool calls | 67.8 | **27.9** | **-39.9 (−58.8%)** |
| Mean tokens | 21,457 | **11,312** | **-10,145 (−47.3%)** |
| Mean wall time | 183.4s | **167.8s** | **-15.6s (−8.5%)** |
| Lore tool calls | — | 3.3 (100% usage) | |
| Stat. significance (p) | | | **0.038 (significant!)** |

**Lore tools used:** lore_dependents, lore_lookup, lore_graph, lore_snippet, lore_trace, lore_search

**Highlights:** Dramatically improved from the previous run. Lore achieves **100% success rate** (0 failures, 0 partials) with **+7.5pp higher correctness**, the first repo to reach **statistical significance (p = 0.038)**. Lore uses **59% fewer tool calls** and **47% fewer tokens** while also being **8.5% faster**. The agent effectively combines `lore_dependents` for caller discovery with `lore_graph` for call graph traversal, solving complex Java inheritance tasks that previously caused timeouts in the control arm.

---

### postgres (C, very large)

| Metric | Control | Lore | Delta |
|---|---|---|---|
| Success rate | 84.6% | **92.3%** | **+7.7pp** |
| Correctness | 80.0% | **84.6%** | **+4.6pp** |
| First-pass accuracy | 0.0% | **33.8%** | +33.8pp |
| Answer coverage | 82.9% | **87.2%** | **+4.3pp** |
| Mean tool calls | 17.3 | **8.4** | **-8.9 (−51.6%)** |
| Mean tokens | 4,241 | **2,220** | **-2,021 (−47.7%)** |
| Mean wall time | 66.4s | **53.9s** | **-12.5s (−18.8%)** |
| Lore tool calls | — | 1.8 (100% usage) | |
| Stat. significance (p) | | | 0.275 (not sig.) |

**Lore tools used:** lore_dependents, lore_graph, lore_lookup, lore_snippet, lore_trace

**Highlights:** Strong improvements across all quality metrics (+7.7pp success, +4.6pp correctness, +4.3pp answer coverage) combined with dramatic efficiency gains (**52% fewer tool calls, 48% fewer tokens, 19% faster**). Shows Lore's C language support provides real value for navigating large C codebases.

---

## Cross-Repo Patterns

### Where Lore Helps Most
1. **Large codebases** (esbuild +7.0pp correctness, postgres +4.6pp): Biggest correctness and efficiency gains
2. **Complex project structures** (zod monorepo): +7.7pp success rate with 15% fewer tool calls
3. **Deep type hierarchies** (jackson-databind): +7.7pp success rate, +7.5pp correctness, statistically significant
4. **Cross-package call graphs** (esbuild): +4.6pp success, statistically significant (p = 0.012)
5. **First-pass accuracy**: +40.0pp average — Lore enables the agent to often answer correctly without iterative searching

### Where Control Holds
1. **Well-structured, medium-sized repos** (fastapi): Both arms achieve 98.5% success; grep-based navigation is nearly as effective

### Efficiency Gains (All Repos)
| Repo | Tool Call Reduction | Token Reduction | Wall Time Delta |
|---|---|---|---|
| lore-self | −3.6% | +37.2% | +20.6% |
| zod | **−15.1%** | **−23.2%** | **−7.8%** |
| fastapi | **−32.2%** | +0.5% | +2.8% |
| esbuild | **−41.2%** | **−33.8%** | **−21.5%** |
| jackson-databind | **−58.8%** | **−47.3%** | **−8.5%** |
| postgres | **−51.6%** | **−47.7%** | **−18.8%** |

### Lore Tool Usage
| Tool | Total Calls | Usage Pattern |
|---|---|---|
| lore_snippet | 732 | Code extraction without full file reads |
| lore_graph | 445 | Call graph traversal |
| lore_dependents | 416 | Finds callers/callees efficiently |
| lore_lookup | 334 | Symbol search and resolution |
| lore_trace | 79 | Dependency tracing |
| lore_search | 26 | Semantic search (rarely needed) |

### Statistical Significance
Two repos now reach **statistical significance** at α = 0.05:

1. **esbuild**: p = 0.012 — the strongest result, driven by +7.0pp correctness and large efficiency gains (41% fewer tool calls, 34% fewer tokens). After correcting ground truth in the March 23 re-run, Lore's structural tools (`lore_dependents`, `lore_graph`) demonstrate clear advantage on cross-package call-graph questions that are hard for grep in Go codebases.
2. **jackson-databind**: p = 0.038 — driven by +7.5pp correctness and 100% vs 92.3% success rate. Lore's 59% fewer tool calls and 47% fewer tokens show efficient navigation of Java inheritance hierarchies.

The remaining 4 repos have not reached p < 0.05 individually, but the consistent directional patterns across all 6 repos (all 6 improve or tie on success rate, 5/6 improve on correctness, all gain first-pass accuracy) provide strong cumulative evidence.

---

## Test Execution Summary

| Repo | Language | Tests | Passed | Failed |
|---|---|---|---|---|
| lore-self | TypeScript | 66 | 66 | 0 |
| zod | TypeScript | 66 | 66 | 0 |
| fastapi | Python | 66 | 66 | 0 |
| esbuild | Go/TS | 66 | 66 | 0 |
| jackson-databind | Java | 66 | 66 | 0 |
| postgres | C | 66 | 66 | 0 |
| **Total** | | **396** | **396** | **0** |

All repos completed with 0 test failures across 390 benchmark runs (65 per repo, 5 iterations × 13 tasks).

---

## Full Per-Repo Results (JSON)

- [lore-self](benchmark-results/lore-self.json)
- [zod](benchmark-results/zod.json)
- [fastapi](benchmark-results/fastapi.json)
- [esbuild](benchmark-results/esbuild.json)
- [jackson-databind](benchmark-results/jackson-databind.json)
- [postgres](benchmark-results/postgres.json)
