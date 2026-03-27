# Correctness Audit

Deep inspection of Lore's source code for correctness issues, conducted 2026-03-27.

---

## Critical

### 1. Baseline rebuild silently deletes reindexed non-SCIP files

**File:** `src/indexer/stages/source-index.ts` ~L505

The in-place baseline update path updates the `files` row but never writes the new `generation` value. `overlay-cleanup.ts` then deletes every baseline file whose generation < promoted generation, purging freshly-indexed files and all their child rows.

### 2. Multi-index SCIP enrichment discards all but the last index

**File:** `src/scip/enrichment.ts` ~L361

`mergeScipIndexDataPartial()` simply `return b`, dropping all data from earlier SCIP indexes. Multi-language repos or repos requiring multiple SCIP indexers silently lose enrichment data based on load order.

### 3. SCIP baseline rebuilds are layer-blind — can delete overlay rows

**File:** `src/indexer/stages/scip-indexer.ts` ~L632

File lookup by path and branch doesn't constrain `layer`. If both baseline and overlay rows exist, the query can return (and delete) the overlay row during a baseline rebuild.

---

## High

### 4. Incremental `reverse_deps` update permanently drops inbound edges

**File:** `src/indexer/stages/reverse-deps.ts` L57–85

Deletes edges where changed file is either dependency or dependent, but only reinserts edges originating *from* the changed file. Edges from **unchanged** files that depend on the changed file are permanently lost after each incremental update.

### 5. Symbol resolution is branch-blind — creates phantom cross-branch edges

**File:** `src/resolution/call-graph.ts` ~L313

`buildNameMap()` loads `SELECT id, name, file_id, kind FROM symbols` with no branch filter. If the DB contains multiple branches, `name_unique` fallback resolution can point references on branch A to symbols on branch B.

### 6. Python relative imports lose leading dots — misclassified as absolute

**File:** `src/parsing/extractors/python.ts` ~L121

`extractFromImport` reads only `module_name`, which excludes the `import_prefix` (dots) from the tree-sitter AST. `from . import x` yields `source = ''` and `from .foo import bar` yields `source = 'foo'`, so the resolver never recognizes them as relative.

### 7. Go import resolution returns directories — never resolves to file IDs

**File:** `src/resolution/resolver.ts` L117–133

Returns `resolvedPath: candidate` where `candidate` is a directory path. `import-resolution.ts` then looks that path up in a file-path map, which only contains file paths. Internal Go imports will almost never populate `file_imports.resolved_id`.

### 8. Go method call refs are emitted under bare names, but symbols use `Receiver.Method`

**File:** `src/parsing/extractors/go.ts` ~L169

The call ref `callerSymbol` uses the bare method name from `findEnclosingSymbolName`, while symbol names are qualified as `Receiver.Method`. The indexer drops any call ref whose `callerSymbol` is not in `symbolIdMap`, silently losing Go method call edges.

### 9. Non-SCIP symbol ownership collapses on overloaded/repeated names

**File:** `src/indexer/stages/source-index.ts` ~L569

`symbolIdMap` is keyed only by `name`. Overloads, shadowed names, and nested same-name functions all map to whichever symbol was inserted last, corrupting parent resolution and reference attachment.

### 10. Read-only queries bypass effective views — serve stale/duplicate data

**File:** `src/db/read-only.ts` L179–845

Most query methods (`getFileByPath`, `listSymbols`, etc.) query raw `files`/`symbols` tables instead of `effective_*` views. When overlay rows exist alongside baseline rows, results are non-deterministic.

### 11. Semantic/fused search ignores path, language, and kind filters

**File:** `src/server/tools/search.ts` ~L234

`semanticSearch` and `semanticSymbolSearch` only filter by branch, allowing results outside the requested scope. Fused mode can reintroduce filtered-out symbols.

### 12. TypeScript dynamic imports create phantom `import` call refs

**File:** `src/parsing/extractors/typescript.ts` L112–116

`import('./x')` is correctly recorded as an import, but then also passes through call extraction, creating a bogus `symbol_refs` row for a callee named `import`.

### 13. Dependents tool aggregates across ambiguous matches but reports only the first

**File:** `src/server/tools/dependents.ts` L680–691

When 2–5 symbols share a name, all their dependents are aggregated, but the response target reports only the first symbol. The blast radius can be materially misleading.

### 14. Import resolution is layer-blind during overlay updates

**File:** `src/indexer/stages/import-resolution.ts` L29–44

Selects from raw `file_imports` and `files` tables without constraining layer. Can resolve `resolved_id` to a hidden baseline row instead of the active overlay row.

### 15. Blame/history git argument injection

**File:** `src/server/tools/blame.ts` L248–450

User-supplied `ref` is passed to git command args after only trimming whitespace. Option-like refs (e.g., `--exec=...`) are interpreted as git flags, not revisions.

### 16. Directory structure analysis silently truncates import graph at 10,000 edges

**File:** `src/server/tools/structure.ts` ~L154

No ordering, no truncation flag. Large repos will nondeterministically miss cycles and layering violations depending on which rows SQLite returns.

### 17. Diff summary counts reflect truncated array lengths, not true totals

**File:** `src/server/tools/diff.ts` L91–188

Per-category results are truncated to the limit, but summary counts are derived from the truncated arrays with no indication of undercounting.

---

## Medium

### 18. `incrementGeneration` has a lost-update race

**File:** `src/db/schema.ts` ~L429

Reads current generation and writes `+1` in separate statements. Two concurrent writers can both read N and write N+1.

### 19. Schema init and view refresh aren't in a transaction

**File:** `src/db/schema.ts` L320–391

Despite the comment "Create all tables in a single transaction," `db.exec(DDL)` and the view DROP/CREATE sequence are not wrapped. Concurrent readers can see `no such view` errors during refresh.

### 20. `semanticSearchSymbols` crashes when sqlite-vec is unavailable

**File:** `src/db/read-only.ts` ~L364

The connection setup swallows vec startup errors, but this query unconditionally uses vec-specific semantics. Unlike commit semantic search, the symbol path has no guard.

### 21. `dirty_files.path` NOT NULL is not enforced; `NOT IN` against it is unsafe

**File:** `src/db/schema.ts` ~L334 / ~L362

`TEXT PRIMARY KEY` on non-INTEGER columns allows NULL in SQLite unless `NOT NULL` is specified. If NULL enters `dirty_files.path`, the `NOT IN` expression in `effective_files` becomes UNKNOWN and baseline files vanish.

### 22. LSP client silently drops server-initiated requests (protocol violation)

**File:** `src/lsp/client.ts` L232–243

Messages with an `id` not in `pending` (server requests) are silently dropped. Servers expecting a response to `workspace/configuration` etc. can hang.

### 23. FileWatcher bypasses discovery filters

**File:** `src/discovery/watcher.ts` L129–136

Forwards every `fs.watch` path into incremental updates without applying the include/exclude/extension rules from the walker.

### 24. Git hook installation breaks on worktrees

**File:** `src/git/hooks.ts` L59–65

Assumes `.git` is a directory. In worktrees, `.git` is a file pointing to the actual git directory, so hook installation targets the wrong path.

### 25. Decorated Python classes are emitted twice

**File:** `src/parsing/extractors/python.ts` L39–52

The class case doesn't check if the parent is `decorated_definition`, unlike the function case. Decorated classes produce duplicate symbol rows.

### 26. Java static member imports resolve to nonexistent files

**File:** `src/parsing/extractors/java.ts` L139–151

`import static a.b.C.method` becomes source `a.b.C.method`, and the resolver probes `a/b/C/method.java` instead of resolving against the owning type.

### 27. TypeScript multi-declarator statements only index the first binding

**File:** `src/parsing/extractors/typescript.ts` L217–246

`const a = () => {}, b = () => {};` only indexes `a`.

### 28. Complexity metrics count nested scopes instead of the symbol's own body

**File:** `src/parsing/complexity.ts` L39–56

Outer functions and classes inherit cyclomatic complexity and parameter counts of nested functions.

### 29. Negative LIMIT bypasses result caps in SQLite

**File:** `src/db/read-only.ts` ~L28

Pagination helper caps the upper bound but doesn't floor negative values. `LIMIT -1` in SQLite means no limit.

### 30. `getCommitBySha` prefix match returns arbitrary row on ambiguous prefixes

**File:** `src/db/read-only.ts` ~L1042

`sha = ? OR sha LIKE ? LIMIT 1` with no ordering and no ambiguity detection.

---

## Low

### 31. `createVec0Tables` interpolates `dims` into DDL without validation

**File:** `src/db/schema.ts` L449–455

The one place in the schema layer where SQL is not parameterized.

### 32. `getFreshness` swallows corruption errors and reports healthy state

**File:** `src/db/read-only.ts` ~L73

Broad catch blocks fall back to zero values for any error, not just old-schema incompatibility.

### 33. SCIP occurrence lookup breaks on duplicate documents and multi-line ranges

**File:** `src/scip/index-reader.ts` L109–155

Overwrites prior occurrence lists for duplicate file paths; only scans occurrences where `startLine === line`.

### 34. Symlink handling is inconsistent between discovery and resolution

Discovery uses `fast-glob` with no explicit symlink policy; import resolution matches by literal stored path. Same physical file can be indexed twice or fail cross-file resolution.

### 35. `import.meta.url` pathname breaks on paths with spaces

**File:** `src/scip/installer.ts` ~L86 / `src/scip/registry.ts` ~L147

`new URL(import.meta.url).pathname` doesn't decode percent-encoded paths.
