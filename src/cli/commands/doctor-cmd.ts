/** Handler for `lore doctor` and its `lore validate` alias. */

import { parseCliArgs, usage, validationPolicyFromArgs } from '../args.js';
import {
  loadValidationPolicyFromLoreConfig,
  resolveIndexValidationPolicy,
} from '../../validation/config.js';
import {
  formatIndexHealthReport,
  readRecordedIndexRoot,
  validateIndex,
  type IndexHealthReport,
} from '../../validation/index-health.js';
import type { LoreLogger } from '../../logger.js';

export async function runDoctorCommand(
  args: string[],
  _log: LoreLogger,
): Promise<IndexHealthReport> {
  const parsedArgs = parseCliArgs(args, ['doctor', 'validate']);
  const dbPath = parsedArgs.value('--db');
  if (!dbPath) {
    console.error('Error: --db <path> is required for the doctor subcommand.\n');
    usage();
  }

  const explicitRoot = parsedArgs.value('--root');
  const requestedBranch = parsedArgs.value('--branch');
  const rootDir = explicitRoot ?? readRecordedIndexRoot(dbPath!, requestedBranch);
  const configured = rootDir
    ? loadValidationPolicyFromLoreConfig(rootDir) ?? {}
    : {};
  const explicit = validationPolicyFromArgs(parsedArgs, { always: true, includeScope: true }) ?? {};
  const policy = resolveIndexValidationPolicy(configured, explicit);
  const maxSamplesRaw = parsedArgs.value('--max-samples');
  let maxSamples: number | undefined;
  if (maxSamplesRaw !== undefined) {
    maxSamples = Number(maxSamplesRaw);
    if (!Number.isInteger(maxSamples) || maxSamples < 0) {
      throw new Error('--max-samples must be a non-negative integer');
    }
  }

  const report = validateIndex(dbPath!, {
    ...(rootDir && { rootDir }),
    ...(requestedBranch && { branch: requestedBranch }),
    policy,
    ...(maxSamples !== undefined && { maxSamples }),
  });
  process.stdout.write(parsedArgs.has('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatIndexHealthReport(report)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}