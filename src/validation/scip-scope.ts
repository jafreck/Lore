import { resolve } from 'node:path';
import { z } from 'zod';
import { walkFilesSync, type WalkerConfig } from '../discovery/walker.js';
import { discoverCompilationDatabase, loadCompilationDatabase, type ResponseFileLimits } from '../scip/compdb.js';
import {
  filterCompilationDatabase,
  resolveScipScope,
  type ResolvedScipScope,
  type ScipScope,
} from '../scip/scope.js';
import type { IndexHealthIssue, IndexHealthReport, IndexerRunInfo } from './index-health.js';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResponseLimitsSchema = z.object({
  maxBytesPerFile: z.number().optional(),
  maxTotalBytesPerEntry: z.number().optional(),
  maxFilesPerEntry: z.number().optional(),
  maxDepth: z.number().optional(),
  maxExpandedTokensPerEntry: z.number().optional(),
  maxExpandedBytesPerEntry: z.number().optional(),
});
const ScopeSchema = z.object({
  schemaVersion: z.literal(1),
  rootDir: z.string(),
  requested: z.object({
    languages: z.array(z.string()),
    includeGlobs: z.array(z.string()),
    excludeGlobs: z.array(z.string()),
  }).strict(),
  walker: z.object({
    includeGlobs: z.array(z.string()),
    excludeGlobs: z.array(z.string()),
    extensions: z.array(z.string()).nullable(),
  }).strict(),
  effectiveFiles: z.array(z.object({ path: z.string(), language: z.string() }).strict()),
  languageCounts: z.record(z.string(), z.number().int().nonnegative()),
  scopeHash: HashSchema,
}).strict();

const FilteredIdentitySchema = z.object({
  sourcePath: z.string(),
  sourceSha256: HashSchema,
  sha256: HashSchema,
  scopeHash: HashSchema,
  entries: z.number().int().positive(),
  translationUnits: z.array(z.string()).min(1),
}).strict();

export function validateScipScope(input: {
  requested?: ScipScope;
  walkerConfig?: WalkerConfig;
  rootDir: string | null;
  migrationGrade: boolean;
  provenance: IndexHealthReport['provenance'];
  files: readonly { path: string; language: string; layer: string; generation: number }[];
  issues: IndexHealthIssue[];
}): ResolvedScipScope | null {
  const { requested, provenance, issues } = input;
  const baseline = provenance.latestBaselineRun;
  const config = z.object({
    scipScope: z.unknown().optional(),
    responseFileLimits: ResponseLimitsSchema.nullish(),
    execution: z.object({ allowedCwdRoots: z.array(z.string()).optional() }).optional(),
  }).safeParse(baseline?.config);
  const recorded = config.success ? config.data.scipScope : undefined;
  const responseFileLimits = config.success ? config.data.responseFileLimits ?? undefined : undefined;
  const approvedExternalRoots = config.success ? config.data.execution?.allowedCwdRoots : undefined;
  if (!recorded && !requested) return null;
  const fail = (code: string, message: string, paths?: string[]): void => {
    issues.push({ severity: 'error', code, message, ...(paths && { paths }) });
  };
  const parsed = ScopeSchema.safeParse(recorded);
  if (!parsed.success) {
    fail('SCIP_SCOPE_PROVENANCE_MISSING', 'The latest baseline has no valid canonical SCIP scope manifest.');
    return null;
  }
  const persisted = parsed.data;
  if (!requested && input.migrationGrade) {
    fail('SCIP_SCOPE_REQUIRED', 'Migration-grade validation of a scoped baseline requires an explicit host scipScope.');
  }
  let scope: ResolvedScipScope;
  try {
    const walkerConfig = input.walkerConfig ?? {
      rootDir: input.rootDir ?? persisted.rootDir,
      includeGlobs: persisted.walker.includeGlobs,
      excludeGlobs: persisted.walker.excludeGlobs,
      ...(persisted.walker.extensions && { extensions: persisted.walker.extensions }),
    };
    const compilationDatabase = discoverCompilationDatabase(walkerConfig.rootDir, undefined, {
      approvedExternalRoots, responseFileLimits,
    }).database;
    scope = resolveScipScope(walkerConfig, requested ?? persisted.requested,
      walkFilesSync(walkerConfig, { compilationDatabase }));
    if (JSON.stringify(scope) !== JSON.stringify(persisted)) {
      fail('SCIP_SCOPE_MISMATCH', 'Persisted SCIP scope does not match the requested scope, walker selection, or current files.');
    }
  } catch (error) {
    fail('SCIP_SCOPE_INVALID', `Cannot verify SCIP scope: ${error instanceof Error ? error.message : String(error)}`);
    return persisted;
  }
  if (scope.effectiveFiles.length === 0) {
    fail('SCIP_SCOPE_EMPTY', 'The requested SCIP scope contains no walker-selected files.');
  }
  const successfulIndexers = provenance.indexers.filter((row) =>
    row.runId === baseline?.id && row.provider === 'scip' && row.status === 'succeeded');
  const coveredFiles = new Set(successfulIndexers.flatMap((row) => {
    const details = z.object({ coveredFiles: z.array(z.string()) }).safeParse(row.details);
    return details.success ? details.data.coveredFiles : [];
  }));
  const effectiveFiles = new Map(input.files.map((file) => [file.path, file]));
  const uncovered = scope.effectiveFiles.filter((file) => {
    const effective = effectiveFiles.get(resolve(scope.rootDir, file.path));
    return !coveredFiles.has(file.path) || !effective || effective.language !== file.language
      || effective.layer !== 'baseline' || effective.generation !== baseline?.generation;
  });
  if (uncovered.length > 0) {
    fail('SCIP_SCOPE_UNCOVERED_FILES', `${uncovered.length} required scoped file(s) lack current baseline SCIP structural coverage.`,
      uncovered.map((file) => file.path));
  }
  const missingLanguages = Object.entries(scope.languageCounts)
    .filter(([language, count]) => count > 0 && !successfulIndexers.some((row) => row.languages.includes(language)))
    .map(([language]) => language);
  if (missingLanguages.length > 0) {
    fail('SCIP_SCOPE_INDEXER_MISSING', `No successful SCIP indexer for required scoped languages: ${missingLanguages.join(', ')}.`);
  }
  for (const row of provenance.compilationDatabases.filter((row) => row.runId === baseline?.id)) {
    validateFilteredCompdb(row, scope, fail, responseFileLimits);
  }
  const cFamilyLaunched = provenance.indexers.some((row) => row.runId === baseline?.id
    && row.provider === 'scip' && row.attempted && row.languages.some(language => language === 'c' || language === 'cpp'));
  if (cFamilyLaunched && !provenance.compilationDatabases.some((row) => row.runId === baseline?.id)) {
    fail('SCIP_SCOPE_COMPDB_MISSING', 'Scoped C/C++ execution has no filtered compilation-database provenance.');
  }
  return scope;
}

function validateFilteredCompdb(
  row: IndexerRunInfo,
  scope: ResolvedScipScope,
  fail: (code: string, message: string) => void,
  responseFileLimits?: Partial<ResponseFileLimits>,
): void {
  const parsed = z.object({
    filtered: FilteredIdentitySchema,
    sha256: HashSchema,
    validation: z.object({ approvedRoots: z.array(z.string()) }),
  }).safeParse(row.details);
  if (!parsed.success) {
    fail('SCIP_SCOPE_COMPDB_MISSING', 'Scoped C/C++ execution has no valid filtered compilation-database identity.');
    return;
  }
  try {
    const { filtered, sha256, validation } = parsed.data;
    const database = loadCompilationDatabase(filtered.sourcePath, undefined, scope.rootDir, {
      approvedExternalRoots: validation.approvedRoots,
      responseFileLimits,
      selectedFiles: scope.effectiveFiles.map(file => resolve(scope.rootDir, file.path)),
    }).database;
    if (!database) throw new Error('Source compilation database is no longer readable or valid');
    const expected = filterCompilationDatabase(database, scope).identity;
    if (sha256 !== filtered.sha256 || JSON.stringify(filtered) !== JSON.stringify(expected)) {
      throw new Error('Source or filtered compilation database identity differs from the persisted scope');
    }
  } catch (error) {
    fail('SCIP_SCOPE_COMPDB_MISMATCH', error instanceof Error ? error.message : String(error));
  }
}