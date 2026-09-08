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

import type { Database } from '../db/schema.js';
import type { ResolutionMethod } from './resolution-method.js';
import { reconcileEffectiveTargets } from './effective-targets.js';

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
export function resolveSymbolEdges(db: Database.Database, options?: { overlayOnly?: boolean; branch?: string }): void {
  const runInTransaction = db.transaction(() => {
    // Overlay updates can hide a baseline target while the source edge remains
    // an effective baseline row in an unchanged file. Repair those IDs before
    // counting unresolved work. The overlayOnly flag therefore scopes the run
    // to effective current state, not merely rows whose own layer is overlay.
    reconcileEffectiveTargets(db, options?.branch);

    const branchClause = options?.branch === undefined ? '' : ' AND source_file.branch = ?';
    const branchParams = options?.branch === undefined ? [] : [options.branch];
    const unresolvedCount = (db.prepare(
      `SELECT
         (SELECT COUNT(*)
            FROM effective_symbol_refs edge
            JOIN effective_files source_file ON source_file.id = edge.file_id
           WHERE edge.callee_id IS NULL AND edge.resolution_method = 'unresolved'${branchClause}) +
         (SELECT COUNT(*)
            FROM effective_type_refs edge
            JOIN effective_files source_file ON source_file.id = edge.file_id
           WHERE edge.type_id IS NULL AND edge.resolution_method = 'unresolved'${branchClause}) +
         (SELECT COUNT(*)
            FROM effective_symbol_relationships edge
            JOIN effective_files source_file ON source_file.id = edge.file_id
           WHERE edge.target_symbol_id IS NULL AND edge.resolution_method = 'unresolved'${branchClause})
       AS total`,
    ).get(...branchParams, ...branchParams, ...branchParams) as { total: number }).total;
    if (unresolvedCount === 0) return;

    // Pass 1: LSP containment mapping (highest confidence)
    resolveByContainment(db, 'symbol_refs', 'callee_id', 'definition_path', 'definition_line', 'definition_character', 'callee_name', extractBareName, options?.branch);
    resolveByContainment(db, 'type_refs', 'type_id', 'definition_path', 'definition_line', 'definition_character', 'type_name_bare', normalizeTypeName, options?.branch);
    resolveByContainment(db, 'symbol_relationships', 'target_symbol_id', 'definition_path', 'definition_line', 'definition_character', 'target_symbol_name', normalizeTypeName, options?.branch);

    // Pass 2: Name-based fallback for remaining unresolved refs
    const nameMap = buildNameMap(db, options?.branch);
    const sourceBranchClause = options?.branch === undefined ? '' : ' AND f.branch = ?';
    const sourceBranchParams = options?.branch === undefined ? [] : [options.branch];

    resolveByNameFallback(db, nameMap, {
      tableName: 'symbol_refs',
      targetIdColumn: 'callee_id',
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.callee_name AS target_name, s.file_id AS source_file_id
         FROM effective_symbol_refs sr
         JOIN effective_symbols s ON s.id = sr.caller_id
         JOIN effective_files f ON f.id = s.file_id
         WHERE sr.callee_id IS NULL AND sr.resolution_method = 'unresolved'${sourceBranchClause}`,
      ),
      selectParams: sourceBranchParams,
    });

    // Pass 2b: Bare-name fallback for member-access call refs.
    resolveByNameFallback(db, nameMap, {
      tableName: 'symbol_refs',
      targetIdColumn: 'callee_id',
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.callee_name AS target_name, s.file_id AS source_file_id
         FROM effective_symbol_refs sr
         JOIN effective_symbols s ON s.id = sr.caller_id
         JOIN effective_files f ON f.id = s.file_id
         WHERE sr.callee_id IS NULL AND sr.resolution_method = 'unresolved'${sourceBranchClause}
           AND sr.callee_name LIKE '%.%'`,
      ),
      selectParams: sourceBranchParams,
      normalizeTargetName: extractBareName,
    });

    resolveByNameFallback(db, nameMap, {
      tableName: 'type_refs',
      targetIdColumn: 'type_id',
      selectUnresolved: db.prepare(
        `SELECT tr.id, tr.type_name AS target_name, COALESCE(s.file_id, tr.file_id) AS source_file_id
         FROM effective_type_refs tr
         JOIN effective_files f ON f.id = tr.file_id
         LEFT JOIN effective_symbols s ON s.id = tr.symbol_id
         WHERE tr.type_id IS NULL AND tr.resolution_method = 'unresolved'${sourceBranchClause}`,
      ),
      selectParams: sourceBranchParams,
    });

    // type_refs bare-name fallback pass
    resolveByNameFallback(db, nameMap, {
      tableName: 'type_refs',
      targetIdColumn: 'type_id',
      selectUnresolved: db.prepare(
        `SELECT tr.id, tr.type_name_bare AS target_name, COALESCE(s.file_id, tr.file_id) AS source_file_id
         FROM effective_type_refs tr
         JOIN effective_files f ON f.id = tr.file_id
         LEFT JOIN effective_symbols s ON s.id = tr.symbol_id
         WHERE tr.type_id IS NULL AND tr.resolution_method = 'unresolved'${sourceBranchClause}
           AND tr.type_name_bare != tr.type_name`,
      ),
      selectParams: sourceBranchParams,
    });

    resolveByNameFallback(db, nameMap, {
      tableName: 'symbol_relationships',
      targetIdColumn: 'target_symbol_id',
      selectUnresolved: db.prepare(
        `SELECT sr.id, sr.target_symbol_name AS target_name, COALESCE(s.file_id, sr.file_id) AS source_file_id
         FROM effective_symbol_relationships sr
         JOIN effective_files f ON f.id = sr.file_id
         LEFT JOIN effective_symbols s ON s.id = sr.source_symbol_id
         WHERE sr.target_symbol_id IS NULL AND sr.resolution_method = 'unresolved'${sourceBranchClause}`,
      ),
      selectParams: sourceBranchParams,
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
  definition_character: number | null;
  target_name: string;
}

interface SymbolCandidate {
  id: number;
  name: string;
  start_line: number;
  start_character: number | null;
  end_line: number;
  end_character: number | null;
  selection_line: number | null;
  selection_character: number | null;
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
  defCharacterColumn: string,
  targetNameColumn: string,
  normalizeTargetName: (raw: string) => string,
  branch?: string,
): void {
  const branchClause = branch === undefined ? '' : ' AND source_file.branch = ?';
  const branchParams = branch === undefined ? [] : [branch];
  const unresolvedWithDef = db.prepare(
    `SELECT edge.id, edge.${defPathColumn} AS definition_path,
            edge.${defLineColumn} AS definition_line,
            edge.${defCharacterColumn} AS definition_character,
            edge.${targetNameColumn} AS target_name
       FROM effective_${tableName} edge
       JOIN effective_files source_file ON source_file.id = edge.file_id
      WHERE edge.${targetIdColumn} IS NULL
        AND edge.resolution_method = 'unresolved'
        AND edge.${defPathColumn} IS NOT NULL
        AND edge.${defLineColumn} IS NOT NULL${branchClause}`,
  ).all(...branchParams) as UnresolvedRefRow[];

  if (unresolvedWithDef.length === 0) {
    return;
  }

  // P6: Build a bulk path→fileId map so we do one query instead of N.
  // When branch is provided, use effective_files to get the correct
  // layer-resolved file for each path (overlay preferred over baseline).
  const fileRows = branch
    ? db.prepare('SELECT id, path FROM effective_files WHERE branch = ?').all(branch)
    : db.prepare('SELECT id, path FROM effective_files').all();
  const fileIdByPath = new Map<string, number>(
    (fileRows as Array<{ id: number; path: string }>)
      .map(r => [r.path, r.id]),
  );
  const dirtyPathRows = (branch === undefined
    ? db.prepare('SELECT DISTINCT path FROM dirty_files').all()
    : db.prepare('SELECT path FROM dirty_files WHERE branch = ?').all(branch)
  ) as Array<{ path: string }>;
  const dirtyPaths = new Set(dirtyPathRows.map((row) => row.path));

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
    `SELECT id, name, start_line, start_character, end_line, end_character,
            selection_line, selection_character
      FROM effective_symbols
      WHERE file_id = ?
      ORDER BY (end_line - start_line) ASC, start_line DESC, id ASC`,
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
        updateMethod.run(
          dirtyPaths.has(defPath)
            ? 'overlay_stale' satisfies ResolutionMethod
            : 'external_definition' satisfies ResolutionMethod,
          ref.id,
        );
      }
      continue;
    }

    // Load all symbols for this file once, sorted narrowest-first.
    const symbols = findSymbolsByFile.all(fileId) as SymbolCandidate[];

    for (const ref of refs) {
      const normalizedTargetName = normalizeTargetName(ref.target_name);
      const namedCandidates = symbols.filter(
        (candidate) => candidate.name === ref.target_name
          || (normalizedTargetName.length > 0 && candidate.name === normalizedTargetName),
      );
      const match = selectDefinitionCandidate(namedCandidates, ref);

      if (match.outcome === 'missing') {
        updateMethod.run('unresolved' satisfies ResolutionMethod, ref.id);
        continue;
      }
      if (match.outcome === 'ambiguous') {
        updateMethod.run('ambiguous_definition' satisfies ResolutionMethod, ref.id);
        continue;
      }
      updateResolved.run(match.candidate.id, 'lsp_definition' satisfies ResolutionMethod, ref.id);
    }
  }

}

type DefinitionCandidateMatch =
  | { outcome: 'resolved'; candidate: SymbolCandidate }
  | { outcome: 'missing' }
  | { outcome: 'ambiguous' };

/**
 * Select a symbol at a stored LSP definition position.
 *
 * Exact symbol-name selections are authoritative. Exact range starts and
 * character-aware containment come next. Line-only containment is retained as
 * a compatibility fallback for old rows that do not store character data.
 */
function selectDefinitionCandidate(
  candidates: readonly SymbolCandidate[],
  definition: Pick<UnresolvedRefRow, 'definition_line' | 'definition_character'>,
): DefinitionCandidateMatch {
  const character = definition.definition_character;
  if (character !== null) {
    const exactSelection = candidates.filter((candidate) =>
      candidate.selection_line === definition.definition_line
      && candidate.selection_character === character,
    );
    const selectionMatch = uniqueCandidate(exactSelection, true);
    if (selectionMatch.outcome !== 'missing') return selectionMatch;

    const exactStart = candidates.filter((candidate) =>
      candidate.start_line === definition.definition_line
      && candidate.start_character === character,
    );
    const startMatch = uniqueCandidate(exactStart, true);
    if (startMatch.outcome !== 'missing') return startMatch;

    const positionCandidates = candidates.filter((candidate) =>
      containsStoredPosition(candidate, definition.definition_line, character),
    );
    const positionMatch = uniqueCandidate(positionCandidates, true);
    if (positionMatch.outcome !== 'missing') return positionMatch;
  }

  return uniqueCandidate(candidates.filter((candidate) =>
    candidate.start_line <= definition.definition_line
      && candidate.end_line >= definition.definition_line,
  ), false);
}

function containsStoredPosition(candidate: SymbolCandidate, line: number, character: number): boolean {
  if (line < candidate.start_line || line > candidate.end_line) return false;
  if (
    line === candidate.start_line
    && candidate.start_character !== null
    && character < candidate.start_character
  ) return false;
  if (
    line === candidate.end_line
    && candidate.end_character !== null
    && character > candidate.end_character
  ) return false;
  return true;
}

function uniqueCandidate(
  candidates: readonly SymbolCandidate[],
  characterAware: boolean,
): DefinitionCandidateMatch {
  if (candidates.length === 0) return { outcome: 'missing' };
  const ordered = [...candidates].sort((left, right) =>
    compareCandidateWidth(left, right, characterAware) || left.id - right.id,
  );
  const first = ordered[0]!;
  if (
    ordered.length > 1
    && compareCandidateWidth(first, ordered[1]!, characterAware) === 0
  ) {
    return { outcome: 'ambiguous' };
  }
  return { outcome: 'resolved', candidate: first };
}

function compareCandidateWidth(
  left: SymbolCandidate,
  right: SymbolCandidate,
  characterAware: boolean,
): number {
  const lineWidth = (left.end_line - left.start_line) - (right.end_line - right.start_line);
  if (lineWidth !== 0 || !characterAware) return lineWidth;
  const leftCharacterWidth = left.start_line === left.end_line
    && left.start_character !== null && left.end_character !== null
    ? left.end_character - left.start_character
    : Number.MAX_SAFE_INTEGER;
  const rightCharacterWidth = right.start_line === right.end_line
    && right.start_character !== null && right.end_character !== null
    ? right.end_character - right.start_character
    : Number.MAX_SAFE_INTEGER;
  return leftCharacterWidth - rightCharacterWidth;
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
 *
 * When `branch` is provided, only symbols belonging to files on that branch
 * are included — this prevents the `name_unique` fallback from creating
 * phantom cross-branch edges in multi-branch databases.
 */
function buildNameMap(db: Database.Database, branch?: string): Map<string, NameMapEntry[]> {
  const nameToSymbols = new Map<string, NameMapEntry[]>();
  const query = branch
    ? 'SELECT s.id, s.name, s.file_id, s.kind FROM effective_symbols s JOIN effective_files f ON f.id = s.file_id WHERE f.branch = ?'
    : 'SELECT id, name, file_id, kind FROM effective_symbols';
  const allSymbols = (branch ? db.prepare(query).all(branch) : db.prepare(query).all()) as Array<{ id: number; name: string; file_id: number; kind: string }>;
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
  selectParams?: readonly (string | number)[];
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
  const unresolved = config.selectUnresolved.all(...(config.selectParams ?? [])) as Array<{
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

    // Tier 3: all candidates (after excluding macro/constant/enum_member) live
    // in the same target file — e.g. Java method overloads in one class.
    // Resolve to the first match (overloads are co-located; the file is correct).
    if (crossFileEligible.length > 1) {
      const targetFiles = new Set(crossFileEligible.map(c => c.file_id));
      if (targetFiles.size === 1) {
        updateResolved.run(crossFileEligible[0]!.id, 'name_single_file' satisfies ResolutionMethod, ref.id);
        continue;
      }
    }

    // Non-unique cross-file across multiple files: leave as unresolved
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
    .prepare('SELECT id FROM effective_files')
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
        FROM effective_file_imports fi
        JOIN effective_files target ON target.id = fi.resolved_id
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
    .prepare('SELECT id FROM effective_files')
    .all() as Array<{ id: number }>;

  // Build adjacency list: importer → [dep, ...]
  const adjacency = new Map<string, string[]>();
  for (const { id } of allFiles) {
    adjacency.set(String(id), []);
  }

  const edges = db
    .prepare(
      `SELECT fi.file_id AS importer, fi.resolved_id AS dep
        FROM effective_file_imports fi
        JOIN effective_files target ON target.id = fi.resolved_id
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
