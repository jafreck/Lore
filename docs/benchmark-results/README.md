# Copilot Benchmark Results Summary

Comparison of Copilot agent performance **with** and **without** Lore MCP tools across multiple repositories.

## Configuration

- **Model**: claude-opus-4.6
- **Index mode**: scip
- **Iterations per task**: 5
- **Date**: 2026-03-20

## Cross-Repository Results

| Repository | Language | Size | Tasks | Control Success | Lore Success | Δ Success | Control Correctness | Lore Correctness | Δ Correctness | Token Δ% | p-value |
|-----------|----------|------|-------|----------------|-------------|-----------|--------------------|-----------------|--------------|---------| --------|
| [lore-self](lore-self.md) | TypeScript | medium | 13 | 84.6% | 92.3% | +7.7pp | 89.3% | 91.5% | +2.2pp | +11.1% | 0.6312 |
| [zod](zod.md) | TypeScript | small | 13 | 92.3% | 92.3% | +0.0pp | 83.3% | 82.1% | -1.2pp | -4.1% | 0.8109 |
| [fastapi](fastapi.md) | Python | medium | 13 | 89.2% | 89.2% | +0.0pp | 82.8% | 82.8% | +0.1pp | -28.3% | 0.9899 |
| [esbuild](esbuild.md) | Go + TypeScript | large | 13 | 47.7% | 47.7% | +0.0pp | 71.0% | 64.3% | -6.7pp | -41.3% | 0.1977 |
| [jackson-databind](jackson-databind.md) | Java | medium | 13 | 86.2% | 100.0% | +13.8pp | 79.5% | 95.5% | +16.1pp | -60.0% | 0.0009 |

## Overall Averages (across all repos)

| Metric | Control | Lore-enabled | Delta |
|--------|---------|-------------|-------|
| Success rate | 80.0% | 84.3% | +4.3pp |
| Correctness | 81.2% | 83.3% | +2.1pp |
| Mean tokens | 8755 | 5561 | -3195 (-36.5%) |
| Mean wall time | 112.5s | 89.6s | -22.9s (-20.4%) |

## Key Findings

### Correctness Impact by Repository (sorted best to worst)

1. **jackson-databind**: +16.1pp ↑
1. **lore-self**: +2.2pp ↑
1. **fastapi**: +0.1pp ↑
1. **zod**: -1.2pp ↓
1. **esbuild**: -6.7pp ↓

### Token Efficiency

- **lore-self**: 11.1% less efficient
- **zod**: 4.1% more efficient
- **fastapi**: 28.3% more efficient
- **esbuild**: 41.3% more efficient
- **jackson-databind**: 60.0% more efficient

### Lore Tool Usage

| Repository | Lore Calls/Run | Usage Rate | Tools Used |
|-----------|---------------|------------|------------|
| lore-self | 2.7 | 100.0% | `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_trace` |
| zod | 9.0 | 100.0% | `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_search`, `lore_trace` |
| fastapi | 4.4 | 100.0% | `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_trace` |
| esbuild | 3.6 | 92.3% | `lore_dependents`, `lore_graph`, `lore_lookup`, `lore_snippet`, `lore_search`, `lore_trace` |
| jackson-databind | 3.0 | 92.3% | `lore_dependents`, `lore_lookup`, `lore_graph`, `lore_snippet`, `lore_trace`, `lore_search` |

### Statistical Significance

Statistically significant improvements (p<0.05) found in: **jackson-databind**

- **lore-self**: t=0.481, p=0.6312 — ✗ Not significant
- **zod**: t=-0.240, p=0.8109 — ✗ Not significant
- **fastapi**: t=0.013, p=0.9899 — ✗ Not significant
- **esbuild**: t=-1.295, p=0.1977 — ✗ Not significant
- **jackson-databind**: t=3.428, p=0.0009 — ✓ Significant

## Detailed Results

- [lore-self](lore-self.md) — TypeScript, medium
- [zod](zod.md) — TypeScript, small
- [fastapi](fastapi.md) — Python, medium
- [esbuild](esbuild.md) — Go + TypeScript, large
- [jackson-databind](jackson-databind.md) — Java, medium
