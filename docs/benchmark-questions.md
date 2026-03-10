# Benchmark Questions: Lore's Unique Value

Questions that Lore's DB can answer but agents cannot easily answer through
semantic search or grep alone. These form the basis for demonstrating Lore's
measurable value-add.

The organizing principle: **every question below requires either resolved
structural relationships, cross-table joins, computed graph properties, or
aggregated metrics** — none of which are available from text matching or
embedding similarity alone.

---

## Why these questions are hard without Lore

| Capability | Grep | Semantic search | Lore |
|---|---|---|---|
| Distinguish a real call site from a comment/string mention | No — returns all textual matches | Somewhat — ranks by relevance but can't guarantee precision | Yes — resolved `symbol_refs` with `resolution_method` |
| Transitive call graph traversal | No | No | Yes — multi-hop walk over `symbol_refs` |
| Exhaustive "all implementors of interface X" | Unreliable — misses renamed re-exports, indirect patterns | Approximate — may miss or hallucinate | Yes — `symbol_relationships` with `relationship_type` |
| Test → source file mapping | Heuristic (name matching) | No structural basis | Yes — `test_mappings` with confidence scores |
| Symbol-level coverage | No | No | Yes — `coverage_lines` joined with `symbols` line ranges |
| Cyclomatic complexity ranking | No | No | Yes — `symbol_metrics` table |
| Import cycle detection | No | No | Yes — Tarjan's SCC on `file_imports` graph |
| Ownership distribution | Requires running `git blame` + manual aggregation | No | Yes — pre-indexed `commits` + `commit_files` |
| API route → handler → callee chain | Fragile pattern matching | Hit or miss | Yes — `api_routes` → `symbols` → `symbol_refs` |
| "What changed since coverage was measured" | No | No | Yes — `coverage_runs.commit_sha` vs current HEAD |

---

## Question catalog

### Category 1 — Call Graph & Impact Analysis

These require resolved `symbol_refs` with `callee_id` pointing to actual symbol
definitions, not textual mentions.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 1.1 | What functions directly call `{symbol}`? | `lore_graph(kind=call, direction=inbound)` | `symbol_refs` → `symbols` → `files` | Grep returns mentions in comments, strings, imports — not just call sites. No resolution to definition. |
| 1.2 | What does `{symbol}` call? (its callee fan-out) | `lore_graph(kind=call, direction=outbound)` | `symbol_refs` → `symbols` → `files` | Same noise problem in reverse. Nested calls inside closures are invisible to text search. |
| 1.3 | What is the full transitive call chain from `{A}` to `{B}`? | `lore_graph` (iterated) | `symbol_refs` multi-hop | Requires graph traversal — no text operation produces a path. |
| 1.4 | If I change `{symbol}`, what is the blast radius? (transitive callers) | `lore_graph` (iterated inbound) | `symbol_refs` multi-hop | Grep finds direct mentions only; misses indirect callers of callers. |
| 1.5 | Which symbols have the highest in-degree? (most-called functions) | `lore_metrics` + `lore_graph` | `symbol_refs` aggregation | Requires counting resolved edges, not text occurrences. |
| 1.6 | Are there any dead functions? (defined but never called) | `lore_graph` + `lore_lookup` | `symbols` LEFT JOIN `symbol_refs` WHERE callee_id IS NULL | Grep "finds" the definition but can't prove no call exists. |

### Category 2 — Type Hierarchy & Inheritance

These require `symbol_relationships` with `relationship_type` (extends,
implements, mixes_in, etc.) resolved to concrete symbol IDs.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 2.1 | What classes implement interface `{I}`? | `lore_graph(kind=inheritance)` | `symbol_relationships` | Grep finds `implements I` textually but misses transitive or re-exported implementations, renamed imports, and differs by language syntax. |
| 2.2 | What is the full inheritance chain for class `{C}`? | `lore_graph(kind=inheritance)` (iterated) | `symbol_relationships` multi-hop | Requires transitive graph walk. |
| 2.3 | What types does `{symbol}` depend on? (parameter types, return type, field types) | `lore_graph(kind=type_dependency)` | `type_refs` → `symbols` | Grep finds type names as text but can't attribute them to a specific symbol's dependencies. |
| 2.4 | What symbols use type `{T}` as a parameter, return, or field type? | `lore_graph(kind=type_dependency, direction=inbound)` | `type_refs` WHERE type_name = T | Requires resolved type references, not textual mentions. |

### Category 3 — Import Graph & Module Structure

These require the resolved `file_imports` graph and `modules`/`file_modules`
tables.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 3.1 | What files does `{file}` import (resolved to actual paths)? | `lore_graph(kind=import)` | `file_imports` → `files` | Grep finds import statements but can't resolve `../utils` or `@scope/package` to actual indexed file paths. |
| 3.2 | What files import `{file}`? (reverse dependency) | `lore_graph(kind=import, direction=inbound)` | `file_imports` WHERE resolved_id = target | Grep can approximate this but is fragile across re-exports, barrel files, and aliased imports. |
| 3.3 | Are there circular import dependencies? If so, which files? | `lore_graph` + cycle detection | `file_imports` Tarjan SCC | Requires graph algorithm — no text operation can detect cycles. |
| 3.4 | What is the topological build order of the codebase? | (internal to indexer) | `file_imports` Kahn's algorithm | Graph algorithm, not searchable. |
| 3.5 | What external packages does the `{component}` use? | `lore_architecture` | `external_deps` → `files` grouped by path prefix | Grep finds import statements but can't distinguish local from external, compute per-component aggregation, or know what's an external package vs. a workspace module. |
| 3.6 | Which component has the most inbound import edges? (most depended-on) | `lore_architecture` | `file_imports` + path-prefix grouping | Requires aggregation over resolved import graph. |

### Category 4 — Test Mapping

These require the `test_mappings` table, which links test files to source files
with confidence scores derived from import analysis, naming conventions, and
structural heuristics.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 4.1 | What test files should I run after modifying `{source_file}`? | `lore_test_map` | `test_mappings` | Grep can find files with similar names but can't reliably map source→test when naming conventions differ, tests are in a separate tree, or multiple test files cover one source. |
| 4.2 | Does `{source_file}` have any mapped tests? | `lore_test_map` | `test_mappings` | Same — existence check requires structural mapping. |
| 4.3 | Which source files have NO test mappings? (untested files) | `lore_test_map` (iterated) or `lore_metrics` | `files` LEFT JOIN `test_mappings` | Grep can't produce a reliable "these files have no tests" list. |
| 4.4 | What is the average test mapping confidence across the codebase? | `lore_metrics` | `test_mappings` aggregation | Requires computed confidence scores that don't exist in source text. |

### Category 5 — Coverage × Structure

These require joining `coverage_lines`/`coverage_files` with `symbols` line
ranges — something only possible with pre-indexed structural data.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 5.1 | What is the line coverage of function `{symbol}`? | `lore_coverage` | `coverage_lines` + `symbols` (line range join) | Coverage data isn't in source text. Even if coverage reports exist, mapping report lines to symbol boundaries requires the symbol table. |
| 5.2 | Which specific lines in `{symbol}` are NOT covered? | `lore_coverage` | `coverage_lines` WHERE hit_count=0 within symbol range | Same — requires coverage data + symbol boundaries. |
| 5.3 | What are the most complex functions that have LOW coverage? (risk hotspots) | `lore_coverage` + `lore_metrics(mode=complexity)` | `symbol_metrics` + `coverage_lines` | Requires joining two computed tables neither of which exists in source text. |
| 5.4 | Is the coverage data stale? How many commits behind? | `lore_coverage` | `coverage_runs.commit_sha` vs HEAD | Requires metadata comparison — not in source files. |
| 5.5 | What is the overall project coverage? Per-file breakdown? | `lore_coverage` | `coverage_files` aggregation | Requires ingested coverage data with structural aggregation. |

### Category 6 — Complexity & Code Health

These require pre-computed `symbol_metrics` (cyclomatic complexity, nesting
depth, parameter count, line count).

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 6.1 | What are the N most complex functions in the codebase? | `lore_metrics(mode=complexity)` | `symbol_metrics` ORDER BY cyclomatic DESC | Cyclomatic complexity requires AST analysis — it's a computed property, not searchable text. |
| 6.2 | Which functions exceed a cyclomatic complexity threshold of K? | `lore_metrics(mode=complexity, min_cyclomatic=K)` | `symbol_metrics` WHERE cyclomatic >= K | Same. |
| 6.3 | What functions have the deepest nesting? | `lore_metrics(mode=complexity)` sorted by max_nesting | `symbol_metrics` ORDER BY max_nesting DESC | Nesting depth is computed from AST, not present in text. |
| 6.4 | What is the average complexity per module/component? | `lore_metrics` + `lore_architecture` | `symbol_metrics` + `file_modules` | Requires aggregation across two structural tables. |
| 6.5 | Which functions have high complexity AND many callers? (fragile hotspots) | `lore_metrics` + `lore_graph` | `symbol_metrics` + `symbol_refs` aggregation | Requires joining complexity data with call graph degree. |

### Category 7 — History + Structure Fusion

These require cross-referencing `commits`/`commit_files` with the symbol/file
graph — something that requires both indexed git metadata and structural
knowledge.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 7.1 | Who is the likely domain expert for `{file}` or `{directory}`? | `lore_blame(mode=ownership)` | `commits` + `commit_files` aggregated by author | Requires running blame + aggregating ownership shares. Grep can't do this. |
| 7.2 | What is the ownership distribution for `{component}`? (bus factor) | `lore_blame(mode=ownership)` | commit ownership aggregation | Ownership dispersion and bus factor are computed properties. |
| 7.3 | What files have changed the most in the last N commits? (churn hotspots) | `lore_history(mode=recent)` + file aggregation | `commit_files` grouped by file_path | Requires aggregation over indexed commit data. |
| 7.4 | Is `{file}` high-risk? (recently changed, many authors, high churn) | `lore_blame(mode=ownership)` | risk signals from blame aggregation | Composite risk score requires multiple aggregated signals. |
| 7.5 | What commits touched both `{file_A}` and `{file_B}`? (co-change coupling) | `lore_history` | `commit_files` self-join | Requires set intersection over commit-file associations. |
| 7.6 | What was the last commit that modified function `{symbol}`? | `lore_blame(mode=history)` + symbol resolution | blame + `symbols` line range | Requires mapping a symbol name to its line range, then querying line-level history. |
| 7.7 | Find commits related to "{natural language description}" | `lore_history(mode=semantic)` | `commit_embeddings` vec0 | Semantic search over commit messages — grep can find keywords but can't match conceptual intent. |

### Category 8 — API Route Intelligence

These require the `api_routes` table which maps HTTP method + path → handler
function → source file, extracted from framework-specific patterns.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 8.1 | What API endpoints does this codebase expose? | `lore_routes` | `api_routes` | Grep can find route decorators/registrations but can't reliably extract method+path+handler across different frameworks (Express, FastAPI, Gin, etc.). |
| 8.2 | What handler function processes `{METHOD} {path}`? | `lore_routes(method, path_prefix)` | `api_routes` → `symbols` | Requires structured route extraction, not text matching. |
| 8.3 | What is the full call chain from `POST /users` through to the database layer? | `lore_routes` → `lore_graph(kind=call)` (iterated) | `api_routes` → `symbol_refs` multi-hop | Requires chaining route lookup → handler → call graph traversal. Two structural queries that grep can't compose. |
| 8.4 | What middleware is applied to routes under `{path_prefix}`? | `lore_routes(path_prefix)` | `api_routes.middleware` | Middleware chains are framework-specific and often applied implicitly — not greppable. |
| 8.5 | Are there any routes with no test coverage? | `lore_routes` + `lore_coverage` | `api_routes` → `symbols` → `coverage_lines` | Requires joining three tables: routes, symbols, coverage. |

### Category 9 — Architecture Overview

These require aggregation across the full `files`, `symbols`, `file_imports`,
`modules`, `external_deps`, and `docs` tables — a whole-codebase view.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 9.1 | What are the high-level components of this codebase and how do they relate? | `lore_architecture` | all structural tables aggregated | Architecture is emergent from import/module/symbol structure — not greppable. |
| 9.2 | Which components are entry points (nothing depends on them internally)? | `lore_architecture` | `file_imports` inbound degree = 0 | Requires computing in-degree across the import graph. |
| 9.3 | Which components are leaf nodes (they depend on no other internal components)? | `lore_architecture` | `file_imports` outbound degree = 0 | Same — requires out-degree computation. |
| 9.4 | What documentation exists for each component? | `lore_architecture` + `lore_docs` | `docs` + path-prefix grouping | Documentation density per component requires structural aggregation. |
| 9.5 | How large is this codebase? (files, symbols, import edges, per-language breakdown) | `lore_metrics(mode=aggregate)` | COUNT over multiple tables | Precise counts with structural breakdown — not a search problem. |

### Category 10 — Annotation Intelligence

These require the `annotations` table with symbol linkage.

| # | Question | Lore tools | DB tables | Why grep/semantic fails |
|---|----------|------------|-----------|------------------------|
| 10.1 | What are all TODOs/FIXMEs in `{component}`, grouped by kind? | `lore_annotations(kind, path)` | `annotations` grouped by kind | Grep can find TODO/FIXME text but can't attribute them to components, link them to symbols, or reliably distinguish annotation kinds. |
| 10.2 | Which TODOs are inside high-complexity functions? | `lore_annotations` + `lore_metrics` | `annotations` + `symbol_metrics` join | Requires cross-referencing annotation position with symbol boundaries and complexity data. |
| 10.3 | What's the distribution of annotation kinds across the codebase? | `lore_annotations` | `annotations` GROUP BY kind | Aggregation query, not a search. |

### Category 11 — Composite / Multi-Hop Questions

These are the highest-value questions — they require **chaining multiple Lore
capabilities** and would take an agent many tool calls, backtracking, and
uncertain grep heuristics to approximate.

| # | Question | Lore tools chained | Why this is hard without Lore |
|---|----------|-------------------|------------------------------|
| 11.1 | "I need to modify `{symbol}`. What test files should I run, what is the coverage of those test paths, and who should review the change?" | `lore_lookup` → `lore_test_map` → `lore_coverage` → `lore_blame(ownership)` | Requires four structural lookups that each depend on the previous result. An agent would need to manually discover test files, run coverage, parse blame — possibly 10+ tool calls with uncertain results. |
| 11.2 | "What is the riskiest function in the codebase?" (high complexity + low coverage + high churn + many callers) | `lore_metrics(complexity)` + `lore_coverage` + `lore_blame(ownership)` + `lore_graph(call)` | Composite risk ranking over four independent dimensions. No single search can surface this. |
| 11.3 | "Trace the full request path from `GET /api/users` to the database, and tell me which segments are covered by tests." | `lore_routes` → `lore_graph(call)` (iterated) → `lore_coverage` per symbol → `lore_test_map` per file | Requires route resolution, multi-hop call traversal, per-symbol coverage lookup, and test mapping — all chained. |
| 11.4 | "What would break if I deleted `{file}`?" | `lore_graph(import, inbound)` → `lore_graph(call, inbound)` for each exported symbol | Requires computing the full reverse dependency closure: who imports this file, then who calls functions defined here. Grep can find textual imports but misses re-exports and transitive dependents. |
| 11.5 | "Find all symbols that have been added in the last 10 commits, have no test mapping, and have complexity > 5." | `lore_history(recent)` → `lore_lookup` (symbols in changed files) → `lore_test_map` → `lore_metrics(complexity)` | Requires correlating recent history with symbol extraction, coverage gaps, and complexity — four independent data sources. |
| 11.6 | "What interface implementations exist in the codebase, and which of those implementations are missing test coverage?" | `lore_graph(inheritance)` → `lore_coverage` per implementation | Requires inheritance graph query, then per-symbol coverage lookup. |
| 11.7 | "Summarize the architecture, then identify which component has the highest technical debt." (debt = complexity × annotation density × inverse test coverage) | `lore_architecture` → `lore_metrics` → `lore_annotations` → `lore_coverage` | Full architecture sweep combined with three quantitative signals. |

---

## Priority tiers for benchmark implementation

### Tier 1 — Core differentiators (implement first)
Questions that most clearly separate Lore from grep/semantic search:
- **1.1, 1.2** (direct callers/callees) — the simplest graph question
- **1.4** (blast radius) — multi-hop, genuinely impossible without graph
- **2.1** (interface implementations) — exhaustive structural query
- **3.1, 3.2** (resolved imports/reverse deps) — resolved, not textual
- **4.1** (test mapping) — unique Lore capability
- **5.1, 5.2** (symbol coverage) — requires two data sources
- **6.1** (complexity ranking) — computed, not searchable
- **8.1, 8.2** (route lookup) — structured extraction

### Tier 2 — High-value composites (implement second)
Questions that demonstrate multi-hop chaining:
- **11.1** (modify workflow: tests + coverage + ownership)
- **11.3** (request trace with coverage)
- **11.4** (deletion impact)
- **7.1** (domain expert identification)
- **5.3** (risk hotspots: complexity × coverage)

### Tier 3 — Architecture and overview (implement third)
Questions that require whole-codebase aggregation:
- **9.1** (component map)
- **9.5** (codebase metrics)
- **6.4** (complexity per component)
- **11.7** (technical debt ranking)

---

## Mapping to benchmark task families

| Task family (from benchmark-plan.md) | Best questions to use | Expected Lore advantage |
|---|---|---|
| **A. Localization** | 1.1, 1.2, 2.1, 3.2, 8.2 | Agent finds the right symbol/file in 1 tool call vs. 5–10 greps with false positives |
| **B. Explanation** | 9.1, 11.3, 7.1, 2.2 | Agent produces accurate structural explanations rather than guessing from file names |
| **C. Modification** | 1.4, 4.1, 11.1, 3.1 | Agent knows what to test, what's affected, and who to ask |
| **D. Refactoring** | 1.4, 2.1, 2.4, 11.4 | Agent finds all usage sites and inheritance chains — exhaustive, not heuristic |
| **E. Testing** | 4.1, 4.3, 5.1, 5.2, 5.3 | Agent targets untested and uncovered areas precisely |
| **F. History/ownership** | 7.1, 7.2, 7.3, 7.6 | Agent identifies owners and change history without running git commands |
| **G. Coverage/risk** | 5.3, 6.1, 6.5, 11.2, 8.5 | Agent finds risky code without manually parsing coverage reports |

---

## Evaluation criteria for each question

For each benchmark question, score:

1. **Correctness** — Does the answer match ground truth? (precision + recall for list answers)
2. **Completeness** — Are all relevant items found? (critical for "all callers" / "all implementations")
3. **Speed** — How many tool calls / tokens / wall-clock seconds to reach the answer?
4. **Noise** — How many false positives were included? (especially relevant for grep baseline)
5. **Composability** — For multi-hop questions: did the agent successfully chain the steps?

The key metric per question is **Recall@complete** — did the agent find ALL correct
answers? This is where Lore's structural guarantees (resolved refs, not text
matches) should show the largest gap versus grep.
