import type { Database } from '../db/schema.js';

/** Counts of active rows repaired after an effective file/symbol replacement. */
export interface EffectiveTargetReconciliation {
  symbolRefsRequeued: number;
  typeRefsRequeued: number;
  relationshipsRequeued: number;
  symbolRefsInvalidated: number;
  typeRefsInvalidated: number;
  relationshipsInvalidated: number;
  importsRemapped: number;
  importsInvalidated: number;
}

interface ImportReplacementRow {
  id: number;
  replacement_id: number | null;
}

/**
 * Repair target IDs on current-state edges without touching inactive source
 * generations. A target ID is valid only when it resolves through the matching
 * effective target view. File targets are remapped by stable `(path, branch)`;
 * symbol targets are invalidated so the normal resolver can map their stored
 * definition coordinates/name to the replacement symbol IDs.
 */
export function reconcileEffectiveTargets(
  db: Database.Database,
  branch?: string,
): EffectiveTargetReconciliation {
  const branchClause = branch === undefined ? '' : ' AND source_file.branch = ?';
  const params = branch === undefined ? [] : [branch];

  const symbolRefsRequeued = requeueReturnedTarget(
    db,
    'symbol_refs',
    'effective_symbol_refs',
    'callee_id',
    branchClause,
    params,
  );
  const typeRefsRequeued = requeueReturnedTarget(
    db,
    'type_refs',
    'effective_type_refs',
    'type_id',
    branchClause,
    params,
  );
  const relationshipsRequeued = requeueReturnedTarget(
    db,
    'symbol_relationships',
    'effective_symbol_relationships',
    'target_symbol_id',
    branchClause,
    params,
  );

  const symbolRefsInvalidated = db.prepare(
    `UPDATE symbol_refs
        SET callee_id = NULL,
            resolution_method = 'unresolved'
      WHERE id IN (
        SELECT edge.id
          FROM effective_symbol_refs edge
          JOIN effective_files source_file ON source_file.id = edge.file_id
          LEFT JOIN effective_symbols target ON target.id = edge.callee_id
         WHERE edge.callee_id IS NOT NULL
           AND target.id IS NULL${branchClause}
      )`,
  ).run(...params).changes;

  const typeRefsInvalidated = db.prepare(
    `UPDATE type_refs
        SET type_id = NULL,
            resolution_method = 'unresolved'
      WHERE id IN (
        SELECT edge.id
          FROM effective_type_refs edge
          JOIN effective_files source_file ON source_file.id = edge.file_id
          LEFT JOIN effective_symbols target ON target.id = edge.type_id
         WHERE edge.type_id IS NOT NULL
           AND target.id IS NULL${branchClause}
      )`,
  ).run(...params).changes;

  const relationshipsInvalidated = db.prepare(
    `UPDATE symbol_relationships
        SET target_symbol_id = NULL,
            resolution_method = 'unresolved'
      WHERE id IN (
        SELECT edge.id
          FROM effective_symbol_relationships edge
          JOIN effective_files source_file ON source_file.id = edge.file_id
          LEFT JOIN effective_symbols target ON target.id = edge.target_symbol_id
         WHERE edge.target_symbol_id IS NOT NULL
           AND target.id IS NULL${branchClause}
      )`,
  ).run(...params).changes;

  const importRows = db.prepare(
    `SELECT edge.id,
            replacement.id AS replacement_id
       FROM effective_file_imports edge
       JOIN effective_files source_file ON source_file.id = edge.file_id
       JOIN files hidden_target ON hidden_target.id = edge.resolved_id
       LEFT JOIN effective_files current_target ON current_target.id = edge.resolved_id
       LEFT JOIN effective_files replacement
         ON replacement.path = hidden_target.path
        AND replacement.branch = hidden_target.branch
      WHERE edge.resolved_id IS NOT NULL
        AND current_target.id IS NULL${branchClause}`,
  ).all(...params) as ImportReplacementRow[];

  const remapImport = db.prepare(
    'UPDATE file_imports SET resolved_id = ? WHERE id = ?',
  );
  const invalidateImport = db.prepare(
    "UPDATE file_imports SET resolved_id = NULL, resolution_method = 'overlay_stale' WHERE id = ?",
  );
  let importsRemapped = 0;
  let importsInvalidated = 0;
  for (const row of importRows) {
    if (row.replacement_id === null) {
      importsInvalidated += invalidateImport.run(row.id).changes;
    } else {
      importsRemapped += remapImport.run(row.replacement_id, row.id).changes;
    }
  }

  return {
    symbolRefsRequeued,
    typeRefsRequeued,
    relationshipsRequeued,
    symbolRefsInvalidated,
    typeRefsInvalidated,
    relationshipsInvalidated,
    importsRemapped,
    importsInvalidated,
  };
}

function requeueReturnedTarget(
  db: Database.Database,
  table: string,
  effectiveTable: string,
  targetColumn: string,
  branchClause: string,
  params: readonly string[],
): number {
  return db.prepare(
    `UPDATE ${table}
        SET resolution_method = 'unresolved'
      WHERE id IN (
        SELECT edge.id
          FROM ${effectiveTable} edge
          JOIN effective_files source_file ON source_file.id = edge.file_id
          JOIN effective_files target_file
            ON target_file.path = edge.definition_path
           AND target_file.branch = source_file.branch
         WHERE edge.${targetColumn} IS NULL
           AND edge.resolution_method = 'overlay_stale'${branchClause}
      )`,
  ).run(...params).changes;
}
