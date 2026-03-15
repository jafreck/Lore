# Complex Codebase Questions

20 questions about large-scale codebases that **cannot** be easily answered by
standard tools (grep, git, wc, etc.) because they require semantic
understanding — type resolution, call-graph construction, data-flow analysis,
or cross-cutting architectural reasoning.

---

## Questions Lore Answers Well Today (7)

These are fully answerable using Lore's existing schema and tools.

### 1. Which functions are never called anywhere in the codebase?

Dead code detection: query all symbols of `kind=function`, left-join against
`symbol_refs` for zero inbound call edges.

**Tools:** `lore_graph(kind=call)`, `lore_lookup`
**Tables:** `symbols` LEFT JOIN `symbol_refs` WHERE `callee_id` IS NULL

### 2. If I change the signature of this function, what will break?

Impact analysis: `lore_graph(kind=call, target_id=X, depth=5)` traces all
transitive callers; combine with `lore_graph(kind=type_dependency)` for type
consumers.

**Tools:** `lore_graph`
**Tables:** `symbol_refs` (multi-hop), `type_refs`

### 3. What are all the concrete implementations of this interface/abstract method?

Inheritance query: `lore_graph(kind=inheritance)` over `symbol_relationships`
with `relationship_type` IN (extends, implements).

**Tools:** `lore_graph(kind=inheritance)`
**Tables:** `symbol_relationships`

### 4. Which modules form circular dependency cycles?

Cycle detection: `detectCycles(db)` runs Tarjan's SCC on `file_imports`.
`lore_graph(kind=import)` provides the raw edge data for further analysis.

**Tools:** `lore_graph(kind=import)`, internal `detectCycles()`
**Tables:** `file_imports`

### 5. Which pairs of functions have very similar logic (clone detection candidates)?

Semantic similarity: `lore_search(mode=semantic)` uses embedding cosine
similarity to find functions with similar logic regardless of naming.

**Tools:** `lore_search(mode=semantic)`
**Tables:** `symbol_embeddings` (vec0)

### 6. What is the cognitive/cyclomatic complexity of this module, and which functions contribute most?

Complexity ranking: `lore_metrics` directly returns symbols ranked by
cyclomatic complexity, nesting depth, parameter count, and line count.

**Tools:** `lore_metrics`
**Tables:** `symbol_metrics`

### 7. Which third-party dependencies are used only by a single feature?

Dependency isolation: `external_deps` maps each package to the files that
reference it — query for packages with imports confined to a single directory.

**Tools:** `lore_lookup`, SQL over `external_deps`
**Tables:** `external_deps` JOIN `files`

---

## Questions Lore Could Answer With New Features (7)

These are partially or fully answerable with deterministic, language-agnostic
computation over data already in (or easily added to) the SQLite database.
No new language-specific parsing is required.

### 8. What is the actual runtime type of this variable at a call site?

Lore has `resolved_type_signature` from LSP/SCIP (static types), but cannot
resolve runtime polymorphism or control-flow narrowing. **Partially answered.**

### 9. Which code paths can lead to this error being thrown?

Reverse call graph gives the chain of callers up to 5 hops, but not the
specific branching conditions within each function. **Partially answered.**

### 10. Which tests actually exercise this specific line or branch of code?

`test_mappings` maps test files → source files, and `coverage_files` stores
line-level hit counts, but Lore can't attribute individual lines to individual
test cases. See [issue: per-test line coverage attribution].

### 11. What is the public API surface of this package, and has it changed since the last release?

Lore has all symbols and git history. Tree-sitter extractors already compute
`isExported` but don't persist it. With a new `is_exported` column and a branch
diff query, this becomes a pure SQL set-difference. See [issue: API surface diff].

### 12. Where are the architectural layer violations?

The import graph is complete in `file_imports`, but Lore has no layer model.
Without requiring user config, the import DAG can be topologically sorted at the
directory level to infer layers, and back-edges flagged as anomalies. See
[issue: structural anomaly detection].

### 13. What is the full sequence of async operations when an API endpoint is called?

`lore_routes` finds the handler, `lore_graph(kind=call)` traces the call chain,
but Lore doesn't distinguish async/sync hops or model middleware ordering.
**Partially answered.**

### 14. What is the ownership/responsibility boundary of each module — which modules have too many responsibilities?

Lore has modules, symbol counts, complexity metrics, and import fan-in/fan-out.
Cohesion can be computed as internalEdges / totalEdges per directory — a pure
SQL aggregation over existing data. See [issue: module cohesion ranking].

---

## Questions Lore Cannot Answer (6)

These require **runtime data-flow analysis**, **effect tracking**, or
**domain-specific semantic understanding** that goes beyond what deterministic
static indexing can provide in a language-agnostic manner.

### 15. What is the effective configuration/options object at this point in the code?

Requires tracing data flow through `Object.assign`, spreads, and conditional
logic. Language-specific syntax and runtime semantics make this intractable
without per-language data-flow analysis.

### 16. What data flows from user input to this database query? (taint analysis)

Requires identifying language-specific sources (e.g. `req.body`, `sys.argv`)
and sinks (e.g. `db.query`, ORM save), then tracking data propagation across
function boundaries and async hops.

### 17. Which environment variables or feature flags affect this code path?

Requires recognizing language-specific env-var reads (`process.env`,
`os.environ`, `std::env::var`) and tracing their influence through conditional
branches.

### 18. If this type definition changes, which serialization boundaries would produce incompatible data?

Type dependency graph exists, but identifying serialization points
(`JSON.stringify`, protobuf codegen, `@Serializable` annotations) requires
framework-specific pattern matching.

### 19. What are the implicit coupling points between two seemingly independent modules?

Coupling through shared database tables, config keys, and message queue topics
is invisible to code import analysis. Extracting resource identifiers from
strings requires classifying which string literals are resource names vs. log
messages.

### 20. Which functions have observable side effects vs. which are pure?

Requires identifying I/O operations (`fs.write`, `http.get`, `println!`) as
effectful primitives, then propagating effect status upward through the call
graph. The set of effectful primitives differs per language.
