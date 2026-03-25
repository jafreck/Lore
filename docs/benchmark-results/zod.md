# Benchmark Results: zod

**Repository**: zod  
**Language**: TypeScript  
**Size**: small  
**Description**: Schema validation library  
**Model**: claude-opus-4.6  
**Index mode**: scip  
**Iterations**: 5 per task  
**Tasks**: 13  
**Completed runs**: 65/65  
**Date**: 2026-03-21  

## Aggregate Results

| Metric | Control | Lore-enabled | Delta |
|--------|---------|-------------|-------|
| Success rate | 92.3% | 92.3% | +0.0pp |
| Correctness | 83.3% | 82.1% | -1.2pp |
| Answer coverage | 88.0% | 83.7% | -4.3pp |
| File coverage | 98.5% | 100.0% | +1.5pp |
| Symbol coverage | 97.4% | 97.4% | +0.0pp |
| Mean tokens | 9821 | 9415 | -405 (-4.1%) |
| Mean wall time | 128.3s | 133.2s | +4.9s (+3.8%) |
| Mean tool calls | 30.3 | 31.4 | +1.0 |
| First-pass accuracy | 0.0% | 46.2% | +46.2pp |
| Lore tool calls/run | — | 9.0 | — |
| Lore tool usage rate | — | 100.0% | — |

**Statistical significance** (Welch's t-test on correctness): t=-0.240, df=126.0, p=0.8109 — **No** at p<0.05

**Lore tools used**: `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_search`, `lore_trace`

## Per-Task Results

Each task was run 5 times. Values below are means across iterations.

| Task | Category | Control Correctness | Lore Correctness | Delta | Token Δ |
|------|----------|-------------------|-----------------|-------|---------|
| zod-1.1-_parse | localization | 100.0% | 100.0% | +0.00 | +9312 (+196%) |
| zod-1.2-parse | localization | 26.7% | 6.7% | -0.20 | +3674 (+102%) |
| zod-1.4-_parse | modification | 40.0% | 50.0% | +0.10 | -13544 (-42%) |
| zod-1.3-parse | explanation | 76.0% | 80.0% | +0.04 | +2316 (+54%) |
| zod-1.5-_parse | localization | 100.0% | 100.0% | +0.00 | +312 (+3%) |
| zod-1.7-parse | explanation | 100.0% | 100.0% | +0.00 | -2361 (-30%) |
| zod-1.8-_parse | modification | 65.0% | 75.0% | +0.10 | -6636 (-34%) |
| zod-7.2-_parse | localization | 100.0% | 100.0% | +0.00 | +586 (+18%) |
| zod-7.3-parse | localization | 100.0% | 80.0% | -0.20 | -1453 (-9%) |
| zod-10.1-_parse | explanation | 100.0% | 100.0% | +0.00 | +238 (+8%) |
| zod-10.3-_parse | explanation | 100.0% | 100.0% | +0.00 | +3637 (+26%) |
| zod-11.2-_parse | modification | 100.0% | 100.0% | +0.00 | +532 (+28%) |
| zod-11.3-_parse | refactoring | 75.0% | 75.0% | +0.00 | -1882 (-41%) |

## Summary

- **Lore better**: 3 tasks
  - zod-1.4-_parse: +0.10 correctness
  - zod-1.3-parse: +0.04 correctness
  - zod-1.8-_parse: +0.10 correctness
- **Equal**: 8 tasks
- **Lore worse**: 2 tasks
  - zod-1.2-parse: -0.20 correctness
  - zod-7.3-parse: -0.20 correctness
