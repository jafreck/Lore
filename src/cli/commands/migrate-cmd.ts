/** Explicit in-place Lore schema migration command. */

import { existsSync } from 'node:fs';
import { parseCliArgs, usage } from '../args.js';
import { inspectLoreSchema, openDb, type LoreSchemaInspection } from '../../db/schema.js';
import { withDbWriter } from '../../indexer/writer-queue.js';
import type { LoreLogger } from '../../logger.js';

export async function runMigrateCommand(
  args: string[],
  _log: LoreLogger,
): Promise<LoreSchemaInspection> {
  const parsedArgs = parseCliArgs(args, 'migrate');
  const dbPath = parsedArgs.value('--db');
  if (!dbPath) {
    console.error('Error: --db <path> is required for the migrate subcommand.\n');
    usage();
  }
  if (!existsSync(dbPath!)) {
    throw new Error(`Cannot migrate a database that does not exist: ${dbPath}`);
  }

  // openDb is deliberately used only after the explicit migrate subcommand has
  // been selected; doctor/validate always use a read-only connection.
  return withDbWriter(dbPath!, async () => {
    const db = openDb(dbPath!);
    try {
      const inspection = inspectLoreSchema(db);
      if (inspection.status !== 'current') {
        throw new Error(
          `Schema migration did not produce a compatible database: ${inspection.missing.join(', ')}`,
        );
      }
      process.stdout.write(parsedArgs.has('--json')
        ? `${JSON.stringify(inspection, null, 2)}\n`
        : `Lore schema migration complete (version ${inspection.version ?? inspection.requiredVersion}).\n`);
      return inspection;
    } finally {
      db.close();
    }
  });
}
