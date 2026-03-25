# Benchmark Results: lore-self

**Repository**: lore-self  
**Language**: TypeScript  
**Size**: medium  
**Description**: Lore itself  
**Model**: claude-opus-4.6  
**Index mode**: scip  
**Iterations**: 5 per task  
**Tasks**: 13  
**Completed runs**: 65/65  
**Date**: 2026-03-20  

## Aggregate Results

| Metric | Control | Lore-enabled | Delta |
|--------|---------|-------------|-------|
| Success rate | 84.6% | 92.3% | +7.7pp |
| Correctness | 89.3% | 91.5% | +2.2pp |
| Answer coverage | 88.5% | 93.1% | +4.6pp |
| File coverage | 97.4% | 100.0% | +2.6pp |
| Symbol coverage | 96.2% | 100.0% | +3.8pp |
| Mean tokens | 3026 | 3363 | +337 (+11.1%) |
| Mean wall time | 89.7s | 93.1s | +3.4s (+3.8%) |
| Mean tool calls | 10.6 | 10.5 | -0.1 |
| First-pass accuracy | 0.0% | 40.0% | +40.0pp |
| Lore tool calls/run | — | 2.7 | — |
| Lore tool usage rate | — | 100.0% | — |

**Statistical significance** (Welch's t-test on correctness): t=0.481, df=127.1, p=0.6312 — **No** at p<0.05

**Lore tools used**: `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_trace`

## Per-Task Results

Each task was run 5 times. Values below are means across iterations.

| Task | Category | Control Correctness | Lore Correctness | Delta | Token Δ |
|------|----------|-------------------|-----------------|-------|---------|
| lore-self-1.1-openDb | localization | 0.0% | 20.0% | +0.20 | +726 (+69%) |
| lore-self-1.2-build | localization | 88.0% | 100.0% | +0.12 | -998 (-76%) |
| lore-self-1.4-resolveSymbolEdges | modification | 100.0% | 100.0% | +0.00 | -8809 (-96%) |
| lore-self-1.3-build | explanation | 100.0% | 100.0% | +0.00 | +588 (+9%) |
| lore-self-1.5-openDb | localization | 100.0% | 100.0% | +0.00 | +110 (+19%) |
| lore-self-1.7-build | explanation | 100.0% | 100.0% | +0.00 | -3494 (-81%) |
| lore-self-1.8-openDb | modification | 100.0% | 100.0% | +0.00 | +5714 (+215%) |
| lore-self-7.2-openDb | localization | 100.0% | 100.0% | +0.00 | +1790 (+56%) |
| lore-self-7.3-resolutionStage | localization | 100.0% | 100.0% | +0.00 | -161 (-17%) |
| lore-self-10.1-openDb | explanation | 83.3% | 70.0% | -0.13 | -738 (-44%) |
| lore-self-10.3-openDb | explanation | 100.0% | 100.0% | +0.00 | +1403 (+26%) |
| lore-self-11.2-openDb | modification | 100.0% | 100.0% | +0.00 | +8327 (+700%) |
| lore-self-11.3-resolveSymbolEdges | refactoring | 90.0% | 100.0% | +0.10 | -82 (-10%) |

## Summary

- **Lore better**: 3 tasks
  - lore-self-1.1-openDb: +0.20 correctness
  - lore-self-1.2-build: +0.12 correctness
  - lore-self-11.3-resolveSymbolEdges: +0.10 correctness
- **Equal**: 9 tasks
- **Lore worse**: 1 tasks
  - lore-self-10.1-openDb: -0.13 correctness
