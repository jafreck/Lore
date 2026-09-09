import type Database from 'better-sqlite3';
import { RESOLVED_METHODS, type ResolutionMethod } from '../resolution/resolution-method.js';
import type { IndexValidationPolicy, RequiredIndexSymbol } from './config.js';
import type { IndexHealthIssue } from './index-health.js';

export function evaluateRequiredFacts(
  db: Database.Database,
  relations: { symbols: string; calls: string },
  files: readonly { id: number; relativePath: string }[],
  policy: IndexValidationPolicy,
  issues: IndexHealthIssue[],
): void {
  if (!policy.requiredSymbols?.length && !policy.requiredCalls?.length) return;
  const selectedFiles = new Map(files.map(file => [file.id, file.relativePath]));
  const findSymbols = db.prepare(`SELECT id, file_id, kind FROM ${relations.symbols} WHERE name = ?`);
  const findCalls = db.prepare(`SELECT file_id, callee_id, resolution_method FROM ${relations.calls}
    WHERE caller_id = ? AND callee_id IS NOT NULL`);
  const matchingSymbols = (required: RequiredIndexSymbol): number[] => {
    const rows = findSymbols.all(required.name) as Array<{ id: number; file_id: number; kind: string }>;
    return rows.filter(row => selectedFiles.has(row.file_id)
      && (required.path === undefined || selectedFiles.get(row.file_id) === required.path)
      && (required.kind === undefined || row.kind === required.kind)).map(row => row.id);
  };
  const description = (required: RequiredIndexSymbol): string =>
    `"${required.name}"${required.path ? ` in ${required.path}` : ''}${required.kind ? ` (${required.kind})` : ''}`;

  for (const required of policy.requiredSymbols ?? []) {
    if (matchingSymbols(required).length > 0) continue;
    issues.push({
      severity: 'error', code: 'REQUIRED_SYMBOL_MISSING',
      message: `Required symbol ${description(required)} was not found in the selected effective files.`,
      ...(required.path && { paths: [required.path] }),
    });
  }
  for (const required of policy.requiredCalls ?? []) {
    const calleeIds = new Set(matchingSymbols(required.callee));
    const found = matchingSymbols(required.caller).some(callerId => {
      const calls = findCalls.all(callerId) as Array<{ file_id: number; callee_id: number; resolution_method: ResolutionMethod }>;
      return calls.some(call => selectedFiles.has(call.file_id) && calleeIds.has(call.callee_id)
        && RESOLVED_METHODS.has(call.resolution_method)
        && (required.resolutionMethod === undefined || call.resolution_method === required.resolutionMethod));
    });
    if (found) continue;
    issues.push({
      severity: 'error', code: 'REQUIRED_CALL_MISSING',
      message: `Required resolved call from ${description(required.caller)} to ${description(required.callee)} was not found${required.resolutionMethod ? ` with ${required.resolutionMethod}` : ''}.`,
    });
  }
}