---
name: copilot-benchmark
description: Run the Copilot agent benchmark suite against a target repo. Use when asked to run benchmarks, benchmark Lore, measure Copilot performance, compare control vs lore-enabled, or evaluate tool effectiveness.
---

# Copilot Agent Benchmark

## Purpose

Run Lore's Copilot agent benchmark harness, which evaluates how the Copilot CLI answers codebase questions with and without Lore MCP tools, comparing the two arms on correctness, coverage, and efficiency.

## Prerequisites

- **`copilot` CLI** installed and authenticated (`copilot --version` must work).
- **Node.js 22** (use `nvm use 22`).
- **Lore built** (`npm run build`) — the test `beforeAll` also runs this.
- Real API calls are made — this costs tokens.

## Quick start

```sh
source ~/.nvm/nvm.sh && nvm use 22
npm run build
BENCHMARK_COPILOT=1 npx vitest run tests/benchmark/copilot-agent.test.ts
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `BENCHMARK_COPILOT` | _(unset)_ | **Required.** Set to `1` to enable the suite (skipped otherwise). |
| `BENCHMARK_REPO` | `lore-self` | Target repo. Options: `lore-self`, `zod`, `fastapi`, `esbuild`, `postgres`, `jackson-databind`. |
| `BENCHMARK_MODEL` | `claude-opus-4.6` | LLM model passed to copilot CLI `--model`. |
| `BENCHMARK_INDEX_MODE` | `scip` | Index mode label: `scip` enables SCIP, `full` enables SCIP+LSP, and legacy `tree-sitter` currently produces file snapshots only because tree-sitter has been removed. |
| `BENCHMARK_ITERATIONS` | `1` | Runs per task. Use `≥3` for statistical significance. |
| `BENCHMARK_EMBEDDING_MODEL` | _(empty)_ | Embedding model, e.g. `nomic-ai/nomic-embed-text-v1.5`. |
| `BENCHMARK_LSP` | _(unset)_ | Set to `1` to enable LSP enrichment during indexing. |
| `BENCHMARK_QUESTION` | _(empty)_ | Optional comma-separated question IDs to run. |
| `BENCHMARK_ARM` | _(empty)_ | Optional single-arm filter: `control` or `lore`. |

## Instructions

When the user asks to run, execute, or launch a Copilot benchmark:

1. **Pre-flight checks**
   - Ensure Node.js 22 is active: `source ~/.nvm/nvm.sh && nvm use 22`.
   - Build Lore: `npm run build`.
   - Verify `copilot --version` works.

2. **Determine configuration from user request**
   - Pick a repo from the available list. Default is `lore-self`.
   - Pick an index mode. Default to `scip`; do not use the legacy `tree-sitter` label when structural results are required.
   - Pick iteration count. Default is `1` for quick runs, `3+` for statistical significance.
   - Pick model. Default is `claude-opus-4.6`.

3. **Run the benchmark**
   - Run the benchmark test with the requested environment:
   ```sh
   BENCHMARK_COPILOT=1 \
     BENCHMARK_REPO=lore-self \
     BENCHMARK_INDEX_MODE=scip \
     BENCHMARK_ITERATIONS=1 \
     npx vitest run tests/benchmark/copilot-agent.test.ts
   ```

4. **Monitor progress**
   - The test prints `Tasks: <count>` during setup and one result per arm/task.
   - Up to 11 catalog questions are generated per repo; `BENCHMARK_QUESTION` or missing answer data can reduce the count.
   - Vitest runs task cases concurrently, but each case awaits the control arm before the Lore arm.

5. **Interpret results**
   - Per-task output shows: `success`, `correctness`, `file_cov`, `sym_cov`, `tokens`, and `wall` time.
   - `lore calls:` shows which Lore MCP tools were invoked (or `(none)` if the model chose not to use them).
   - `MISSED parts:` shows expected-answer lines that were not covered.
   - The aggregate report at the end compares control vs lore-enabled across all metrics.
   - A both-arm run writes `.benchmark-results/<repo>.json`.

6. **Report to the user**
   - Summarize total tasks completed, overall success rates for both arms.
   - Highlight tasks where lore-enabled outperformed control (or vice versa).
   - Note Lore tool usage patterns.
   - Report any tasks that timed out or failed.

## How it works

Each task normally runs two arms in sequence inside a concurrent Vitest case:
- **Control**: Copilot CLI with `--allow-all-tools`, but without Lore's MCP configuration.
- **Lore-enabled**: the same CLI flags plus Lore's MCP server registered via `--additional-mcp-config`.

Both arms answer the same question about the target codebase, then results are scored against ground-truth expected answers.

## Scoring metrics

- **taskSuccess**: binary `0 | 1`; success requires correctness ≥ 0.8, file coverage ≥ 0.6, and symbol coverage ≥ 0.6, and timeouts always fail
- **correctness**: 0–1 line-by-line match against expected answer
- **fileCoverage**: fraction of expected files referenced
- **symbolCoverage**: fraction of expected symbols mentioned
- **tokensUsed**: estimated token consumption
- **wallTimeMs**: end-to-end wall-clock time
- **loreToolCallCount**: number of `lore_*` tool invocations

## Available repos with ground truth

| Repo | Language | Size | Tasks |
|---|---|---|---|
| `lore-self` | TypeScript | medium | up to 11 |
| `zod` | TypeScript | small | up to 11 |
| `fastapi` | Python | medium | up to 11 |
| `esbuild` | Go/TypeScript | large | up to 11 |
| `jackson-databind` | Java | medium | up to 11 |
| `postgres` | C | very-large | up to 11 |

## Key files

- `tests/benchmark/copilot-agent.test.ts` — main test file
- `tests/benchmark/util/copilot-agent.ts` — copilot CLI invocation
- `tests/benchmark/util/tasks.ts` — ground truth answer tables
- `tests/benchmark/util/repos.ts` — repo specifications
- `tests/benchmark/util/scorer.ts` — scoring and report formatting
- `tests/benchmark/util/questions.ts` — question catalog and templates
- `tests/benchmark/util/types.ts` — shared types

## Troubleshooting

- **All tests skipped**: `BENCHMARK_COPILOT=1` is not set.
- **`lore calls: (none)` on all tasks**: The Lore MCP server may not be starting. Check that `dist/server/server.js` exists and the `realpathSync` fix is present (commit `ee708f8`). On macOS, symlink mismatches under `/var` can cause silent failures.
- **Timeouts**: Each arm defaults to 360s; `jackson-databind` uses 720s. Each Vitest case allows both arm budgets plus 60s.
- **`copilot` not found**: Install the Copilot CLI and authenticate first.
