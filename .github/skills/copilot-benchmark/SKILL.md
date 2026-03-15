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
| `BENCHMARK_REPO` | `lore-self` | Target repo. Options: `lore-self`, `zod`, `fastapi`, `esbuild`, `postgres`, `gson`. |
| `BENCHMARK_MODEL` | `claude-opus-4.6` | LLM model passed to copilot CLI `--model`. |
| `BENCHMARK_INDEX_MODE` | `scip` | Lore indexing mode: `tree-sitter`, `scip`, or `full`. |
| `BENCHMARK_ITERATIONS` | `1` | Runs per task. Use `≥3` for statistical significance. |
| `BENCHMARK_EMBEDDING_MODEL` | _(empty)_ | Embedding model, e.g. `nomic-ai/nomic-embed-text-v1.5`. |
| `BENCHMARK_LSP` | _(unset)_ | Set to `1` to enable LSP enrichment during indexing. |

## Instructions

When the user asks to run, execute, or launch a Copilot benchmark:

1. **Pre-flight checks**
   - Ensure Node.js 22 is active: `source ~/.nvm/nvm.sh && nvm use 22`.
   - Build Lore: `npm run build`.
   - Verify `copilot --version` works.

2. **Determine configuration from user request**
   - Pick a repo from the available list. Default is `lore-self`.
   - Pick an index mode. Default is `scip`.
   - Pick iteration count. Default is `1` for quick runs, `3+` for statistical significance.
   - Pick model. Default is `claude-opus-4.6`.

3. **Run the benchmark**
   - Launch as a background process since it runs for 10–20 minutes:
   ```sh
   BENCHMARK_COPILOT=1 \
     BENCHMARK_REPO=lore-self \
     BENCHMARK_INDEX_MODE=scip \
     BENCHMARK_ITERATIONS=1 \
     npx vitest run tests/benchmark/copilot-agent.test.ts
   ```

4. **Monitor progress**
   - The test outputs per-task results as they complete (e.g. `[control] lore-self-1.1-openDb: success=1 correctness=0.85 ...`).
   - 16 tasks run concurrently in pairs (control + lore-enabled), so results arrive in batches.
   - Check the terminal periodically for `N/17` progress.

5. **Interpret results**
   - Per-task output shows: `success`, `correctness`, `ans_cov`, `file_cov`, `sym_cov`, `tokens`, `wall` time.
   - `lore calls:` shows which Lore MCP tools were invoked (or `(none)` if the model chose not to use them).
   - `MISSED parts:` and `MISSED answer lines:` show expected answers that were not covered.
   - The aggregate report at the end compares control vs lore-enabled across all metrics.

6. **Report to the user**
   - Summarize total tasks completed, overall success rates for both arms.
   - Highlight tasks where lore-enabled outperformed control (or vice versa).
   - Note Lore tool usage patterns.
   - Report any tasks that timed out or failed.

## How it works

Each task runs **two concurrent arms**:
- **Control**: Copilot CLI with Lore tools explicitly denied via `--deny-tool`.
- **Lore-enabled**: Copilot CLI with Lore MCP server registered via `--additional-mcp-config`.

Both arms answer the same question about the target codebase, then results are scored against ground-truth expected answers.

## Scoring metrics

- **taskSuccess**: 0 / 0.5 / 1 composite score
- **correctness**: 0–1 line-by-line match against expected answer
- **answerCoverage**: fraction of expected answer parts found
- **fileCoverage**: fraction of expected files referenced
- **symbolCoverage**: fraction of expected symbols mentioned
- **tokensUsed**: estimated token consumption
- **wallTimeMs**: end-to-end wall-clock time
- **loreToolCallCount**: number of `lore_*` tool invocations

## Available repos with ground truth

| Repo | Language | Size | Tasks |
|---|---|---|---|
| `lore-self` | TypeScript | medium | 16 |
| `zod` | TypeScript | small | partial |
| `fastapi` | Python | medium | partial |
| `esbuild` | Go/TypeScript | large | partial |
| `postgres` | C | very-large | partial |

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
- **Timeouts**: Each arm has a 360s timeout. Complex tasks on large repos may time out. Check the model or increase timeout in `CopilotAgentOptions`.
- **`copilot` not found**: Install the Copilot CLI and authenticate first.
