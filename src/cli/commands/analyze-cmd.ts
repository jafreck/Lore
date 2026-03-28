/**
 * @module cli/commands/analyze-cmd
 *
 * Handler for the `lore analyze` subcommand.
 */

import { flag, usage } from '../args.js';
import type { LoreLogger } from '../../logger.js';

export async function runAnalyzeCommand(args: string[], _log: LoreLogger): Promise<void> {
  const dbPath = flag(args, '--db');
  if (!dbPath) {
    console.error('Error: --db <path> is required for the analyze subcommand.\n');
    usage();
    return;
  }

  const mode = flag(args, '--mode') ?? 'summary';
  const validModes = ['cycles', 'components', 'clusters', 'summary'];
  if (!validModes.includes(mode)) {
    console.error(`Error: --mode must be one of: ${validModes.join(', ')}\n`);
    usage();
    return;
  }

  const edgeKindsRaw = flag(args, '--edge-kinds') ?? 'both';
  const validEdgeKinds = ['call', 'type', 'both'];
  if (!validEdgeKinds.includes(edgeKindsRaw)) {
    console.error(`Error: --edge-kinds must be one of: ${validEdgeKinds.join(', ')}\n`);
    usage();
    return;
  }
  const edgeKinds = edgeKindsRaw as 'call' | 'type' | 'both';

  const branch = flag(args, '--branch');
  const maxLinesRaw = flag(args, '--max-lines');
  let maxLines: number | undefined;
  if (maxLinesRaw !== undefined) {
    const parsed = Number(maxLinesRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error('Error: --max-lines must be a positive number.\n');
      usage();
      return;
    }
    maxLines = Math.floor(parsed);
  }

  const { openReadOnly } = await import('../../db/read-only.js');
  const {
    detectSymbolCycles,
    findConnectedComponents,
    clusterSymbols,
    buildCodebaseSummary,
  } = await import('../../resolution/graph-analysis.js');

  const db = openReadOnly(dbPath);
  const opts = { edgeKinds, branch };

  let result: unknown;
  if (mode === 'cycles') {
    result = detectSymbolCycles(db, opts);
  } else if (mode === 'components') {
    result = findConnectedComponents(db, { ...opts, scope: 'symbol' });
  } else if (mode === 'clusters') {
    result = clusterSymbols(db, { ...opts, maxLinesPerCluster: maxLines });
  } else {
    result = buildCodebaseSummary(db, { ...opts, maxLinesPerModule: maxLines });
  }

  db.close();
  console.log(JSON.stringify(result, null, 2));
}
