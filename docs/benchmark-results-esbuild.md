# Benchmark Results: Lore vs Baseline — esbuild

**Date:** 2026-03-13

**Model:** claude-opus-4.6 (via GitHub Copilot CLI)

**Target repo:** esbuild @ `d50e88c0`

**Iterations:** 1 per task (12 total runs)

## Aggregate Summary

> **Important:** These results were scored against incorrect expected answers.
> After ground-truth investigation (see below), 8 of 12 expected answers were
> found to be wrong or incomplete. Correctness scores should be re-evaluated
> with the corrected answers in `tasks.ts`. The raw agent outputs and
> timing/token metrics remain valid.

| Metric | Control | Lore-enabled | Delta |
|---|---|---|---|
| **Mean correctness** | 38.9% | 38.9% | 0.0pp |
| **First-pass accuracy** | 25.0% | **66.7%** | **+41.7pp** |
| **Success rate** | 50.0% | 41.7% | -8.3pp |
| **Mean tool calls** | 25.8 | 22.3 | -3.5 (-14%) |
| **Mean tokens** | 7,938 | **7,072** | **-866 (-10.9%)** |
| **Mean wall time** | 151.5s | 177.9s | +26.4s (+17.4%) |
| **Answer coverage** | 58.3% | 48.6% | -9.7pp |
| **File coverage** | 91.7% | 87.5% | -4.2pp |
| **Symbol coverage** | 95.8% | 95.8% | 0.0pp |
| **Lore tool usage** | 0% of runs | **83% of runs** | — |

## Per-Task Detail

| Task | Prompt | Ctrl Corr | Lore Corr | Δ Corr | Ctrl Tok | Lore Tok | Tok Δ | Ctrl Wall | Lore Wall | Wall Δ |
|---|---|---|---|---|---|---|---|---|---|---|
| **1.1** | Direct callers of `Build` | 0.00 | 0.00 | 0.00 | 3,465 | 397 | **-89%** | 57.8s | 33.6s | **-42%** |
| **1.2** | Direct callees of `rebuildImpl` | 0.33 | 0.33 | 0.00 | 2,963 | 539 | **-82%** | 86.3s | 32.8s | **-62%** |
| **1.4** | Blast radius of `rebuildImpl` (3-hop) | **1.00** | **1.00** | 0.00 | 15,433 | 16,698 | +8% | 186.4s | 217.6s | +17% |
| **2.1** | Implementors of `Plugin` interface | 0.00 | 0.00 | 0.00 | 8,650 | 17,268 | +100% | 155.3s | 310.2s | +100% |
| **4.1** | Test files for `api_impl.go` | **1.00** | **1.00** | 0.00 | 8,253 | 374 | **-95%** | 108.7s | 33.9s | **-69%** |
| **6.1** | Top 5 by cyclomatic complexity | 0.00 | 0.00 | 0.00 | 9,565 | 178 | **-98%** | 203.3s | 21.1s | **-90%** |
| **7.2** | Cross-file consumers of `Plugin` type | 0.00 | 0.00 | 0.00 | 2,503 | 4,625 | +85% | 52.2s | 108.8s | +108% |
| **8.1** | Circular import dependencies | **1.00** | **1.00** | 0.00 | 4,256 | 6,396 | +50% | 96.5s | 304.7s | +216% |
| **3.3** | Top-level module dependency graph | 0.33 | 0.33 | 0.00 | 25,946 | 16,523 | **-36%** | 317.2s | 246.6s | **-22%** |
| **10.2** | Top 3 most-called functions in `api_impl.go` | 0.00 | 0.00 | 0.00 | 3,141 | 9,768 | +211% | 155.8s | 360.0s | +131% |
| **11.1** | Tests + coverage + reviewer for `rebuildImpl` | **1.00** | **1.00** | 0.00 | 3,961 | 2,996 | **-24%** | 136.6s | 105.7s | **-23%** |
| **11.4** | Exported symbol consumers if `api_impl.go` deleted | 0.00 | 0.00 | 0.00 | 7,125 | 9,104 | +28% | 262.5s | 360.0s | +37% |

> **Note:** Tool counts exclude `report_intent` calls (present in every run) for readability.

### Lore Index Configuration

| Setting | Value |
|---|---|
| Index mode | SCIP (primary) + tree-sitter (fallback + metrics) |
| Languages | Go, TypeScript |
| Embedding model | None (embeddings disabled for benchmark) |
| LSP enrichment | Disabled |
| History depth | 100 commits |
| Docs auto-notes | Enabled |
| Index dependencies | Disabled |
| Index time | ~8,634 ms |

### Copilot CLI Configuration

| Setting | Value |
|---|---|
| `BENCHMARK_COPILOT` | `1` |
| `BENCHMARK_REPO` | `esbuild` |
| `BENCHMARK_MODEL` | `claude-opus-4.6` |
| `BENCHMARK_INDEX_MODE` | `scip` |
| `BENCHMARK_ITERATIONS` | `1` |
| Per-task timeout | 360 s |
| Control arm | Copilot CLI with `--add-dir` only |
| Lore-enabled arm | Copilot CLI with Lore MCP server (`--additional-mcp-config`) |

### Tool Usage Breakdown

| Arm | Tool | Calls |
|---|---|---|
| Control | `bash` | 207 |
| Control | `view` | 50 |
| Control | `grep` | 24 |
| Control | `task` | 9 |
| Control | `glob` | 8 |
| Lore | `bash` | 113 |
| Lore | `view` | 77 |
| Lore | `grep` | 35 |
| Lore | `lore_lookup` | 10 |
| Lore | `lore_graph` | 5 |
| Lore | `task` | 4 |
| Lore | `lore_blame` | 3 |
| Lore | `lore_search` | 2 |
| Lore | `lore_snippet` | 2 |
| Lore | `lore_test_map` | 2 |
| Lore | `glob` | 2 |
| Lore | `lore_metrics` | 1 |

---

## Per-Task Notes

**Q1.1 — Callers of `Build`:** Lore calls: `lore_lookup(kind=symbol, query=Build, mode=exact)` → `lore_graph(kind=call, target_id=2310, compact=true)`. Both arms found `runImpl` but missed `rebuildImpl`. The expected answer includes `main` and `rebuildImpl` which are call sites in separate packages. Both scored 0.00 correctness. Lore used 89% fewer tokens.

**Q1.2 — Callees of `rebuildImpl`:** Lore calls: `lore_lookup(kind=symbol, query=rebuildImpl)` → `lore_graph(kind=call, source_id=2392, compact=true)`. Both arms returned a large list of low-level Go stdlib callees (e.g., `logger.NewStderrLog`, `fs.RealFS`, `bundler.ScanBundle`). Only `buildImpl` from the expected parts was matched (0.33). Lore used 82% fewer tokens.

**Q1.4 — Blast radius of `rebuildImpl` (3-hop):** Both arms scored 1.00. Both used extensive bash exploration to trace callers across `pkg/api/`. Lore used `lore_graph(kind=call, target_id=2392, depth=3)` plus additional bash verification, resulting in slightly more tokens (+8%).

**Q2.1 — Implementations of `Plugin`:** Both arms scored 0.00 — Go uses structural typing, so there are no explicit `implements Plugin` declarations. Control correctly identified "no classes explicitly implement Plugin" via grep. Lore found `pluginImpl` and `BuildPlugin` via `lore_graph(kind=inheritance)` plus extensive bash/grep exploration, using 2× more tokens. The expected answer ("Plugin implementations") was too vague for either arm to match.

**Q4.1 — Test files for `api_impl.go`:** Both scored 1.00. Control used 31 bash commands to discover test files; Lore used a single `lore_test_map(source_path=pkg/api/api_impl.go)` call. **Lore used 95% fewer tokens and was 69% faster** — the clearest win in this benchmark.

**Q6.1 — Top 5 by cyclomatic complexity:** Both scored 0.00 correctness because the expected answer just says "complexity" (a placeholder). Lore: single `lore_metrics(limit=5)` call → `handlePlugins`, `flagsForBuildOptions`, `createChannel`, `buildOrContextImpl`, `pushCommonFlags`. Control used 20 bash commands to scan Go files. Lore used **98% fewer tokens and was 90% faster**.

**Q7.2 — Cross-file consumers of `Plugin` type:** Both scored 0.00. Control found 7 consumers via grep (e.g., `Run`, `RunWithPlugins`, `addAnalyzePlugin`). Lore used `lore_lookup` + `lore_search` but relied heavily on view/grep fallback (13 view + 7 grep calls). Expected answers (`Build → pkg/api/api.go`, `rebuildImpl → pkg/api/api_impl.go`) were not matched by either arm. The Plugin type is ubiquitous in esbuild, making precise consumer tracing difficult.

**Q8.1 — Circular import dependencies:** Both correctly answered "None." Lore used `lore_graph(kind=import, compact=true, limit=200)` but then also ran 8 bash commands to verify the result, making it 216% slower than control (which used 6 bash invocations alone). Control finished in 96s vs Lore's 305s.

**Q3.3 — Module dependency summary:** Both scored 0.33. The expected answer uses `pkg/` prefixes (`pkg/api`, `pkg/bundler`, `pkg/js_parser`) but esbuild's actual Go package structure uses `internal/` prefixes. Both arms correctly found the real structure (`cmd/esbuild → pkg/api, pkg/cli`, `pkg/api → internal/*`) but this didn't match the expected format. Lore didn't use any Lore tools — fell back entirely to bash (16 commands). The lore-enabled test assertion failed because no Lore tools were called.

**Q10.2 — Call fan-in ranking for `api_impl.go`:** Both scored 0.00. Control found `rebuild` / `Rebuild` / `Watch` as most-called (reasonable answers). Lore used `lore_lookup` twice but timed out at 360s with an empty answer. The expected answer (`rebuildImpl`, `serveImpl`) may need revision — these are internal functions called from `api.go`, while the agent found the public-facing wrapper methods.

**Q11.1 — Tests + coverage + reviewer for `rebuildImpl`:** Both scored 1.00. Both found `pkg/api/api_impl_test.go`, `pkg/api/api_test.go` as test files, noted 0% direct coverage, and identified **Evan Wallace** as the reviewer. Lore used `lore_test_map` + `lore_blame` + `lore_lookup` for a more structured approach with 24% fewer tokens.

**Q11.4 — Exported symbols from `api_impl.go` + consumers:** Both scored 0.00. Control correctly identified that `api_impl.go` has **no exported symbols** — all functions are package-private (lowercase in Go). This is a valid insight that the expected answer doesn't account for: `rebuildImpl` and `serveImpl` are unexported. The expected answer needs revision for Go's visibility rules. Lore didn't use any Lore tools and timed out. The lore-enabled test assertion failed.

---

## Key Observations

### Where Lore excels on esbuild

1. **First-pass accuracy (+41.7pp):** Lore reaches the right files and symbols on the first tool call far more consistently (66.7% vs 25.0%).
2. **Test mapping (Q4.1):** The single `lore_test_map` call is 95% more token-efficient than bash-based test discovery. This is Lore's clearest win.
3. **Complexity ranking (Q6.1):** `lore_metrics(limit=5)` answers instantly (98% fewer tokens, 90% less time) vs scanning Go source files with bash.
4. **Composite queries (Q11.1):** Chaining `lore_test_map` + `lore_blame` produces structured results with 24% fewer tokens.
5. **Callees/callers (Q1.1, Q1.2):** 82–89% token savings, even when correctness is equal.

### Where Lore struggles on esbuild

1. **Go structural typing (Q2.1):** Lore's inheritance graph looks for explicit `implements` relationships that don't exist in Go. The agent over-explored (17k tokens) trying to find something the language doesn't express.
2. **Package-private symbols (Q11.4):** Go's visibility rules (lowercase = unexported) mean `rebuildImpl`/`serveImpl` aren't "exported symbols" in Go's sense. The expected answers need Go-specific revision.
3. **Verification overhead (Q8.1):** On "None" answers, the Lore agent distrusted the graph result and ran extensive bash verification, tripling wall time with no correctness gain.
4. **Lore tool avoidance (Q3.3, Q11.4):** On 2 of 12 tasks, the agent chose not to use Lore tools at all, falling back entirely to bash. This suggests the agent's tool selection heuristic doesn't always favor Lore for Go codebases.
5. **Fan-in queries on large files (Q10.2):** `lore_lookup` returned data but the agent struggled to aggregate and format it, timing out at 360s.

### Cross-repo comparison: esbuild vs lore-self

| Metric | lore-self (TS, 3 iters) | esbuild (Go/TS, 1 iter) |
|---|---|---|
| Correctness (Ctrl) | 68.0% | 38.9% |
| Correctness (Lore) | 66.2% | 38.9% |
| First-pass accuracy delta | +47.2pp | +41.7pp |
| Token savings | -80.9% | -10.9% |
| Wall time delta | -24.1% | +17.4% |
| Lore tool usage | 100% | 83% |

**Key differences:** Lore's token savings are dramatically lower on esbuild (-10.9% vs -80.9% on lore-self). This is driven by Go-specific challenges: the agent falls back to bash more often, doesn't trust Lore graph results for Go's structural typing, and the expected answers need language-specific tuning. The first-pass accuracy gain remains strong (+41.7pp), indicating Lore's index correctly identifies relevant symbols/files even in Go codebases.

### Expected answer corrections applied

Ground-truth investigation at the pinned SHA (`d50e88c0`) revealed that 8 of 12 expected answers were incorrect. All corrections have been applied to `tasks.ts`. Summary of changes:

| Task | What was wrong | Corrected answer |
|---|---|---|
| **1.1** | Expected `main`, `rebuildImpl` — neither calls `Build()` | `handleBuildRequest` (service.go), `runImpl` (cli_impl.go) |
| **1.2** | Expected `buildImpl`, `compileResult` — neither exists | `ScanBundle`, `Compile`, `cloneMangleCache`, `HasErrors`, etc. |
| **2.1** | Expected "Plugin implementations" — but Plugin is a struct | "None — Plugin is a struct, not an interface" |
| **6.1** | Placeholder "complexity" | `handlePlugins` (cc=65), `flagsForBuildOptions` (cc=53), `createChannel` (cc=49), `buildOrContextImpl` (cc=44), `pushCommonFlags` (cc=43) |
| **7.2** | Expected `Build`, `rebuildImpl` as consumers | `runImpl`, `RunWithPlugins`, `addAnalyzePlugin`, `convertPlugins`, `loadPlugins`, `handleBuildRequest` |
| **3.3** | Expected `pkg/bundler`, `pkg/js_parser` etc. — don't exist | Correct: `cmd/esbuild → pkg/api, pkg/cli, internal/*`, `pkg/api → internal/bundler, internal/js_parser, ...` |
| **10.2** | Expected `rebuildImpl`, `serveImpl` as most-called | `contextImpl` (called 2× from api.go), `transformImpl`, `printSummary` |
| **11.4** | Expected `rebuildImpl → api.go` | `contextImpl → api.go`, `transformImpl → api.go`, `printSummary → api.go`, etc. (all lowercase = package-private) |

**Methodology:** Cloned esbuild at `d50e88c0`, verified each answer with `grep` + `awk` to find enclosing functions, and queried Lore's `symbol_metrics` table for complexity data. Lore only indexes TS/JS files for complexity; Go complexity metrics are not yet available.

Running with `BENCHMARK_ITERATIONS=3` and these corrected answers would provide statistically meaningful results.

## Full Prompts

### Task 1.1 — Direct Callers

> What functions or methods directly call `Build`? Answer with ONLY a newline-separated list of function/method names, nothing else. Example format:
> foo
> bar
> baz

### Task 1.2 — Direct Callees

> What does the function/method `rebuildImpl` call? Answer with ONLY a newline-separated list of the direct callee function/method names, nothing else.

### Task 1.4 — Blast Radius

> If I change the function `rebuildImpl` in `pkg/api/api_impl.go`, what is the blast radius? Use transitive dependency analysis if available (follow callers of callers, up to 3 hops). Answer with ONLY a newline-separated list of files and functions that transitively depend on it, nothing else.

### Task 2.1 — Interface Implementations

> What classes or types implement the interface `Plugin`? Answer with ONLY a newline-separated list of class/type names, nothing else.

### Task 4.1 — Test Mapping

> What test files should I run after modifying `pkg/api/api_impl.go`? Answer with ONLY a newline-separated list of test file paths relative to the repo root, nothing else.

### Task 6.1 — Complexity Ranking

> What are the 5 most complex functions in this codebase, ranked by cyclomatic complexity? Use pre-indexed complexity metrics if available rather than scanning source files. Answer with ONLY a numbered list of function names, one per line, in descending order. Example format:
> 1. foo
> 2. bar
> 3. baz
> 4. qux
> 5. quux

### Task 7.2 — Cross-file Type Consumers

> What functions across the codebase directly consume or reference the type/interface `Plugin` defined in `pkg/api/api.go`? List only functions in OTHER files (not the file where it is defined). Answer with ONLY a newline-separated list in the format "function → file", nothing else. Example format:
> foo → src/bar.ts
> baz → src/qux.ts

### Task 8.1 — Circular Dependencies

> Are there any circular dependencies (import cycles) between source files in this codebase? Answer with ONLY a list of the cycle(s), each on its own line showing the file loop (e.g. "a.ts → b.ts → a.ts"), or "None" if the codebase is acyclic.

### Task 3.3 — Module Dependency Summary

> What are the top-level modules/packages in this codebase and how do they depend on each other? Answer with ONLY a newline-separated list, one module per line, in the exact format below. Use module paths relative to the repo root (e.g. src/indexer, lib/router, pkg/api). List dependencies as comma-separated paths, or (none) if there are no internal dependencies. Include every module, even those with no dependencies. Nothing else in the answer.
> Example format:
> src/module_a → src/module_b, src/module_c
> src/module_b → (none)

### Task 10.2 — Call Fan-in Ranking

> Which functions in `pkg/api/api_impl.go` are called from the most distinct source files? Rank the top 3 by number of unique calling files (exclude test files). Answer with ONLY a numbered list in the format "name — N files: file1, file2, ...", nothing else. Example format:
> 1. foo — 4 files: src/a.ts, src/b.ts, src/c.ts, src/d.ts
> 2. bar — 3 files: src/a.ts, src/e.ts, src/f.ts
> 3. baz — 2 files: src/a.ts, src/g.ts

### Task 11.1 — Tests + Coverage + Reviewer

> I need to modify `rebuildImpl` in `pkg/api/api_impl.go`. What test files should I run, what is the coverage of those test paths, and who should review the change? Answer with ONLY three lines:
> 1. Test files (comma-separated paths)
> 2. Coverage percentage
> 3. Reviewer name

### Task 11.4 — Deletion Impact

> If I deleted `pkg/api/api_impl.go`, what exported symbols from that file are used elsewhere in the codebase, and which source files (not test files) use each one? Answer with ONLY a newline-separated list in the exact format below, nothing else. Use file paths relative to the repo root. Only include symbols that are actually imported or referenced by other source files.
> Example format:
> MyFunction → path/to/consumer1.ts, path/to/consumer2.ts
> MyType → path/to/consumer3.ts
