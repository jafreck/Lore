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

// ─── resolveSymbolEdges ───────────────────────────────────────────────────────

/**
 * Resolves unresolved edges in `symbol_refs`, `type_refs`, and
 * `symbol_relationships` using LSP definition locations and containment
 * mapping. Replaces the old heuristic name-based and path-based resolution.
 *
 * For each ref with a populated `definition_path` + `definition_line`:
 *   1. If the definition is outside the project (no matching file) → `external_definition`
 *   2. Find all symbols in the target file containing `definition_line`
 *   3. Pick the narrowest enclosing symbol → `lsp_definition`
 *   4. If ambiguous (multiple equally-narrow) → `ambiguous_definition`
 *   5. If no definition data → `unresolved`
 */
export function resolveSymbolEdges(db: Database.Database): void {
  const runInTransaction = db.transaction(() => {
    resolveByContainment(db, 'symbol_refs', 'callee_id', 'definition_path', 'definition_line');
    resolveByContainment(db, 'type_refs', 'type_id', 'definition_path', 'definition_line');
    resolveByContainment(db, 'symbol_relationships', 'target_symbol_id', 'definition_path', 'definition_line');
  });

  runInTransaction();
}

/** @deprecated Use `resolveSymbolEdges` instead. */
export function buildCallGraph(db: Database.Database): void {
  resolveSymbolEdges(db);
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
 */
function resolveByContainment(
  db: Database.Database,
  tableName: string,
  targetIdColumn: string,
  defPathColumn: string,
  defLineColumn: string,
): void {
  // 1. Select rows with definition info but no target yet
  const unresolvedWithDef = db.prepare(
    `SELECT id, ${defPathColumn} AS definition_path, ${defLineColumn} AS definition_line
     FROM ${tableName}
     WHERE ${targetIdColumn} IS NULL
       AND ${defPathColumn} IS NOT NULL
       AND ${defLineColumn} IS NOT NULL`,
  ).all() as UnresolvedRefRow[];

  if (unresolvedWithDef.length === 0) {
    // Mark remaining null-target rows as unresolved
    db.prepare(
      `UPDATE ${tableName} SET resolution_method = 'unresolved'
       WHERE ${targetIdColumn} IS NULL AND resolution_method = 'unresolved'`,
    ).run();
    return;
  }

  // Prepare statements
  const findFileByPath = db.prepare('SELECT id FROM files WHERE path = ? LIMIT 1');
  const findSymbolsContaining = db.prepare(
    `SELECT id, start_line, end_line FROM symbols
     WHERE file_id = ? AND start_line <= ? AND end_line >= ?
     ORDER BY (end_line - start_line) ASC`,
  );
  const updateResolved = db.prepare(
    `UPDATE ${tableName} SET ${targetIdColumn} = ?, resolution_method = ? WHERE id = ?`,
  );
  const updateMethod = db.prepare(
    `UPDATE ${tableName} SET resolution_method = ? WHERE id = ?`,
  );

  for (const ref of unresolvedWithDef) {
    // Find the file in the index
    const fileRow = findFileByPath.get(ref.definition_path) as { id: number } | undefined;

    if (!fileRow) {
      // Definition path not in index → external (node_modules, stdlib, etc.)
      updateMethod.run('external_definition', ref.id);
      continue;
    }

    // Find symbols containing the definition line
    const candidates = findSymbolsContaining.all(
      fileRow.id,
      ref.definition_line,
      ref.definition_line,
    ) as SymbolCandidate[];

    if (candidates.length === 0) {
      // No symbol contains this line (e.g. top-level code)
      updateMethod.run('unresolved', ref.id);
      continue;
    }

    // Candidates are already sorted by (end_line - start_line) ASC (narrowest first)
    const narrowest = candidates[0]!;
    const narrowestSpan = narrowest.end_line - narrowest.start_line;

    // Check for ambiguity: multiple candidates with identical span width
    const equallyNarrow = candidates.filter(
      c => (c.end_line - c.start_line) === narrowestSpan,
    );

    if (equallyNarrow.length === 1) {
      // Unique best match
      updateResolved.run(narrowest.id, 'lsp_definition', ref.id);
    } else {
      // Ambiguous: multiple symbols with the same span
      updateMethod.run('ambiguous_definition', ref.id);
    }
  }

  // Mark remaining rows with no definition data as unresolved
  db.prepare(
    `UPDATE ${tableName} SET resolution_method = 'unresolved'
     WHERE ${targetIdColumn} IS NULL AND resolution_method = 'unresolved'
       AND (${defPathColumn} IS NULL OR ${defLineColumn} IS NULL)`,
  ).run();
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
