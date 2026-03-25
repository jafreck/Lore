# Benchmark Results: esbuild

**Repository**: esbuild  
**Language**: Go + TypeScript  
**Size**: large  
**Description**: JavaScript bundler  
**Model**: claude-opus-4.6  
**Index mode**: scip  
**Iterations**: 5 per task  
**Tasks**: 13  
**Completed runs**: 65/65  
**Date**: 2026-03-21  

## Aggregate Results

| Metric | Control | Lore-enabled | Delta |
|--------|---------|-------------|-------|
| Success rate | 47.7% | 47.7% | +0.0pp |
| Correctness | 71.0% | 64.3% | -6.7pp |
| Answer coverage | 78.2% | 74.0% | -4.2pp |
| File coverage | 80.8% | 81.0% | +0.3pp |
| Symbol coverage | 96.2% | 94.6% | -1.5pp |
| Mean tokens | 6784 | 3985 | -2799 (-41.3%) |
| Mean wall time | 102.3s | 71.5s | -30.8s (-30.1%) |
| Mean tool calls | 25.0 | 14.4 | -10.6 |
| First-pass accuracy | 0.0% | 64.6% | +64.6pp |
| Lore tool calls/run | — | 3.6 | — |
| Lore tool usage rate | — | 92.3% | — |

**Statistical significance** (Welch's t-test on correctness): t=-1.295, df=127.8, p=0.1977 — **No** at p<0.05

**Lore tools used**: `lore_dependents`, `lore_graph`, `lore_lookup`, `lore_snippet`, `lore_search`, `lore_trace`

## Per-Task Results

Each task was run 5 times. Values below are means across iterations.

| Task | Category | Control Correctness | Lore Correctness | Delta | Token Δ |
|------|----------|-------------------|-----------------|-------|---------|
| esbuild-1.1-Build | localization | 100.0% | 90.0% | -0.10 | -515 (-30%) |
| esbuild-1.2-rebuildImpl | localization | 33.3% | 33.3% | +0.00 | -2545 (-87%) |
| esbuild-1.4-rebuildImpl | modification | 100.0% | 75.0% | -0.25 | -16242 (-98%) |
| esbuild-1.3-rebuildImpl | explanation | 100.0% | 100.0% | +0.00 | +873 (+7%) |
| esbuild-1.5-Build | localization | 66.7% | 66.7% | +0.00 | -993 (-4%) |
| esbuild-1.7-Build | explanation | 100.0% | 100.0% | +0.00 | -9078 (-94%) |
| esbuild-1.8-Build | modification | 30.0% | 50.0% | +0.20 | -5431 (-70%) |
| esbuild-7.2-rebuildImpl | localization | 50.0% | 50.0% | +0.00 | +86 (+19%) |
| esbuild-7.3-Build | localization | 80.0% | 0.0% | -0.80 | -6817 (-85%) |
| esbuild-10.1-rebuildImpl | explanation | 50.0% | 50.0% | +0.00 | +183 (+23%) |
| esbuild-10.3-rebuildImpl | explanation | 80.0% | 88.0% | +0.08 | +4018 (+208%) |
| esbuild-11.2-rebuildImpl | modification | 50.0% | 50.0% | +0.00 | +224 (+46%) |
| esbuild-11.3-rebuildImpl | refactoring | 83.3% | 83.3% | +0.00 | -155 (-13%) |

## Summary

- **Lore better**: 2 tasks
  - esbuild-1.8-Build: +0.20 correctness
  - esbuild-10.3-rebuildImpl: +0.08 correctness
- **Equal**: 8 tasks
- **Lore worse**: 3 tasks
  - esbuild-1.1-Build: -0.10 correctness
  - esbuild-1.4-rebuildImpl: -0.25 correctness
  - esbuild-7.3-Build: -0.80 correctness
