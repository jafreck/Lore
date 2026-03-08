/**
 * @module indexer/call-graph
 *
 * Call-graph utilities operating on the SQLite knowledge-base:
 *
 *  - `buildCallGraph(db)` — resolves raw callee names in `symbol_refs` to
 *    concrete symbol IDs where possible (pass 1: name-based, pass 2:
 *    definition-path-based for indirect / macro calls).
 *  - `topoSort(db)` — topological ordering of files based on `file_imports`
 *    using Kahn's algorithm.
 *  - `detectCycles(db)` — cycle detection over the `file_imports` graph using
 *    Tarjan's strongly-connected-components algorithm.
 */

import type { Database } from './db.js';

// ─── buildCallGraph ───────────────────────────────────────────────────────────

/**
 * Resolves unresolved `symbol_refs` rows in two passes:
 *
 * **Pass 1 (name-based):** looks up `callee_name` in the `symbols` table by
 * exact name match, preferring same-file matches for common identifiers.
 *
 * **Pass 2 (definition-path-based):** for refs still unresolved after pass 1,
 * attempts to match via `definition_path` written by LSP enrichment.  This
 * covers function-pointer calls and macro invocations whose names don't appear
 * in the `symbols` table directly, but whose LSP-resolved definition locations
 * do correspond to known symbol files / lines.
 */
export function buildCallGraph(db: Database.Database): void {
  resolveByName(db);
  resolveByDefinitionPath(db);
}

// ─── Pass 1: name-based resolution ──────────────────────────────────────────

function resolveByName(db: Database.Database): void {
  // Build a multimap: symbol name → array of { id, file_id }
  const nameToSymbols = new Map<string, Array<{ id: number; file_id: number }>>();
  const allSymbols = db
    .prepare('SELECT id, name, file_id FROM symbols')
    .all() as Array<{ id: number; name: string; file_id: number }>;
  for (const row of allSymbols) {
    let list = nameToSymbols.get(row.name);
    if (!list) {
      list = [];
      nameToSymbols.set(row.name, list);
    }
    list.push({ id: row.id, file_id: row.file_id });
  }

  // Fetch all unresolved refs along with the caller's file_id for proximity.
  const unresolved = db
    .prepare(
      `SELECT sr.id, sr.callee_name, s.file_id AS caller_file_id
         FROM symbol_refs sr
         JOIN symbols s ON s.id = sr.caller_id
        WHERE sr.callee_id IS NULL`,
    )
    .all() as Array<{ id: number; callee_name: string; caller_file_id: number }>;

  const update = db.prepare('UPDATE symbol_refs SET callee_id = ? WHERE id = ?');

  const updateMany = db.transaction(() => {
    for (const ref of unresolved) {
      const candidates = nameToSymbols.get(ref.callee_name);
      if (!candidates || candidates.length === 0) continue;

      // Prefer same-file match for common names like init, new, parse.
      const sameFile = candidates.find(c => c.file_id === ref.caller_file_id);
      const best = sameFile ?? candidates[0]!;
      update.run(best.id, ref.id);
    }
  });

  updateMany();
}

// ─── Pass 2: definition-path-based resolution ───────────────────────────────

/**
 * For `symbol_refs` rows that:
 *   - still have `callee_id IS NULL`, AND
 *   - have a non-null `definition_path` (written by LSP enrichment),
 *
 * this pass tries to find a symbol in the `symbols` table whose file matches
 * the definition path.  When there are multiple symbols in that file, the one
 * closest to the enriched definition line (approximated by `resolved_type_signature`
 * presence) is chosen; otherwise the first symbol defined in that file is used.
 *
 * This is the primary mechanism for resolving:
 *   - Function-pointer calls (`(*callback)(...)`) — clangd resolves the pointer
 *     to its original declaration location.
 *   - Macro invocations (`MY_MACRO(...)`) — clangd resolves to the `#define` site.
 */
function resolveByDefinitionPath(db: Database.Database): void {
  // Build a map: normalised file path → array of { id, start_line }
  const pathToSymbols = new Map<string, Array<{ id: number; start_line: number }>>();
  const allSymbols = db
    .prepare(
      `SELECT s.id, s.start_line, f.path
       FROM symbols s
       JOIN files f ON f.id = s.file_id`,
    )
    .all() as Array<{ id: number; start_line: number; path: string }>;
  for (const row of allSymbols) {
    let list = pathToSymbols.get(row.path);
    if (!list) {
      list = [];
      pathToSymbols.set(row.path, list);
    }
    list.push({ id: row.id, start_line: row.start_line });
  }

  const unresolved = db
    .prepare(
      `SELECT sr.id, sr.definition_path
       FROM symbol_refs sr
       WHERE sr.callee_id IS NULL
         AND sr.definition_path IS NOT NULL`,
    )
    .all() as Array<{ id: number; definition_path: string }>;

  if (unresolved.length === 0) return;

  const update = db.prepare('UPDATE symbol_refs SET callee_id = ? WHERE id = ?');

  const updateMany = db.transaction(() => {
    for (const ref of unresolved) {
      const candidates = pathToSymbols.get(ref.definition_path);
      if (!candidates || candidates.length === 0) continue;

      // If only one symbol in the file, use it directly.
      if (candidates.length === 1) {
        update.run(candidates[0]!.id, ref.id);
        continue;
      }

      // Multiple symbols: pick the first defined (lowest start_line).
      // A more precise heuristic would use the definition line from the LSP
      // URI fragment, but definition_path currently stores only the file path.
      const sorted = [...candidates].sort((a, b) => a.start_line - b.start_line);
      update.run(sorted[0]!.id, ref.id);
    }
  });

  updateMany();
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
