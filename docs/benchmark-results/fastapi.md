# Benchmark Results: fastapi

**Repository**: fastapi  
**Language**: Python  
**Size**: medium  
**Description**: Python web framework  
**Model**: claude-opus-4.6  
**Index mode**: scip  
**Iterations**: 5 per task  
**Tasks**: 13  
**Completed runs**: 65/65  
**Date**: 2026-03-21  

## Aggregate Results

| Metric | Control | Lore-enabled | Delta |
|--------|---------|-------------|-------|
| Success rate | 89.2% | 89.2% | +0.0pp |
| Correctness | 82.8% | 82.8% | +0.1pp |
| Answer coverage | 81.8% | 83.7% | +1.9pp |
| File coverage | 100.0% | 100.0% | +0.0pp |
| Symbol coverage | 100.0% | 100.0% | +0.0pp |
| Mean tokens | 4377 | 3140 | -1237 (-28.3%) |
| Mean wall time | 79.4s | 64.4s | -15.0s (-18.9%) |
| Mean tool calls | 15.9 | 9.4 | -6.5 |
| First-pass accuracy | 0.0% | 50.8% | +50.8pp |
| Lore tool calls/run | — | 4.4 | — |
| Lore tool usage rate | — | 100.0% | — |

**Statistical significance** (Welch's t-test on correctness): t=0.013, df=124.9, p=0.9899 — **No** at p<0.05

**Lore tools used**: `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_trace`

## Per-Task Results

Each task was run 5 times. Values below are means across iterations.

| Task | Category | Control Correctness | Lore Correctness | Delta | Token Δ |
|------|----------|-------------------|-----------------|-------|---------|
| fastapi-1.1-solve_dependencies | localization | 90.0% | 50.0% | -0.40 | -1108 (-80%) |
| fastapi-1.2-add_api_route | localization | 45.0% | 65.0% | +0.20 | +238 (+20%) |
| fastapi-1.4-solve_dependencies | modification | 46.7% | 60.0% | +0.13 | -18304 (-97%) |
| fastapi-1.3-add_api_route | explanation | 83.3% | 96.7% | +0.13 | +3280 (+267%) |
| fastapi-1.5-solve_dependencies | localization | 93.3% | 100.0% | +0.07 | +3938 (+34%) |
| fastapi-1.7-add_api_route | explanation | 96.0% | 100.0% | +0.04 | -6353 (-70%) |
| fastapi-1.8-solve_dependencies | modification | 100.0% | 100.0% | +0.00 | -209 (-4%) |
| fastapi-7.2-solve_dependencies | localization | 100.0% | 90.0% | -0.10 | +103 (+7%) |
| fastapi-7.3-add_api_route | localization | 66.7% | 100.0% | +0.33 | -197 (-18%) |
| fastapi-10.1-solve_dependencies | explanation | 93.3% | 66.7% | -0.27 | +179 (+6%) |
| fastapi-10.3-solve_dependencies | explanation | 95.0% | 75.0% | -0.20 | +1909 (+232%) |
| fastapi-11.2-solve_dependencies | modification | 66.7% | 73.3% | +0.07 | -128 (-9%) |
| fastapi-11.3-solve_dependencies | refactoring | 100.0% | 100.0% | +0.00 | +577 (+60%) |

## Summary

- **Lore better**: 7 tasks
  - fastapi-1.2-add_api_route: +0.20 correctness
  - fastapi-1.4-solve_dependencies: +0.13 correctness
  - fastapi-1.3-add_api_route: +0.13 correctness
  - fastapi-1.5-solve_dependencies: +0.07 correctness
  - fastapi-1.7-add_api_route: +0.04 correctness
  - fastapi-7.3-add_api_route: +0.33 correctness
  - fastapi-11.2-solve_dependencies: +0.07 correctness
- **Equal**: 2 tasks
- **Lore worse**: 4 tasks
  - fastapi-1.1-solve_dependencies: -0.40 correctness
  - fastapi-7.2-solve_dependencies: -0.10 correctness
  - fastapi-10.1-solve_dependencies: -0.27 correctness
  - fastapi-10.3-solve_dependencies: -0.20 correctness
