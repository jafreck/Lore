# Benchmark Results: jackson-databind

**Repository**: jackson-databind  
**Language**: Java  
**Size**: medium  
**Description**: JSON serialization library  
**Model**: claude-opus-4.6  
**Index mode**: scip  
**Iterations**: 5 per task  
**Tasks**: 13  
**Completed runs**: 65/65  
**Date**: 2026-03-21  

## Aggregate Results

| Metric | Control | Lore-enabled | Delta |
|--------|---------|-------------|-------|
| Success rate | 86.2% | 100.0% | +13.8pp |
| Correctness | 79.5% | 95.5% | +16.1pp |
| Answer coverage | 81.3% | 97.5% | +16.2pp |
| File coverage | 100.0% | 100.0% | +0.0pp |
| Symbol coverage | 100.0% | 100.0% | +0.0pp |
| Mean tokens | 19769 | 7899 | -11870 (-60.0%) |
| Mean wall time | 162.7s | 85.6s | -77.1s (-47.4%) |
| Mean tool calls | 67.7 | 23.9 | -43.9 |
| First-pass accuracy | 0.0% | 52.3% | +52.3pp |
| Lore tool calls/run | — | 3.0 | — |
| Lore tool usage rate | — | 92.3% | — |

**Statistical significance** (Welch's t-test on correctness): t=3.428, df=82.9, p=0.0009 — **Yes** at p<0.05

**Lore tools used**: `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_trace`, `lore_search`

## Per-Task Results

Each task was run 5 times. Values below are means across iterations.

| Task | Category | Control Correctness | Lore Correctness | Delta | Token Δ |
|------|----------|-------------------|-----------------|-------|---------|
| jackson-databind-1.1-reportInputMismatch | localization | 76.4% | 100.0% | +0.24 | -16980 (-97%) |
| jackson-databind-1.2-createCollectionDeserializer | localization | 100.0% | 100.0% | +0.00 | -725 (-66%) |
| jackson-databind-1.4-reportInputMismatch | modification | 0.0% | 100.0% | +1.00 | -79797 (-93%) |
| jackson-databind-1.3-createCollectionDeserializer | explanation | 100.0% | 100.0% | +0.00 | +1987 (+248%) |
| jackson-databind-1.5-reportInputMismatch | localization | 50.0% | 50.0% | +0.00 | -11374 (-63%) |
| jackson-databind-1.7-createCollectionDeserializer | explanation | 100.0% | 100.0% | +0.00 | -4657 (-86%) |
| jackson-databind-1.8-reportInputMismatch | modification | 60.0% | 100.0% | +0.40 | -6538 (-21%) |
| jackson-databind-7.2-reportInputMismatch | localization | 93.3% | 100.0% | +0.07 | +1743 (+11%) |
| jackson-databind-7.3-createCollectionDeserializer | localization | 100.0% | 100.0% | +0.00 | -3295 (-65%) |
| jackson-databind-10.1-reportInputMismatch | explanation | 96.0% | 100.0% | +0.04 | -11399 (-63%) |
| jackson-databind-10.3-reportInputMismatch | explanation | 76.0% | 100.0% | +0.24 | -10241 (-34%) |
| jackson-databind-11.2-reportInputMismatch | modification | 93.3% | 100.0% | +0.07 | -4463 (-27%) |
| jackson-databind-11.3-reportInputMismatch | refactoring | 88.0% | 92.0% | +0.04 | -8569 (-79%) |

## Summary

- **Lore better**: 8 tasks
  - jackson-databind-1.1-reportInputMismatch: +0.24 correctness
  - jackson-databind-1.4-reportInputMismatch: +1.00 correctness
  - jackson-databind-1.8-reportInputMismatch: +0.40 correctness
  - jackson-databind-7.2-reportInputMismatch: +0.07 correctness
  - jackson-databind-10.1-reportInputMismatch: +0.04 correctness
  - jackson-databind-10.3-reportInputMismatch: +0.24 correctness
  - jackson-databind-11.2-reportInputMismatch: +0.07 correctness
  - jackson-databind-11.3-reportInputMismatch: +0.04 correctness
- **Equal**: 5 tasks
- **Lore worse**: 0 tasks
