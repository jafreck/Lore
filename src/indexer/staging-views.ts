import type { Database } from '../db/schema.js';

const STAGING_VIEWS = [
  'effective_symbol_metrics',
  'effective_file_imports',
  'effective_annotations',
  'effective_symbol_relationships',
  'effective_type_refs',
  'effective_symbol_refs',
  'effective_symbols',
  'effective_files',
] as const;

/**
 * Shadow the persistent effective views on one connection with a hidden
 * baseline generation. SQLite resolves TEMP objects before main-schema
 * objects, so pipeline SQL sees the candidate while every other connection
 * continues to see the currently promoted generation.
 */
export function installStagingEffectiveViews(
  db: Database.Database,
  branch: string,
  generation: number,
): void {
  dropStagingEffectiveViews(db);
  const quotedBranch = db.prepare('SELECT quote(?) AS value').get(branch) as { value: string };
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`Invalid staging generation: ${generation}`);
  }
  db.exec(`
    CREATE TEMP VIEW effective_files AS
    SELECT f.* FROM main.files f
     WHERE f.branch = ${quotedBranch.value}
       AND f.layer = 'baseline'
       AND f.generation = ${generation};

    CREATE TEMP VIEW effective_symbols AS
    SELECT s.* FROM main.symbols s
    JOIN effective_files f ON f.id = s.file_id;

    CREATE TEMP VIEW effective_symbol_refs AS
    SELECT edge.* FROM main.symbol_refs edge
    JOIN effective_files f ON f.id = edge.file_id;

    CREATE TEMP VIEW effective_type_refs AS
    SELECT edge.* FROM main.type_refs edge
    JOIN effective_files f ON f.id = edge.file_id;

    CREATE TEMP VIEW effective_symbol_relationships AS
    SELECT edge.* FROM main.symbol_relationships edge
    JOIN effective_files f ON f.id = edge.file_id;

    CREATE TEMP VIEW effective_annotations AS
    SELECT annotation.* FROM main.annotations annotation
    JOIN effective_files f ON f.id = annotation.file_id;

    CREATE TEMP VIEW effective_file_imports AS
    SELECT imported.* FROM main.file_imports imported
    JOIN effective_files f ON f.id = imported.file_id;

    CREATE TEMP VIEW effective_symbol_metrics AS
    SELECT metric.* FROM main.symbol_metrics metric
    JOIN effective_symbols symbol ON symbol.id = metric.symbol_id;
  `);
}

/** Remove connection-local staging views so persistent promotion is observed. */
export function dropStagingEffectiveViews(db: Database.Database): void {
  for (const view of STAGING_VIEWS) {
    db.exec(`DROP VIEW IF EXISTS temp.${view}`);
  }
}