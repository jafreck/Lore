/**
 * @module cli/commands/install-scip-cmd
 *
 * Handler for the `lore install-scip` subcommand.
 */

import { flags } from '../args.js';
import type { LoreLogger } from '../../logger.js';

export async function runInstallScipCommand(args: string[], _log: LoreLogger): Promise<void> {
  const { installAllMissing, SCIP_INSTALL_SPECS } = await import('../../scip/installer.js');

  const languageFilter = flags(args, '--language');

  if (args.includes('--list')) {
    // Just list available indexers and their status
    for (const spec of SCIP_INSTALL_SPECS) {
      console.log(`  ${spec.command.padEnd(20)} ${spec.languages.join(', ').padEnd(25)} ${spec.method}`);
    }
    return;
  }

  const results = await installAllMissing({
    languages: languageFilter.length > 0 ? languageFilter : undefined,
  });

  let installed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.installed) {
      console.log(`  ✓ ${r.command} → ${r.path}`);
      installed++;
    } else {
      console.log(`  ✗ ${r.command}: ${r.error ?? 'unknown error'}`);
      failed++;
    }
  }
  console.log(`\n${installed} installed, ${failed} unavailable`);
}
