/**
 * @module indexer/call-graph
 *
 * Call-graph and cross-reference resolution utilities operating on the
 * SQLite knowledge-base:
 *
 *  - `resolveSymbolEdges(db)` — resolves raw names in `symbol_refs`,
 *    `type_refs`, and `symbol_relationships` to concrete symbol IDs.
 *  - `normalizeTypeName(raw)` — strips qualifiers/generics/pointers to
 *    produce a bare type name for fallback matching.
 *  - `topoSort(db)` — topological ordering of files based on `file_imports`
 *    using Kahn's algorithm.
 *  - `detectCycles(db)` — cycle detection over the `file_imports` graph using
 *    Tarjan's strongly-connected-components algorithm.
 */

import type { Database } from './db.js';
import type { ResolutionMethod } from './resolution-method.js';

// ─── normalizeTypeName ────────────────────────────────────────────────────────

/**
 * Produces a bare type name from a raw type reference for fallback matching.
 *
 * Steps:
 * 1. Strip CV qualifiers
 * 2. Strip type-intro keywords (struct, enum, union, class)
 * 3. Strip Rust reference/lifetime syntax
 * 4. Strip pointer/reference suffixes
 * 5. Truncate at first `<`
 * 6. Take the last segment after `::` or `.`
 * 7. Trim whitespace
 */
export function normalizeTypeName(raw: string): string {
  let s = raw;
  // 1. Strip CV qualifiers (word-bounded)
  s = s.replace(/\b(const|volatile|restrict|mutable)\b/g, '');
  // 2. Strip type-intro keywords (word-bounded)
  s = s.replace(/\b(struct|enum|union|class)\b/g, '');
  // 3. Strip Rust reference/lifetime syntax: &'lifetime_name, &mut, &
  s = s.replace(/^&'[a-zA-Z_]\w*\s+(mut\s+)?/, '');
  s = s.replace(/^&mut\s+/, '');
  s = s.replace(/^&/, '');
  // 4. Strip pointer/reference suffixes and nullable `?` (Kotlin, C#, Swift)
  s = s.replace(/[\*&\[\]?]+$/, '');
  // 4b. Function pointer syntax — if there's a remaining (*) pattern, it's not a named type
  if (/\(\s*\*\s*\)/.test(s)) return '';
  // 5. Truncate at first `<`
  const ltIdx = s.indexOf('<');
  if (ltIdx !== -1) s = s.slice(0, ltIdx);
  // 6. Take last segment after `::` or `.`
  const colonIdx = s.lastIndexOf('::');
  if (colonIdx !== -1) {
    s = s.slice(colonIdx + 2);
  } else {
    const dotIdx = s.lastIndexOf('.');
    if (dotIdx !== -1) s = s.slice(dotIdx + 1);
  }
  // 7. Trim
  return s.trim();
}

/**
 * Extract the bare method/function name from a member-access callee,
 * stripping the receiver portion.
 *
 * Examples:
 *   `db.prepare`           → `prepare`
 *   `node.childForFieldName` → `childForFieldName`
 *   `JSON.stringify`       → `stringify`
 *   `Math.max`             → `max`
 *   `node.namedChildren.find` → `find`
 *   `console.error`        → `error`
 *   `simpleName`           → `simpleName` (no change)
 */
export function extractBareName(raw: string): string {
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx === -1) return raw;
  // Handle multi-line callee names like "db\n    .prepare"
  const after = raw.slice(dotIdx + 1).trim();
  return after || raw;
}

// ─── resolveSymbolEdges ───────────────────────────────────────────────────────

/**
 * Resolves unresolved edges in `symbol_refs`, `type_refs`, and
 * `symbol_relationships` using a layered resolution strategy:
 *
 *   1. **LSP containment mapping** (`lsp_definition`) — when `definition_path`
 *      + `definition_line` are populated, map to the narrowest enclosing symbol.
 *   2. **Same-file name match** (`name_same_file`) — if the ref name matches
 *      exactly one symbol in the same file, resolve it.
 *   3. **Globally unique name** (`name_unique`) — if the ref name matches
 *      exactly one symbol across the entire index, resolve it.
 *   4. Leave as `unresolved` / `external_definition` otherwise.
 */
export function resolveSymbolEdges(db: Database.Database): void {
  const runInTransaction = db.transaction(() => {
    // Pass 1: LSP containment mapping (highest confidence)
    resolveByContainment(db, 'symbol_refs', 'callee_id', 'definition_path', 'definition_line');
    resolveByContainment(db, 'type_refs', 'type_id', 'definition_path', 'definition_line');
    resolveByContainment(db, 'symbol_relationships', 'target_symbol_id', 'definition_path', 'definition_line');

    // Pass 2: Name-based fallback for remaining unresolved refs
    const nameMap = buildNameMap(db);

    resolveByNameFallback(db, nameMap, {
      tableName: 'symbol_refs',
      targetIdColumn: 'callee_id',
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.callee_name AS target_name, s.file_id AS source_file_id
         FROM symbol_refs sr
         JOIN symbols s ON s.id = sr.caller_id
         WHERE sr.callee_id IS NULL AND sr.resolution_method = 'unresolved'`,
      ),
    });

    // Pass 2b: Bare-name fallback for member-access call refs.
    // When `db.prepare` can't match, try just `prepare`.
    // This resolves ~73% of tree-sitter call refs that use dotted names.
    resolveByNameFallback(db, nameMap, {
      tableName: 'symbol_refs',
      targetIdColumn: 'callee_id',
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.callee_name AS target_name, s.file_id AS source_file_id
         FROM symbol_refs sr
         JOIN symbols s ON s.id = sr.caller_id
         WHERE sr.callee_id IS NULL AND sr.resolution_method = 'unresolved'
           AND sr.callee_name LIKE '%.%'`,
      ),
      normalizeTargetName: extractBareName,
    });

    resolveByNameFallback(db, nameMap, {
      tableName: 'type_refs',
      targetIdColumn: 'type_id',
      selectUnresolved: db.prepare(
        `SELECT tr.id, tr.type_name AS target_name, COALESCE(s.file_id, tr.file_id) AS source_file_id
         FROM type_refs tr LEFT JOIN symbols s ON s.id = tr.symbol_id
         WHERE tr.type_id IS NULL AND tr.resolution_method = 'unresolved'`,
      ),
    });

    // type_refs bare-name fallback pass
    resolveByNameFallback(db, nameMap, {
      tableName: 'type_refs',
      targetIdColumn: 'type_id',
      selectUnresolved: db.prepare(
        `SELECT tr.id, tr.type_name_bare AS target_name, COALESCE(s.file_id, tr.file_id) AS source_file_id
         FROM type_refs tr LEFT JOIN symbols s ON s.id = tr.symbol_id
         WHERE tr.type_id IS NULL AND tr.resolution_method = 'unresolved'
           AND tr.type_name_bare != tr.type_name`,
      ),
    });

    resolveByNameFallback(db, nameMap, {
      tableName: 'symbol_relationships',
      targetIdColumn: 'target_symbol_id',
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.target_symbol_name AS target_name, COALESCE(s.file_id, sr.file_id) AS source_file_id
         FROM symbol_relationships sr LEFT JOIN symbols s ON s.id = sr.source_symbol_id
         WHERE sr.target_symbol_id IS NULL AND sr.resolution_method = 'unresolved'`,
      ),
      normalizeTargetName: normalizeTypeName,
    });
  });

  runInTransaction();
}

// ─── Containment-based resolution ─────────────────────────────────────────────

interface UnresolvedRefRow {
  id: number;
  definition_path: string;
  definition_line: number;
}

interface SymbolCandidate {
  id: number;
  start_line: number;
  end_line: number;
}

/**
 * Resolves refs in `tableName` by mapping `definition_path`+`definition_line`
 * to the narrowest enclosing symbol in the indexed files.
 *
 * Uses batched lookups: groups refs by definition_path, resolves the file and
 * its symbols once per path, then resolves all refs for that path in memory.
 */
function resolveByContainment(
  db: Database.Database,
  tableName: string,
  targetIdColumn: string,
  defPathColumn: string,
  defLineColumn: string,
): void {
  const unresolvedWithDef = db.prepare(
    `SELECT id, ${defPathColumn} AS definition_path, ${defLineColumn} AS definition_line
     FROM ${tableName}
     WHERE ${targetIdColumn} IS NULL
       AND ${defPathColumn} IS NOT NULL
       AND ${defLineColumn} IS NOT NULL`,
  ).all() as UnresolvedRefRow[];

  if (unresolvedWithDef.length === 0) {
    db.prepare(
      `UPDATE ${tableName} SET resolution_method = 'unresolved'
       WHERE ${targetIdColumn} IS NULL AND resolution_method = 'unresolved'`,
    ).run();
    return;
  }

  // P6: Build a bulk path→fileId map so we do one query instead of N.
  const fileIdByPath = new Map<string, number>(
    (db.prepare('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>)
      .map(r => [r.path, r.id]),
  );

  // Group refs by definition_path for batched symbol lookup.
  const refsByPath = new Map<string, UnresolvedRefRow[]>();
  for (const ref of unresolvedWithDef) {
    let list = refsByPath.get(ref.definition_path);
    if (!list) {
      list = [];
      refsByPath.set(ref.definition_path, list);
    }
    list.push(ref);
  }

  const findSymbolsByFile = db.prepare(
    `SELECT id, start_line, end_line FROM symbols WHERE file_id = ? ORDER BY (end_line - start_line) ASC`,
  );
  const updateResolved = db.prepare(
    `UPDATE ${tableName} SET ${targetIdColumn} = ?, resolution_method = ? WHERE id = ?`,
  );
  const updateMethod = db.prepare(
    `UPDATE ${tableName} SET resolution_method = ? WHERE id = ?`,
  );

  for (const [defPath, refs] of refsByPath) {
    const fileId = fileIdByPath.get(defPath);
    if (fileId === undefined) {
      for (const ref of refs) {
        updateMethod.run('external_definition' satisfies ResolutionMethod, ref.id);
      }
      continue;
    }

    // Load all symbols for this file once, sorted narrowest-first.
    const symbols = findSymbolsByFile.all(fileId) as SymbolCandidate[];

    for (const ref of refs) {
      const candidates = symbols.filter(
        s => s.start_line <= ref.definition_line && s.end_line >= ref.definition_line,
      );

      if (candidates.length === 0) {
        updateMethod.run('unresolved' satisfies ResolutionMethod, ref.id);
        continue;
      }

      const narrowest = candidates[0]!;
      const narrowestSpan = narrowest.end_line - narrowest.start_line;
      const equallyNarrow = candidates.filter(
        c => (c.end_line - c.start_line) === narrowestSpan,
      );

      if (equallyNarrow.length === 1) {
        updateResolved.run(narrowest.id, 'lsp_definition' satisfies ResolutionMethod, ref.id);
      } else {
        updateMethod.run('ambiguous_definition' satisfies ResolutionMethod, ref.id);
      }
    }
  }

  // Mark remaining rows with no definition data as unresolved
  db.prepare(
    `UPDATE ${tableName} SET resolution_method = 'unresolved'
     WHERE ${targetIdColumn} IS NULL AND resolution_method = 'unresolved'
       AND (${defPathColumn} IS NULL OR ${defLineColumn} IS NULL)`,
  ).run();
}

// ─── Name-based fallback resolution ───────────────────────────────────────────

/**
 * Symbol kinds that should never be resolved across file boundaries via
 * the `name_unique` tier.  These are common sources of false positive
 * edges (e.g. `MIN`, `MAX`, `main`) that inflate SCC sizes.
 */
const CROSS_FILE_EXCLUDED_KINDS = new Set([
  'macro',
  'constant',
  'enum_member',
]);

interface NameMapEntry {
  id: number;
  file_id: number;
  kind: string;
}

/**
 * Builds a map from symbol name → array of { id, file_id, kind } for all symbols.
 * Used by the name-based fallback pass.
 */
function buildNameMap(db: Database.Database): Map<string, NameMapEntry[]> {
  const nameToSymbols = new Map<string, NameMapEntry[]>();
  const allSymbols = db
    .prepare('SELECT id, name, file_id, kind FROM symbols')
    .all() as Array<{ id: number; name: string; file_id: number; kind: string }>;
  for (const row of allSymbols) {
    let list = nameToSymbols.get(row.name);
    if (!list) {
      list = [];
      nameToSymbols.set(row.name, list);
    }
    list.push({ id: row.id, file_id: row.file_id, kind: row.kind });
  }
  return nameToSymbols;
}

interface NameFallbackConfig {
  tableName: string;
  targetIdColumn: string;
  selectUnresolved: Database.Statement;
  /** Optional normalizer for the target name (e.g. normalizeTypeName). */
  normalizeTargetName?: (raw: string) => string;
}

/**
 * Resolves remaining unresolved refs by name matching with two confidence tiers:
 *
 * - `name_same_file`: target name matches exactly one symbol in the same file
 * - `name_unique`: target name matches exactly one symbol in the entire index,
 *   **excluding** macro/constant/enum_member symbols that commonly produce
 *   false cross-file edges (e.g. `MIN`, `MAX`, `main`).
 *
 * Non-unique cross-file matches are left as `unresolved`.
 */
function resolveByNameFallback(
  db: Database.Database,
  nameToSymbols: Map<string, NameMapEntry[]>,
  config: NameFallbackConfig,
): void {
  const unresolved = config.selectUnresolved.all() as Array<{
    id: number;
    target_name: string;
    source_file_id: number;
  }>;

  if (unresolved.length === 0) return;

  const updateResolved = db.prepare(
    `UPDATE ${config.tableName} SET ${config.targetIdColumn} = ?, resolution_method = ? WHERE id = ?`,
  );

  for (const ref of unresolved) {
    // Look up candidates by name
    let candidates = nameToSymbols.get(ref.target_name);

    // Try normalized name if direct match fails
    if ((!candidates || candidates.length === 0) && config.normalizeTargetName) {
      const normalized = config.normalizeTargetName(ref.target_name);
      if (normalized && normalized !== ref.target_name) {
        candidates = nameToSymbols.get(normalized);
      }
    }

    if (!candidates || candidates.length === 0) continue;

    // Tier 1: same-file unique match
    const sameFile = candidates.filter(c => c.file_id === ref.source_file_id);
    if (sameFile.length === 1) {
      updateResolved.run(sameFile[0]!.id, 'name_same_file' satisfies ResolutionMethod, ref.id);
      continue;
    }

    // Tier 2: globally unique match (exactly one symbol with this name).
    // Filter out macro/constant/enum_member kinds — these cause false
    // cross-file edges (e.g. MIN, MAX, main in C/C++).
    const crossFileEligible = candidates.filter(
      c => !CROSS_FILE_EXCLUDED_KINDS.has(c.kind),
    );
    if (crossFileEligible.length === 1) {
      updateResolved.run(crossFileEligible[0]!.id, 'name_unique' satisfies ResolutionMethod, ref.id);
      continue;
    }

    // Non-unique cross-file: leave as unresolved (option B)
  }
}

// ─── topoSort ─────────────────────────────────────────────────────────────────

/**
 * Returns file IDs in topologically sorted order (dependencies before
 * dependents) using Kahn's algorithm over the `file_imports` graph.
 *
 * Files that are part of a cycle are excluded from the returned list (they
 * have no valid topological position).  Use `detectCycles()` to identify them.
 */
export function topoSort(db: Database.Database): string[] {
  // Build adjacency: importer → set of importees (edges point from user to dep)
  // For topological sort we need: dep comes before user, so reverse edges.
  // adjacency[dep] → [users]
  // in-degree[user] = number of deps it imports

  const allFiles = db
    .prepare('SELECT id FROM files')
    .all() as Array<{ id: number }>;

  const fileIds = allFiles.map(r => String(r.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → users

  for (const id of fileIds) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  const edges = db
    .prepare(
      `SELECT fi.file_id AS importer, fi.resolved_id AS dep
       FROM file_imports fi
       WHERE fi.resolved_id IS NOT NULL`,
    )
    .all() as Array<{ importer: number; dep: number }>;

  for (const { importer, dep } of edges) {
    const importerStr = String(importer);
    const depStr = String(dep);

    if (!inDegree.has(importerStr) || !inDegree.has(depStr)) continue;

    // importer has one more dependency
    inDegree.set(importerStr, (inDegree.get(importerStr) ?? 0) + 1);
    dependents.get(depStr)!.push(importerStr);
  }

  // Queue all nodes with in-degree 0 (no dependencies)
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    for (const dependent of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        queue.push(dependent);
      }
    }
  }

  return sorted;
}

// ─── detectCycles ─────────────────────────────────────────────────────────────

/**
 * Detects cycles in the `file_imports` graph using Tarjan's
 * strongly-connected-components (SCC) algorithm.
 *
 * Returns an array of SCCs where each SCC has more than one node (or a
 * single node with a self-loop).  Each SCC is represented as an array of
 * file IDs (as strings).
 */
export function detectCycles(db: Database.Database): string[][] {
  const allFiles = db
    .prepare('SELECT id FROM files')
    .all() as Array<{ id: number }>;

  // Build adjacency list: importer → [dep, ...]
  const adjacency = new Map<string, string[]>();
  for (const { id } of allFiles) {
    adjacency.set(String(id), []);
  }

  const edges = db
    .prepare(
      `SELECT fi.file_id AS importer, fi.resolved_id AS dep
       FROM file_imports fi
       WHERE fi.resolved_id IS NOT NULL`,
    )
    .all() as Array<{ importer: number; dep: number }>;

  for (const { importer, dep } of edges) {
    const imp = String(importer);
    const d = String(dep);
    if (adjacency.has(imp)) {
      adjacency.get(imp)!.push(d);
    }
  }

  // Tarjan's SCC
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  function strongConnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.set(v, true);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.get(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);

      // Self-loops: check if any node in the scc has an edge to itself
      if (scc.length > 1) {
        sccs.push(scc);
      } else {
        // Single-node SCC — only a cycle if there's a self-loop
        const selfLoop = (adjacency.get(scc[0]!) ?? []).includes(scc[0]!);
        if (selfLoop) sccs.push(scc);
      }
    }
  }

  for (const { id } of allFiles) {
    const v = String(id);
    if (!indices.has(v)) {
      strongConnect(v);
    }
  }

  return sccs;
}
