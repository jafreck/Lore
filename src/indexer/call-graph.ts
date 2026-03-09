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
 * `symbol_relationships` using name-based and definition-path-based passes.
 *
 * Replaces the old `buildCallGraph()`.
 */
export function resolveSymbolEdges(db: Database.Database): void {
  const nameToSymbols = buildNameMap(db);
  const pathToSymbols = buildPathMap(db);

  const runInTransaction = db.transaction(() => {
    // ── symbol_refs: name-based, then definition-path ──
    resolveByNameGeneric(nameToSymbols, {
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.callee_name AS target_name, s.file_id AS source_file_id
         FROM symbol_refs sr JOIN symbols s ON s.id = sr.caller_id
         WHERE sr.callee_id IS NULL`,
      ),
      update: db.prepare('UPDATE symbol_refs SET callee_id = ? WHERE id = ?'),
    });
    resolveByDefinitionPathGeneric(pathToSymbols, {
      selectUnresolved: db.prepare(
        `SELECT id, definition_path FROM symbol_refs WHERE callee_id IS NULL AND definition_path IS NOT NULL`,
      ),
      update: db.prepare('UPDATE symbol_refs SET callee_id = ? WHERE id = ?'),
    });

    // ── type_refs: qualified name first, then bare fallback ──
    resolveByNameGeneric(nameToSymbols, {
      selectUnresolved: db.prepare(
        `SELECT tr.id, tr.type_name AS target_name, COALESCE(s.file_id, tr.file_id) AS source_file_id
         FROM type_refs tr LEFT JOIN symbols s ON s.id = tr.symbol_id
         WHERE tr.type_id IS NULL`,
      ),
      update: db.prepare('UPDATE type_refs SET type_id = ? WHERE id = ?'),
    });
    resolveByNameGeneric(nameToSymbols, {
      selectUnresolved: db.prepare(
        `SELECT tr.id, tr.type_name_bare AS target_name, COALESCE(s.file_id, tr.file_id) AS source_file_id
         FROM type_refs tr LEFT JOIN symbols s ON s.id = tr.symbol_id
         WHERE tr.type_id IS NULL AND tr.type_name_bare != tr.type_name`,
      ),
      update: db.prepare('UPDATE type_refs SET type_id = ? WHERE id = ?'),
    });
    resolveByDefinitionPathGeneric(pathToSymbols, {
      selectUnresolved: db.prepare(
        `SELECT id, definition_path FROM type_refs WHERE type_id IS NULL AND definition_path IS NOT NULL`,
      ),
      update: db.prepare('UPDATE type_refs SET type_id = ? WHERE id = ?'),
    });

    // ── symbol_relationships ──
    resolveByNameGeneric(nameToSymbols, {
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.target_symbol_name AS target_name, COALESCE(s.file_id, sr.file_id) AS source_file_id
         FROM symbol_relationships sr LEFT JOIN symbols s ON s.id = sr.source_symbol_id
         WHERE sr.target_symbol_id IS NULL`,
      ),
      update: db.prepare('UPDATE symbol_relationships SET target_symbol_id = ? WHERE id = ?'),
      normalizeTargetName: normalizeTypeName,
    });
    resolveByDefinitionPathGeneric(pathToSymbols, {
      selectUnresolved: db.prepare(
        `SELECT id, definition_path FROM symbol_relationships WHERE target_symbol_id IS NULL AND definition_path IS NOT NULL`,
      ),
      update: db.prepare('UPDATE symbol_relationships SET target_symbol_id = ? WHERE id = ?'),
    });
  });

  runInTransaction();
}

/** @deprecated Use `resolveSymbolEdges` instead. */
export function buildCallGraph(db: Database.Database): void {
  resolveSymbolEdges(db);
}

// ─── Shared lookup maps ───────────────────────────────────────────────────────

function buildNameMap(db: Database.Database): Map<string, Array<{ id: number; file_id: number }>> {
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
  return nameToSymbols;
}

function buildPathMap(db: Database.Database): Map<string, Array<{ id: number; start_line: number }>> {
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
  return pathToSymbols;
}

// ─── Generic resolution helpers ─────────────────────────────────────────────

interface ResolutionConfig {
  selectUnresolved: Database.Statement;
  update: Database.Statement;
  normalizeTargetName?: (raw: string) => string;
}

function resolveByNameGeneric(
  nameToSymbols: Map<string, Array<{ id: number; file_id: number }>>,
  config: ResolutionConfig,
): void {
  const unresolved = config.selectUnresolved.all() as Array<{
    id: number;
    target_name: string;
    source_file_id: number;
  }>;

  const updateMany = () => {
    for (const ref of unresolved) {
      let candidates = nameToSymbols.get(ref.target_name);
      if ((!candidates || candidates.length === 0) && config.normalizeTargetName) {
        const normalized = config.normalizeTargetName(ref.target_name);
        if (normalized && normalized !== ref.target_name) {
          candidates = nameToSymbols.get(normalized);
        }
      }
      if (!candidates || candidates.length === 0) continue;

      const sameFile = candidates.find(c => c.file_id === ref.source_file_id);
      const best = sameFile ?? candidates[0]!;
      config.update.run(best.id, ref.id);
    }
  };

  updateMany();
}

function resolveByDefinitionPathGeneric(
  pathToSymbols: Map<string, Array<{ id: number; start_line: number }>>,
  config: ResolutionConfig,
): void {
  const unresolved = config.selectUnresolved.all() as Array<{
    id: number;
    definition_path: string;
  }>;

  if (unresolved.length === 0) return;

  for (const ref of unresolved) {
    const candidates = pathToSymbols.get(ref.definition_path);
    if (!candidates || candidates.length === 0) continue;

    if (candidates.length === 1) {
      config.update.run(candidates[0]!.id, ref.id);
      continue;
    }

    const sorted = [...candidates].sort((a, b) => a.start_line - b.start_line);
    config.update.run(sorted[0]!.id, ref.id);
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
