# Architecture Migration: SCIP + LSP (Drop Tree-Sitter Extractors)

> **Note:** This document was written as a migration proposal. The migration described here has been completed as of v0.4.0. The sections below describe the rationale and design that guided the migration.

## Motivation

Lore currently has three data sources: SCIP indexers, tree-sitter extractors, and LSP enrichment. This creates a system where correctness depends on hand-written per-language heuristics in the tree-sitter extractors — ~5,700 lines of code reimplementing (approximately) what language compilers already do.

**Design principle:** If the SCIP indexer and language server are correct, then Lore's data is correct. Lore becomes a storage and query layer over compiler-produced facts, not a reimplementation of compiler logic.

## Target Architecture

| Layer | Role | Lifetime |
|---|---|---|
| **SCIP** | Baseline full-repo index: symbols, refs, imports, relationships | Per-build (baseline rebuild) |
| **LSP** | Incremental updates: symbol discovery, type resolution, cross-file definition, call graph | Persistent (process lifetime) |

Tree-sitter extractors, the parser pool, and all 23 per-language grammar dependencies are removed.

## What Gets Deleted

| Component | Files | ~Lines |
|---|---|---|
| 23 language extractors | `src/parsing/extractors/*.ts` (except `types.ts` interfaces) | 4,934 |
| Parser pool + grammar loading | `src/parsing/parser.ts` | 168 |
| Complexity metrics (AST-based) | `src/parsing/complexity.ts` | 381 |
| Extractor shared types | `src/parsing/extractors/types.ts` | 220 |
| Parse worker | `src/indexer/stages/parse-worker.ts` | ~200 |
| SourceIndexStage extraction logic | `src/indexer/stages/source-index.ts` (gutted) | ~600 |
| SCIP tree-sitter helpers | `src/indexer/stages/scip-helpers/ingest.ts` (6 TS functions) | ~150 |
| Extractor tests | `tests/parsing/extractors/*.test.ts` (24 files) | ~3,500 |
| Parser/complexity tests | `tests/parsing/parser.test.ts`, `complexity.test.ts` | ~300 |
| SCIP ingest TS tests | `tests/indexer/scip-helpers-ingest.test.ts` (TS section) | ~250 |
| **Total** | | **~10,700** |

### npm Dependencies Removed (25 packages)

`tree-sitter`, `node-gyp-build`, plus 23 grammar packages (`tree-sitter-typescript`, `tree-sitter-python`, etc.). This eliminates the native addon build requirement and the Node 22 version pin for grammar compatibility.

### What Survives

- `src/parsing/config-parser.ts` — zero tree-sitter dependency, parses JSON/YAML/TOML/.env
- `tests/parsing/config-parser.test.ts`

## Implementation Phases

### Phase 1: Consume Unused SCIP Fields

SCIP already provides data Lore ignores. Start using it to reduce tree-sitter dependency before removing anything.

#### 1a. Use `syntaxKind` for ref classification

SCIP occurrences carry a `syntaxKind` field Lore never reads. Key values:

| `SyntaxKind` | Meaning |
|---|---|
| `IdentifierFunction` (15) | Function reference (including calls) |
| `IdentifierFunctionDefinition` (16) | Function definition site |
| `IdentifierType` (19) | Type identifier |
| `IdentifierBuiltinType` (20) | Built-in type |
| `IdentifierNamespace` (14) | Namespace/module |
| `IdentifierParameter` (11) | Parameter name |

**Change:** In `classifyScipReference()` (`src/indexer/stages/scip-helpers/symbol-kinds.ts`), when the symbol suffix returns `'skip'` (term-suffix `.` symbols like arrow functions), fall back to `occ.syntaxKind`:
- `IdentifierFunction` / `IdentifierFunctionDefinition` → `'call'`
- `IdentifierType` / `IdentifierBuiltinType` → `'type'`
- Otherwise → `'skip'`

This replaces `isCallExpression()` and `findMatchingCallRef()` from `ingest.ts`.

**Caveat:** Not all SCIP indexers populate `syntaxKind`. When it's `0` (unspecified), fall back to symbol-suffix classification only. This is a data-quality guarantee, not a heuristic — if `syntaxKind` is populated, it's authoritative.

#### 1b. Use `SymbolInformation.kind` for symbol kind inference

Lore currently infers symbol kind from the SCIP symbol string suffix (`.` → term, `().` → method, `#` → type, `/` → namespace). SCIP also provides `SymbolInformation.kind` with 87 enum values (`Method`, `Function`, `Class`, `Interface`, `Variable`, etc.) that Lore ignores.

**Change:** In `inferKindFromScipSymbol()`, prefer `symbolInfo.kind` when available and non-zero. Map to Lore kind strings. Fall back to suffix-based inference when `kind` is `UnspecifiedKind`.

#### 1c. Use `SymbolInformation.enclosingSymbol`

Lore currently computes parent symbols by parsing the SCIP symbol string (`extractParentScipSymbol()`). SCIP provides `enclosingSymbol` directly. When populated, use it instead of string manipulation.

#### 1d. Use `Occurrence.enclosingRange` on references

Per spec, `enclosingRange` on reference occurrences gives the parent expression range. Lore only reads it on definitions. For reference occurrences, this could help classify the context (e.g., distinguishing return statements from assignments) though this is supplementary, not a replacement for type-ref sub-kinds.

### Phase 2: Expand LSP Client

The current LSP client only supports `hover` and `definition`. Expand it to support incremental symbol discovery and call graph extraction.

#### 2a. Add `textDocument/documentSymbol`

Returns the full symbol tree for a file: names, kinds (`SymbolKind` enum: Function, Method, Class, Interface, Variable, etc.), ranges (full span + selection range), and parent-child nesting.

**This replaces tree-sitter extractors for symbol discovery in incremental updates.**

Response shape:
```typescript
DocumentSymbol {
  name: string
  kind: SymbolKind        // Function=12, Method=6, Class=5, etc.
  range: Range            // full span (start line → end line)
  selectionRange: Range   // name identifier range
  children?: DocumentSymbol[]  // nested symbols
  detail?: string         // e.g., type signature
}
```

Mapping to Lore's DB: `name` → `symbols.name`, `kind` → `symbols.kind`, `range` → `symbols.start_line`/`end_line`, `selectionRange` → definition position, `children` → `parent_symbol_id` relationships.

#### 2b. Add `callHierarchy/outgoingCalls`

Two-step protocol:
1. `textDocument/prepareCallHierarchy(position)` → `CallHierarchyItem[]`
2. `callHierarchy/outgoingCalls(item)` → `CallHierarchyOutgoingCall[]`

Each `CallHierarchyOutgoingCall` provides:
- `to: CallHierarchyItem` — the callee (name, kind, uri, range)
- `fromRanges: Range[]` — exact call site ranges in the caller

**This replaces tree-sitter call ref extraction.** Every outgoing call is compiler-verified. The `fromRanges` give precise call-site positions.

**Insert into `symbol_refs`:** `callee` from `to.name`/`to.uri`, call site from `fromRanges`, `resolution_method = 'lsp_call_hierarchy'`.

#### 2c. Add `textDocument/semanticTokens/full` (optional, for ref classification)

Returns per-token semantic type labels for the entire file. Each token gets a `SemanticTokenTypes` value:
- Type-family: `type`, `class`, `enum`, `interface`, `struct`, `typeParameter`
- Function-family: `function`, `method`, `macro`
- Value-family: `variable`, `property`, `parameter`, `enumMember`

**This can replace the tree-sitter `isCallExpression()` fallback for cases where SCIP `syntaxKind` is unpopulated.** If a token at a given position has type `function`/`method`, it's a function reference; if `class`/`type`/`interface`, it's a type reference.

**Note:** This is supplementary. Between SCIP `syntaxKind` and LSP `callHierarchy`, most classification is already handled. `semanticTokens` covers remaining edge cases.

#### 2d. Negotiate capabilities

The client currently sends `capabilities: {}`. Update to advertise support for the methods being added:
```typescript
capabilities: {
  textDocument: {
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    callHierarchy: { dynamicRegistration: false },
    semanticTokens: {
      requests: { full: true },
      tokenTypes: [...SemanticTokenTypes],
      tokenModifiers: [...SemanticTokenModifiers],
    },
  },
}
```

Parse server capabilities from `InitializeResult` to know which features are available per server.

### Phase 3: Persistent LSP Lifecycle

Currently, LSP servers are created per pipeline run and killed at stage disposal. Move to persistent servers.

#### 3a. Lift `LspEnrichmentCoordinator` to `Runtime`

- Create the coordinator in `LoreRuntime` constructor (or on first use), not in the pipeline stage.
- Pass coordinator reference into `PipelineContext` for stages to use.
- Servers start once at startup, survive across all overlay updates and baseline rebuilds.
- Shut down only on `Runtime.shutdown()`.

#### 3b. Incremental document sync

When a file changes (watcher/poller detects it):
1. If the file was previously opened with the language server: `textDocument/didChange` with the new content.
2. If new file: `textDocument/didOpen`.
3. If deleted: `textDocument/didClose`.

This keeps language servers warm and aware of current state. Subsequent `documentSymbol` / `callHierarchy` / `definition` requests return results against the latest content without re-reading from disk.

#### 3c. LSP becomes a hard requirement for incremental updates

- `lsp.enabled` defaults to `true` (currently `false`).
- If no language server is available for a language, incremental updates for that language produce a warning and skip those files. The next baseline rebuild (SCIP) will catch them.
- For baseline builds, SCIP remains the primary source. LSP enrichment runs after SCIP to fill in any gaps.

### Phase 4: Replace SourceIndexStage

The current `SourceIndexStage` does tree-sitter extraction for all files. Replace its incremental (overlay) path with LSP-driven extraction.

#### 4a. New `LspExtractionStage` (overlay mode)

Replace `SourceIndexStage` extraction with LSP-driven extraction. For each changed file in an overlay update:

1. **Symbol discovery:** `textDocument/documentSymbol` → insert/update `symbols` rows.
2. **Call graph:** For each function/method symbol, `callHierarchy/outgoingCalls` → insert `symbol_refs` rows with `callee` info and `resolution_method = 'lsp_call_hierarchy'`.
3. **Type resolution:** `textDocument/hover` on symbol definition positions → `resolved_type_signature`, `resolved_return_type`.
4. **Cross-file resolution:** `textDocument/definition` on reference positions → `definition_path`, `definition_line`.
5. **Deletion handling:** For files removed from disk, delete corresponding DB rows and insert `dirty_files` sentinels.

The `symbol_refs` produced here come pre-resolved (callee is known from `callHierarchy`), unlike tree-sitter refs which were unresolved and needed a later resolution pass.

#### 4a-1. Symbol identity: LSP ↔ SCIP reconciliation

LSP `documentSymbol` returns names, kinds, and ranges — not SCIP-style globally unique symbol strings (e.g., `scip-typescript npm pkg 1.0.0 src/foo.ts/MyClass#parse().`). Overlay-discovered symbols need stable identifiers that survive across overlay cycles and reconcile cleanly when the next baseline rebuild produces authoritative SCIP IDs.

**Strategy: position-based matching with synthetic overlay IDs.**

1. **Overlay writes use synthetic IDs.** Construct a deterministic ID from the `documentSymbol` hierarchy: `lsp:<file_path>/<parent_name>.<symbol_name>(<kind>)`. The hierarchy from nested `DocumentSymbol.children` provides the qualified parent chain. These IDs are stable across overlay cycles for unchanged symbols (same file, same name, same nesting = same ID).

2. **Refs use position-anchored callees.** `callHierarchy/outgoingCalls` returns `CallHierarchyItem` with `uri + range` for each callee. Use `textDocument/definition` to resolve the callee's definition position. Look up the existing DB symbol at that `(file, line, column)` — if found (from a prior SCIP baseline or earlier overlay), link directly by `symbol_id`. If not found, create the callee with a synthetic ID and link to that.

3. **Baseline rebuild reconciles.** SCIP baseline produces authoritative symbol strings with exact definition positions. Reconciliation matches SCIP definitions to existing DB rows by `(file_path, start_line, start_column)`:
   - **Match found:** Update the row's symbol identifier to the SCIP string. All `symbol_refs` pointing to the old synthetic ID are cascaded via foreign key.
   - **No match:** Insert as new (symbol was removed between overlay and baseline).
   - **Orphaned synthetic IDs:** Symbols in DB with `lsp:` prefix that have no position match in SCIP output are deleted (the symbol no longer exists in the authoritative index).

4. **Why position matching works.** Both SCIP definition occurrences and LSP `documentSymbol.selectionRange` point at the same token — the symbol's name identifier in source. For unchanged files, these positions are identical. For changed files, the overlay already re-extracts via LSP, and the next baseline re-indexes via SCIP, so both sides have current positions.

**Edge case: renamed symbols.** If a symbol is renamed between overlay cycles, its synthetic ID changes (different name). The old ID's DB row becomes orphaned and is cleaned up on the next baseline reconciliation. Between overlay cycles, this means a brief window where the old symbol exists alongside the new one. This is acceptable — the baseline rebuild is the consistency checkpoint.

#### 4b. Baseline mode: SCIP primary, LSP supplementary

In baseline builds, SCIP produces the full symbol/ref/import/relationship set. The `LspExtractionStage` runs after SCIP to:
- Enrich symbols with type signatures (hover)
- Fill in definition locations (definition)
- Supplement call graph edges that SCIP may have missed

This is essentially the current `LspEnrichmentStage` with the additional `documentSymbol` and `callHierarchy` requests.

#### 4c. Import handling

SCIP natively marks imports via `SymbolRole.Import` and provides the imported symbol ID. The actual symbol → target file resolution is done via `symbolDefinitions` (a SCIP-native map). The raw import path string currently comes from tree-sitter AST parsing.

**Replacement:** Use the SCIP symbol string to derive the import path. The current SCIP fallback in `extractImportPathFromTree()` already does this — parse `parts[3]` of the SCIP symbol string to get the package/module fragment. Promote this from fallback to primary. The import *resolution* (which file does it point to) is already SCIP-native and unaffected.

For languages where the raw import path string matters (e.g., for display in `lore_lookup`), the SCIP symbol string provides sufficient information. If higher fidelity is needed, the source text of the import line can be extracted via a simple line read (the line number is known from the occurrence).

### Phase 5: Drop Complexity Metrics

Complexity metrics (cyclomatic complexity, max nesting, param count) are orthogonal to Lore's core value proposition: deterministic call graph construction, full source code indexing, and incremental updates. Drop them entirely rather than reimplementing compiler work with regex approximations.

#### What gets removed

- **`symbol_metrics` table** — drop the table. Keep `line_count` as a derived value from symbol ranges (`end_line - start_line + 1`), computed at query time or stored on the `symbols` row.
- **`lore_metrics` tool** — delete. This tool exists solely to rank by complexity; agents can navigate code hotspots through `lore_graph`, `lore_dependents`, and `lore_trace` instead.
- **`lore_trace` annotation** — remove the optional `cyclomatic` field from trace steps. Zero impact on traversal logic (it was never used for path selection or depth decisions).
- **`lore_lookup` / query helpers** — remove the `LEFT JOIN symbol_metrics` and the four pass-through columns (`line_count`, `param_count`, `cyclomatic`, `max_nesting`) from `SymbolRow`. These are annotation-only and do not affect ranking, filtering, or merging.
- **`src/parsing/complexity.ts`** — delete (381 lines). Already covered by Phase 6 deletion list.
- **`tests/parsing/complexity.test.ts`** — delete.

#### Rationale

- `lore_metrics` is the only tool that uses complexity for its core function (ranking/filtering). All other tools treat it as pass-through annotation.
- No indexer, resolution, or decision-making code reads complexity metrics.
- Reimplementing cyclomatic complexity via regex (the previous plan) reintroduces the exact problem this migration solves: hand-written heuristics approximating what compilers do.
- If complexity ranking proves valuable later, it should come from a dedicated static analysis tool (ESLint complexity rule, SonarQube, etc.) rather than Lore reimplementing it.

### Phase 6: Delete Tree-Sitter

After phases 1–5 are complete and validated:

#### 6a. Remove source files

- Delete `src/parsing/parser.ts`
- Delete `src/parsing/complexity.ts`
- Delete `src/parsing/extractors/*.ts` (all 23 extractors + `types.ts`)
- Delete `src/indexer/stages/parse-worker.ts`
- Gut `src/indexer/stages/source-index.ts` (remove extraction logic, keep file management/deletion handling if not moved to `LspExtractionStage`)
- Remove tree-sitter functions from `src/indexer/stages/scip-helpers/ingest.ts` (keep `materializeVirtualDispatch`, `inferLoreLanguage`)
- Update `src/indexer/stages/scip-indexer.ts` to remove `ParserPool` import and tree-sitter parse calls
- Update `src/indexer/stages/dependency-api.ts` to remove `ParserPool`/`TypeScriptExtractor` imports

#### 6b. Remove npm dependencies

From `package.json`, remove:
- `tree-sitter`
- `node-gyp-build`
- All 23 `tree-sitter-*` / `@tree-sitter-grammars/*` / `@elm-tooling/tree-sitter-elm` packages

#### 6c. Remove tests

- Delete `tests/parsing/extractors/*.test.ts` (24 files)
- Delete `tests/parsing/parser.test.ts`
- Delete `tests/parsing/complexity.test.ts`
- Remove tree-sitter sections from `tests/indexer/scip-helpers-ingest.test.ts`

#### 6d. Update references

- `src/lsp/config.ts` and `src/lsp/registry.ts` import `SUPPORTED_PARSER_LANGUAGES` — replace with SCIP-registry-based or LSP-registry-based language list.
- `src/indexer/pipeline.ts` imports `RawCallRef`, `RawTypeRef` types — inline or replace with LSP-oriented types.
- `src/resolution/resolver.ts` imports `RawImport` type — replace with DB-backed import type.
- `src/index.ts` re-exports extractor types — remove.

#### 6e. Relax Node version constraint

With native tree-sitter addons gone, the strict Node 22 pin (driven by grammar binary compatibility) can be relaxed. Update `engines` in `package.json` and `.nvmrc`.

## Type Ref Sub-Kinds

Neither SCIP nor LSP provides syntactic-position classification of type references (return type vs parameter vs field vs generic argument vs bound). This is the one place where tree-sitter was genuinely unique.

### Decision: Drop sub-kinds

Store type refs as `kind = 'type'` without sub-classification. The relationship "type X is referenced by symbol Y" is preserved; the granularity of "as a return type" vs "as a parameter type" is lost.

**Impact:** `lore_graph` and `lore_dependents` queries that filter by `ref_kind` would return all type refs instead of a specific sub-kind. If this turns out to matter for agent decision-making, re-evaluate — but start without it and measure.

### Alternative: Keep sub-kinds via SCIP `enclosingRange` + source text

If sub-kinds prove valuable: for definition occurrences, SCIP provides the full symbol range. For reference occurrences in some indexers, `enclosingRange` gives the parent expression. Combined with reading the source line at the reference position, simple pattern matching (`->`, `:`, `<`, `extends`, `implements`) could classify most cases without an AST. This is a targeted heuristic, not a full parser.

## Pipeline After Migration

### Build Mode (baseline)

```
ScipIndexerStage          → symbols, imports, relationships from SCIP index
LspExtractionStage        → enrich with hover/definition/callHierarchy
ImportResolutionStage     → resolve file_imports.resolved_id
DependencyApiStage        → external_symbols
git-history               → commits, diffs, refs
fts-refresh               → rebuild symbols_fts
symbol-resolution         → resolve remaining symbol_refs.callee_id
ReverseDepsStage          → rebuild reverse_deps
EmbeddingStage            → vector embeddings
```

### Update Mode (overlay)

```
LspExtractionStage        → documentSymbol + callHierarchy + hover + definition for changed files
ImportResolutionStage     → resolve new imports
fts-refresh               → rebuild symbols_fts
symbol-resolution         → resolve symbol_refs (overlayOnly)
ReverseDepsStage          → update reverse_deps
EmbeddingStage            → update embeddings for changed symbols
```

SCIP never runs during overlay — unchanged. The quiet-period flush triggers a full baseline rebuild with SCIP.

### Persistent LSP Servers

```
Runtime.start()
  ├─ create LspCoordinator (persistent)
  ├─ start language servers for detected languages
  ├─ initial build (SCIP baseline + LSP enrichment)
  └─ enter watch/poll mode
       ├─ file change detected
       ├─ didChange/didOpen/didClose to LSP servers
       ├─ overlay update pipeline (LSP extraction, no SCIP)
       └─ quiet-period flush → baseline rebuild (SCIP + LSP)
Runtime.shutdown()
  └─ close all LSP servers
```

## Migration Order

Phases are designed so each is independently shippable and testable:

1. **Phase 1** (consume SCIP fields) — pure improvement, no removals, no new dependencies. Ship and validate that `syntaxKind` and `SymbolInformation.kind` improve classification accuracy.
2. **Phase 2** (expand LSP client) — additive. New LSP methods alongside existing tree-sitter. Validate `documentSymbol` output matches tree-sitter extraction for SCIP-covered languages.
3. **Phase 3** (persistent LSP) — infrastructure change. Validate that persistent servers are stable across many update cycles.
4. **Phase 4** (replace SourceIndexStage) — the big swap. Replace tree-sitter extraction with LSP-driven extraction.
5. **Phase 5** (drop complexity metrics) — can be done at any point, including before Phase 1. Low coupling. Removes `symbol_metrics` table, `lore_metrics` tool, and complexity annotations from other tools.
6. **Phase 6** (delete tree-sitter) — cleanup after all above is validated. Remove code, deps, tests.

## Risk Register

| Risk | Mitigation |
|---|---|
| SCIP indexers don't populate `syntaxKind` | Fall back to symbol-suffix classification. Track population rates per indexer. File upstream issues. |
| Language server not installed for a language | Warn and skip incremental updates for that language. Next SCIP baseline rebuild catches up. |
| Language server crashes or hangs during long session | Implement restart-on-crash with exponential backoff in coordinator. |
| `documentSymbol` output varies across servers | Validate against SCIP output for overlapping languages. Document per-server quirks. |
| `callHierarchy` not supported by a server | Fall back to SCIP-only call graph for that language. Log capability gaps. |
| Import path strings become less precise | SCIP symbol strings provide module identity. Raw path is cosmetic — resolution is unaffected. |
| Memory pressure from persistent language servers | Monitor RSS per server process. Consider starting servers lazily (on first file change for that language) rather than eagerly. |
| Loss of type ref sub-kinds affects agent quality | Monitor agent behavior. Re-add sub-kinds via `enclosingRange` + source text if needed. |
| LSP symbol identity drift across overlay cycles | Synthetic `lsp:` IDs are deterministic from `(file, name, kind, parent_chain)`. Position-based reconciliation on baseline rebuild promotes to authoritative SCIP IDs. Renamed symbols create brief duplicates cleaned up at next baseline. |
| First-boot latency from language server startup | Some servers (Java, C#) take 30–60s to initialize. Acceptable for persistent servers since cost is paid once. First overlay update is delayed until server is ready — document this and consider a readiness check before accepting file-change events. |
