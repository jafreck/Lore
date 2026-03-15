# Incremental Index Design

## Problem

Lore is hard-dependent on SCIP for code intelligence. SCIP provides the
complete call graph, cross-file resolution, and type signatures with
compiler-backed precision. SCIP indexers are whole-project tools — they
cannot index a single changed file. A full SCIP run takes seconds to minutes
depending on project size, making it unsuitable as the live editing path.

Tree-sitter is fast enough to re-index individual files in milliseconds, but it
produces only structural data (symbols, unresolved refs) and two data types
that SCIP does not provide: complexity metrics and comment annotations. It
cannot resolve cross-file definitions or produce type signatures.

LSP servers can resolve definitions and types for specific positions, but
querying the entire project through LSP is too expensive and unreliable to
serve as a complete graph source. LSP's role is strictly limited to the
incremental overlay path — it is never used during baseline builds.

**Goal**: Keep the index accurate and useful while developers and agents are
actively editing — including multi-agent scenarios with concurrent writers —
without blocking on a full SCIP rebuild after every change.

---

## Data Source Roles

Each of Lore's three data sources has exactly one role. There is no overlap in
when they run or what they are responsible for.

| Source | Role | Runs when | Scope | What it produces |
|--------|------|-----------|-------|------------------|
| **Tree-sitter** | **Primary incremental indexer** | Every file save (overlay) | Changed files only | Symbols, imports, call refs, type refs, relationships, annotations, complexity metrics. Full structural extraction — the same data the `SourceIndexStage` produces today. |
| **LSP** | **Cross-file enrichment for overlay** | Immediately after tree-sitter, on the same file save | Unresolved refs in changed files + bounded impact set | `definition_path`, `definition_line`, `resolved_type_signature`, `resolved_return_type` via `textDocument/definition` and `textDocument/hover`. Converts `unresolved` refs to `lsp_definition`. |
| **SCIP** | **Background baseline reconciliation** | After quiet period (10 s), on HEAD change, or explicit `lore refresh` | Whole project | Complete symbol table with pre-resolved call graph (`scip_definition`), type signatures, and definition locations. Replaces the entire baseline generation atomically. |

### Why not SCIP for incremental?

SCIP indexers (`scip-typescript`, `scip-python`, `scip-go`, etc.) are
whole-project tools. They read the full dependency graph and type-check
everything. There is no `--files` flag or partial-index mode. Running SCIP on
every file save would mean re-running the full indexer, which defeats the
purpose of incremental updates.

### Why not LSP as the primary indexer?

LSP is designed for point queries ("what is the type at line 42, column 10?"),
not bulk extraction. Extracting a full symbol table by querying every
identifier position through LSP is orders of magnitude slower than tree-sitter
AST walking, and LSP server behavior varies across languages. LSP's value is
precisely targeted cross-file resolution — not structural extraction.

### Why tree-sitter is not optional

Tree-sitter serves three roles that neither SCIP nor LSP can fill:

1. **Complexity metrics** — cyclomatic complexity, max nesting depth, param
   count, line count. SCIP indexes don't compute these. LSP has no API for
   them. Only tree-sitter AST walking can derive them. (Stored in
   `symbol_metrics`.)

2. **Annotations** — TODO/FIXME/NOTE extracted from comments. SCIP ignores
   comments entirely. LSP has no comment extraction request. (Stored in
   `annotations`.)

3. **Overlay structural extraction + LSP target generation** — tree-sitter
   is the only source fast enough to run on every keystroke-debounce cycle.
   It produces the structural skeleton (symbols, refs, imports) that the
   overlay layer needs, and critically, it provides the `(file, line,
   character)` ref positions that LSP requires to perform targeted
   `textDocument/definition` queries. Without tree-sitter, LSP has no
   targets to resolve.

In summary: SCIP provides the baseline truth, tree-sitter provides metrics +
annotations + the overlay skeleton, and LSP enriches the overlay with
cross-file resolution.

### Data flow per file save

```
File save → debounce 300ms
  │
  ├─ 1. Tree-sitter: parse → extract symbols, refs, imports, metrics
  │     Write overlay rows (layer='overlay', generation=0)
  │     ~5-50ms per file
  │
  ├─ 2. LSP: resolve unresolved overlay refs
  │     textDocument/definition + textDocument/hover
  │     Only for: changed files + impact set (capped at 100 files)
  │     ~50-300ms
  │
  └─ 3. Name fallback: resolveSymbolEdges scoped to remaining unresolved
        Same-file match → unique-name match
        ~1-5ms
```

---

## Design: Baseline + Overlay in a Single Database

### Core Idea

Every row in the index belongs to exactly one of two logical layers:

| Layer | Source | Trigger | Scope |
|-------|--------|---------|-------|
| **Baseline** | SCIP | Background rebuild after quiet period, HEAD change, or explicit refresh | Whole project |
| **Overlay** | Tree-sitter + LSP | File save / fs-event | Changed files + impact set |

Both layers live in the same `.lore.db` file. Reads merge both layers, preferring
overlay rows for dirty files and falling back to baseline for everything else.

A monotonically increasing **generation counter** (`lore_meta.generation`) tracks
baseline rebuilds. When a background SCIP refresh completes, it writes a new
generation and the old baseline rows are replaced atomically.

### Layer Semantics

```
┌─────────────────────────────────────────────────────┐
│                   Query Layer                       │
│  For file F:                                        │
│    if F has overlay rows → return overlay            │
│    else                  → return baseline           │
│  For cross-file edges:                              │
│    merge baseline + overlay, deduplicate by          │
│    (caller_id, callee_name, call_line)              │
│    rank by resolution confidence                    │
└─────────────────────┬───────────────────────────────┘
                      │
        ┌─────────────┴──────────────┐
        │                            │
   ┌────▼────┐                 ┌─────▼─────┐
   │ Overlay │                 │ Baseline  │
   │ TS + LSP│                 │   SCIP    │
   │ dirty   │                 │   clean   │
   │ files   │                 │   HEAD    │
   └─────────┘                 └───────────┘
```

---

## Schema Changes

### New columns on existing tables

Every data table (`files`, `symbols`, `symbol_refs`, `type_refs`,
`symbol_relationships`, `file_imports`, `annotations`, `symbol_metrics`,
`external_deps`) gains:

```sql
layer       TEXT NOT NULL DEFAULT 'baseline'  -- 'baseline' | 'overlay'
generation  INTEGER NOT NULL DEFAULT 0        -- monotonic baseline generation
```

`layer` is either `'baseline'` (written by SCIP) or `'overlay'` (written by
tree-sitter + LSP during incremental updates).

`generation` tracks which baseline rebuild produced a row. Overlay rows always
use `generation = 0` (they are transient and replaced on every file change).
Baseline rows use the current generation counter from `lore_meta`.

### New metadata keys in `lore_meta`

| Key | Value | Purpose |
|-----|-------|---------|
| `generation` | Integer | Current baseline generation counter |
| `generation_pending` | Integer | Generation being built by background SCIP |
| `overlay_dirty_files` | JSON array of paths | Files with active overlay data |
| `baseline_head_sha` | String | Git SHA of the last successful baseline |
| `overlay_head_sha` | String | Git SHA when overlay was last refreshed |

### New table: `dirty_files`

```sql
CREATE TABLE IF NOT EXISTS dirty_files (
  path        TEXT PRIMARY KEY,
  dirty_since INTEGER NOT NULL DEFAULT (unixepoch()),
  overlay_gen INTEGER NOT NULL DEFAULT 0
);
```

Tracks which files have overlay data. Used by:
- The query layer to decide baseline vs overlay for a given file.
- The background SCIP rebuild to know which files need overlay cleanup after
  baseline promotion.
- The impact graph to seed the LSP re-enrichment set.

### New table: `reverse_deps`

```sql
CREATE TABLE IF NOT EXISTS reverse_deps (
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dependent_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dep_kind     TEXT NOT NULL DEFAULT 'import',  -- 'import' | 'ref'
  PRIMARY KEY (file_id, dependent_id, dep_kind)
);
```

Maintained during import resolution and call-graph resolution. Maps "file X
is depended on by files Y, Z" so that when X changes, Y and Z can be cheaply
identified as the impact set for targeted LSP re-enrichment.

### Indexes

```sql
CREATE INDEX idx_files_layer ON files(layer);
CREATE INDEX idx_symbols_layer ON symbols(layer);
CREATE INDEX idx_symbol_refs_layer ON symbol_refs(layer);
CREATE INDEX idx_type_refs_layer ON type_refs(layer);
CREATE INDEX idx_symbol_relationships_layer ON symbol_relationships(layer);
CREATE INDEX idx_dirty_files_path ON dirty_files(path);
CREATE INDEX idx_reverse_deps_file ON reverse_deps(file_id);
CREATE INDEX idx_reverse_deps_dependent ON reverse_deps(dependent_id);
```

---

## Write Paths

### 1. Full Build (initial index)

Trigger: `lore build` or first-time MCP server start.

```
ScipSourceStage → SourceIndexStage → DocsIndexStage
  → ImportResolutionStage → DependencyApiStage
  → LspEnrichmentStage → ResolutionStage → TestMapStage
  → HistoryStage → EmbeddingStage → ReverseDepsStage
```

All rows written with `layer = 'baseline'`, `generation = 1`.
`lore_meta.generation` set to `1`.
`dirty_files` table is empty.
`reverse_deps` populated from resolved imports and symbol refs.

### 2. Overlay Update (file change during editing)

Trigger: fs-event (watcher) or poll diff.

The overlay update uses **tree-sitter as the primary indexer** and **LSP as the
cross-file enrichment layer**. SCIP is never invoked during overlay updates.

**Step 1: Identify changed files.**
Debounce for 300 ms (existing behavior), collect absolute paths.

**Step 2: Tree-sitter re-index changed files (primary incremental indexer).**
For each changed file:
1. Delete existing overlay rows for this file (`WHERE path = ? AND layer = 'overlay'`).
2. Parse with tree-sitter, extract symbols, imports, call refs, type refs,
   relationships, annotations, and complexity metrics — the full
   `SourceIndexStage` extraction.
3. Insert new rows with `layer = 'overlay'`, `generation = 0`.
4. Upsert path into `dirty_files`.

Baseline rows for this file are **not deleted**. They remain in place so that
cross-file refs pointing into this file (from files that have NOT changed) stay
valid until the next baseline rebuild.

Tree-sitter produces refs with `resolution_method = 'unresolved'` because it
cannot resolve cross-file definitions. That is expected — LSP handles this next.

**Step 3: Compute impact set.**
Query `reverse_deps` for the changed files:
```sql
SELECT DISTINCT dependent_id FROM reverse_deps
WHERE file_id IN (SELECT id FROM files WHERE path IN (?...))
```
These are files that import or reference symbols from the changed files.

**Step 4: Targeted LSP enrichment (cross-file resolution for overlay).**
LSP's sole job during overlay updates is resolving cross-file definitions that
tree-sitter cannot provide. Run `textDocument/definition` and
`textDocument/hover` for:
- All unresolved refs in overlay rows for changed files.
- Refs in impact-set files whose `callee_id` pointed to symbols in the changed
  files (these callee targets may have moved or been renamed).

Update the overlay refs with LSP-derived `definition_path`, `definition_line`,
`resolved_type_signature`. Set `resolution_method = 'lsp_definition'`.

LSP is **not** used for structural extraction (symbols, imports, metrics) —
that is tree-sitter's job.

**Step 5: Name-based fallback resolution.**
Run the existing 3-tier resolution (`resolveSymbolEdges`) scoped to overlay
refs that are still unresolved after LSP.

**Step 6: Update reverse deps.**
Re-derive `reverse_deps` entries for the changed files based on newly resolved
imports and refs.

**Step 7: Scoped re-embedding.**
If embeddings are enabled, re-embed changed symbols only (existing behavior).

### 3. Background Baseline Rebuild (SCIP reconciliation — not incremental)

Trigger: quiet period expires (default 10s), HEAD changes, or explicit
`lore refresh`.

This is the **only** path that invokes SCIP. It is always a full-project
rebuild — SCIP does not support partial/incremental indexing. The purpose is to
replace the baseline with fresh, high-confidence, whole-project truth.

**Step 1: Increment pending generation.**
Set `lore_meta.generation_pending = current_generation + 1`.

**Step 2: Run full SCIP pipeline into a staging generation.**
Execute the full pipeline (SCIP source → tree-sitter metrics → name-based
resolution fallback) writing all rows with `layer = 'baseline'`,
`generation = generation_pending`.

Tree-sitter participates in the baseline build only for complexity metrics
(SCIP does not provide cyclomatic complexity, nesting depth, etc.) and
annotation extraction (TODO/FIXME/NOTE from comments).

**LSP is not used during baseline builds.** SCIP provides compiler-backed
precision for cross-file resolution. Refs that SCIP leaves unresolved (e.g.,
some member-access patterns) remain unresolved in the baseline — they are
SCIP's blind spots and LSP running against the same committed snapshot rarely
resolves them any better. The name-based fallback (`resolveSymbolEdges`)
handles what it can; the rest stay `unresolved` until a future SCIP indexer
improvement covers them.

This runs in the same database but writes to a new generation, so existing
baseline rows (old generation) and overlay rows remain readable throughout.

**Step 3: Atomic promotion.**
In a single transaction:
1. Delete old baseline rows: `DELETE FROM files WHERE layer = 'baseline' AND generation < ?` (and cascading tables).
2. Clear overlay rows for files that are no longer dirty:
   ```sql
   DELETE FROM files WHERE layer = 'overlay'
     AND path NOT IN (SELECT path FROM dirty_files WHERE dirty_since > ?)
   ```
   (where `?` is the timestamp when the SCIP build started — files dirtied
   *during* the rebuild keep their overlay).
3. Remove promoted paths from `dirty_files`.
4. Set `lore_meta.generation = generation_pending`.
5. Set `lore_meta.baseline_head_sha = current HEAD`.
6. Rebuild `reverse_deps` from the new baseline.

**Step 4: Clean up.**
Run `PRAGMA incremental_vacuum` to reclaim space from deleted old-generation rows.

If the SCIP build fails, `generation_pending` is cleared and the old baseline
plus any overlay rows continue serving. No data is lost.

---

## Read Path (Query Layer)

### Core rule

For any query that touches `files`, `symbols`, `symbol_refs`, `type_refs`, or
`symbol_relationships`:

> **If a file appears in `dirty_files`, use its overlay rows. Otherwise, use
> its baseline rows.**

### Implementation: `effective_*` views

Create SQL views that implement the merge logic:

```sql
CREATE VIEW effective_files AS
SELECT * FROM files
WHERE (layer = 'overlay' AND path IN (SELECT path FROM dirty_files))
   OR (layer = 'baseline' AND path NOT IN (SELECT path FROM dirty_files));

CREATE VIEW effective_symbols AS
SELECT s.* FROM symbols s
JOIN effective_files f ON f.id = s.file_id
WHERE s.layer = f.layer;

CREATE VIEW effective_symbol_refs AS
SELECT sr.* FROM symbol_refs sr
JOIN effective_files f ON f.id = sr.file_id
WHERE sr.layer = f.layer;

-- (analogous for type_refs, symbol_relationships, etc.)
```

All MCP tool queries and read-only helpers in `db/read-only.ts` query from
`effective_*` views instead of raw tables.

For cross-file edges (e.g., caller in file A references callee in file B):
- The `symbol_refs` row belongs to file A's layer.
- The `callee_id` may point to a symbol in file B. If B is dirty, the callee
  might have been re-numbered. Handle this by:
  1. Preferring resolved refs (`callee_id IS NOT NULL`).
  2. For unresolved refs, falling back to name-based lookup at query time.
  3. Exposing a `freshness` field in tool responses (see below).

### Freshness metadata

Every MCP tool response gains an optional `freshness` field:

```typescript
interface FreshnessInfo {
  /** 'baseline' = all data from last full SCIP build.
      'mixed'    = some files use overlay data.
      'overlay'  = all queried files have overlay data. */
  source: 'baseline' | 'mixed' | 'overlay';
  /** Seconds since the baseline was last rebuilt. */
  baseline_age_s: number;
  /** Number of dirty files in the index. */
  dirty_file_count: number;
}
```

This lets agents know whether an answer came from stable SCIP truth or
live-but-lower-confidence overlay data.

---

## Pipeline Stage Changes

### New stages

| Stage | Phase | Purpose |
|-------|-------|---------|
| `ReverseDepsStage` | After resolution | Build/update `reverse_deps` from resolved imports + refs |
| `OverlayCleanupStage` | After baseline promotion | Remove stale overlay rows, clear `dirty_files` |

### Modified stages

| Stage | Change |
|-------|--------|
| `ScipSourceStage` | Write `layer = 'baseline'`, `generation = ctx.generation`. **Only runs in baseline builds** — never during overlay updates. |
| `SourceIndexStage` | **Primary incremental indexer in overlay mode**: write `layer = 'overlay'`, `generation = 0`. Do NOT delete baseline rows — only delete prior overlay rows for the same file. In baseline mode: compute metrics for SCIP-sourced files (existing behavior). |
| `LspEnrichmentStage` | **Cross-file enrichment for overlay only**. In overlay mode: enrich unresolved overlay refs + impact-set refs. **Not used in baseline builds** — SCIP is the sole authority for baseline resolution. Never used for structural extraction. |
| `ResolutionStage` | In overlay mode: scope `resolveSymbolEdges` to overlay refs only. |
| `EmbeddingStage` | In overlay mode: re-embed only changed symbols (existing behavior). |
| `ImportResolutionStage` | Feed newly resolved imports into `reverse_deps`. |

### Removed concepts

| Removed | Reason |
|---------|--------|
| `scipQuietPeriodMs` deferred SCIP flush in watcher/poller | Replaced by the background baseline rebuild trigger |
| Separate SCIP + tree-sitter update cycles in watcher | Single overlay update path replaces both |
| `changedFiles` cascading delete of baseline rows | Overlay rows coexist with baseline; no destructive invalidation |

---

## Trigger Model

```
File save / fs-event
  │
  ├─► Debounce 300ms
  │     └─► Overlay Update (tree-sitter + targeted LSP)
  │           ~50-500ms for 1-10 files
  │
  └─► Reset quiet timer (10s default)
        └─► Background Baseline Rebuild (full SCIP)
              ~5-60s depending on project size
              Writes to new generation
              Atomic promotion on success

HEAD change (git checkout, pull, rebase)
  └─► Background Baseline Rebuild (immediate, no quiet period)

Explicit CLI: lore refresh
  └─► Background Baseline Rebuild (blocking, waits for completion)
```

---

## Resolution Confidence Taxonomy

Extended from the existing `resolution-method.ts`:

| Method | Confidence | Layer | Source |
|--------|------------|-------|--------|
| `scip_definition` | Highest | baseline | SCIP pre-resolved |
| `lsp_definition` | High | either | LSP hover + definition |
| `name_same_file` | Medium | either | Name match within file |
| `name_unique` | Medium-Low | either | Unique name in index |
| `overlay_stale` | Low | overlay | Target was in a file that changed; ref not yet re-enriched |
| `external_definition` | — | either | Definition outside indexed set |
| `ambiguous_definition` | — | either | Multiple candidates |
| `unresolved` | — | either | No strategy succeeded |

The new `overlay_stale` method marks refs in impact-set files whose previous
`callee_id` target was invalidated by a file change but LSP re-enrichment
hasn't run yet. Query-time ranking deprioritizes these.

---

## Invariants

1. **Baseline is always complete.** After a successful build or background
   rebuild, every file in the project has baseline rows. Overlay rows are
   additive, never required for completeness.

2. **Overlay never deletes baseline.** Overlay rows coexist with baseline rows
   for the same file. Only baseline promotion (generation swap) removes old
   baseline rows.

3. **dirty_files is authoritative.** A file has active overlay data if and only
   if it appears in `dirty_files`. The query layer uses this as the switch.

4. **Generations are monotonic.** `lore_meta.generation` only increases. A
   failed background rebuild leaves the old generation in place.

5. **Cross-layer refs resolve by name.** A baseline ref's `callee_id` might
   point to a symbol that was re-numbered in the overlay. The query layer falls
   back to name-based lookup when `callee_id` does not exist in
   `effective_symbols`.

---

## Impact Set Bounding

To prevent LSP re-enrichment from spiraling into a full-project scan, the
impact set is bounded:

1. **Direct importers only.** `reverse_deps` with `dep_kind = 'import'` for
   the changed file. Typically 5-50 files.

2. **Max impact set size.** Cap at 100 files. If the changed file is a widely
   imported utility, skip LSP re-enrichment for the impact set and mark those
   refs `overlay_stale`. The next background baseline rebuild will fix them.

3. **Only exported-symbol refs.** Within the impact set, only re-enrich refs
   whose `callee_name` matches an exported symbol from the changed file. Skip
   internal-only symbol references.

4. **No transitive closure.** The impact set is 1-hop only. If A imports B
   imports C, and C changes, only B is in the impact set (not A). A's refs to
   C's symbols will be fixed by the baseline rebuild.

---

## File Lifecycle

### New file created

1. Overlay update: tree-sitter indexes it, inserts overlay rows.
2. Added to `dirty_files`.
3. Next baseline rebuild: SCIP indexes it, writes baseline rows, removes from
   `dirty_files`, overlay rows cleaned up.

### File modified

1. Prior overlay rows for this file deleted.
2. New overlay rows inserted from tree-sitter + LSP.
3. `dirty_files.dirty_since` updated.
4. Baseline rows untouched.
5. Next baseline rebuild promotes new baseline, cleans overlay.

### File deleted

1. Overlay update detects file missing.
2. Overlay rows for file deleted (if any).
3. File added to `dirty_files` with a sentinel (`deleted = true` or null path).
4. Query layer excludes this file from `effective_files`.
5. Baseline rows leak until next baseline rebuild cleans them.
6. Baseline rebuild: file absent from SCIP output, so no new baseline rows.
   Old baseline rows deleted during generation swap. `dirty_files` entry removed.

### File renamed (detected as delete + create)

Same as delete old + create new. Cross-file refs to the old path go stale
until baseline rebuild.

---

## Migration

Since backward compatibility is not required:

1. **Drop and recreate all tables** with the new `layer` and `generation`
   columns. No ALTER TABLE — clean DDL.

2. **Remove** the `ScipEnrichmentStage` entirely. The ScipSourceStage already
   writes enrichment data inline in the single-pass architecture. LSP
   enrichment handles the remainder.

3. **Remove** the separate SCIP quiet-period flush logic from
   `FileWatcher` and `FilePoller`. Replace with the unified overlay +
   background baseline model.

4. **Replace** `IndexBuilder.update()` with an `OverlayUpdatePipeline` that
   runs only: SourceIndex (tree-sitter) → ImportResolution → LspEnrichment
   (cross-file refs only) → Resolution (name fallback) → ReverseDeps →
   Embedding. **No SCIP stage** — tree-sitter is the primary incremental
   indexer, LSP is the cross-file enrichment layer.

5. **Replace** `IndexBuilder.build()` with a `BaselineBuildPipeline` that
   runs the full SCIP-primary chain and writes `layer = 'baseline'`.
   Tree-sitter participates for metrics and annotations only. **LSP is not
   used in baseline builds** — SCIP's unresolved refs stay unresolved.

6. **Rewrite** all queries in `db/read-only.ts` to use `effective_*` views.

7. **Add** `freshness` to all MCP tool response types.

---

## Performance Expectations

| Operation | Target Latency | Notes |
|-----------|---------------|-------|
| Overlay update (1 file) | < 100ms | Tree-sitter parse + insert |
| Overlay update (10 files + LSP) | < 500ms | Bounded LSP enrichment |
| Background baseline (small project, ~1k files) | 5-15s | Full SCIP + metrics |
| Background baseline (large project, ~10k files) | 30-90s | Full SCIP + metrics |
| Query with overlay merge | < 5ms overhead | View-based, indexed on layer |
| Baseline promotion (generation swap) | < 500ms | Single transaction, cascading deletes |

---

## Open Questions

1. **FTS5 and vec0 tables.** These virtual tables don't support arbitrary
   columns. Options: (a) rebuild FTS5 during promotion only, (b) maintain
   separate overlay FTS entries keyed by rowid ranges, (c) accept stale FTS
   during overlay and rebuild on promotion. Recommendation: **(c)** — FTS is
   used for search, not graph queries. A few seconds of stale search results
   during active editing is acceptable.

2. **Embedding staleness.** Re-embedding is expensive. During overlay updates,
   re-embed only changed symbols. During baseline promotion, do a full
   diff-based re-embed pass. This matches the current `EmbeddingStage` behavior.

---

## Why Overlay Complexity Is Justified: Multi-Agent Scenarios

The overlay layer adds significant complexity (layer columns, generation
counters, `dirty_files`, `reverse_deps`, `effective_*` views, freshness
metadata). This complexity is justified primarily by concurrent-writer
scenarios:

1. **Agent-to-agent visibility.** When multiple agents edit concurrently,
   Agent B needs to see Agent A's changes reflected in the index within
   milliseconds, not after a 5-90 second SCIP rebuild. Without the overlay,
   every agent operates on stale data from the last baseline.

2. **Cascading staleness compounds.** Agent A edits file X, Agent B edits
   file Y (which imports X), Agent C queries the call graph spanning both.
   Each agent's changes are invisible to the others until the next baseline
   rebuild. The index drifts further from reality with every concurrent edit.

3. **SCIP rebuilds serialize poorly.** If agents trigger edits faster than
   SCIP can rebuild, the baseline is perpetually behind. The overlay absorbs
   rapid-fire changes at tree-sitter speed (~5-50ms per file) while SCIP
   catches up in the background.

4. **Agents don't pause to think.** A human developer might save, read
   output, and think for 30 seconds. An agent saves, immediately queries,
   and acts on the result. The effective latency budget between write and
   read is near zero.

5. **Freshness metadata enables trust decisions.** The `FreshnessInfo` on
   MCP tool responses lets agents decide whether to trust overlay data or
   wait for a baseline rebuild before making high-stakes decisions (e.g.,
   large-scale refactors).

For single-developer workflows, the 5-90s SCIP gap is often tolerable. For
multi-agent orchestration — which is Lore's primary use case — the overlay
is the difference between correct coordination and cascading errors.

3. **WAL mode contention.** Background baseline writes while the MCP server
   reads. SQLite WAL mode handles this natively (readers see a consistent
   snapshot, writers don't block readers). The promotion transaction should be
   kept short to minimize write-lock duration.

4. **Multiple dirty files referencing each other.** If files A and B are both
   dirty and A imports B, the overlay for A should reference overlay symbols
   from B. This works naturally because `effective_files` returns overlay for
   both, and `effective_symbols` joins through the correct layer.
