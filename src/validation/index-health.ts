/**
 * SQL-backed index health reporting and policy enforcement.
 *
 * Validation reads persisted source snapshots and effective-layer views.  It
 * never walks the repository tree, so large repositories pay for database
 * aggregation rather than a second source discovery pass.
 */

import { extname, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openReadOnly } from '../db/read-only.js';
import { getLoreMeta } from '../db/meta.js';
import {
  inspectLoreSchema,
  tableHasColumns,
  type LoreSchemaInspection,
} from '../db/schema-info.js';
import {
  resolveIndexValidationPolicy,
  type IndexCoverageThresholds,
  type IndexValidationPolicy,
  type ResolvedIndexValidationPolicy,
  type ValidationProfile,
} from './config.js';
import {
  nullableStorageCharacterToPresentation,
  storageLineToPresentation,
} from '../source-coordinates.js';

export interface ReferenceCoverage {
  total: number;
  resolved: number;
  external: number;
  unresolved: number;
  resolutionRate: number | null;
}

export interface ImportCoverage {
  total: number;
  /** Exact/authoritative resolutions to files in this index. */
  internalResolved: number;
  /** Resolutions to a third-party, standard-library, or system dependency. */
  externalResolved: number;
  /** Internal file resolutions produced by a documented fallback heuristic. */
  heuristic: number;
  /** All successful classifications, retained for API compatibility. */
  resolved: number;
  unresolved: number;
  resolutionRate: number | null;
}

export interface CoverageMetrics {
  files: number;
  filesWithSymbols: number;
  symbolLessFiles: number;
  symbols: number;
  symbolCoverage: number | null;
  filesWithCallRefs: number;
  callFileCoverage: number | null;
  calls: ReferenceCoverage;
  filesWithTypeRefs: number;
  typeFileCoverage: number | null;
  types: ReferenceCoverage;
  filesWithImports: number;
  importFileCoverage: number | null;
  imports: ImportCoverage;
}

export interface FileHealthSample {
  path: string;
  relativePath: string;
  language: string;
  extension: string;
  layer: string;
}

export interface SpanHealthSample extends FileHealthSample {
  entity: 'symbol' | 'call' | 'type' | 'relationship';
  id: number;
  reason: string;
}

export interface DuplicatePathSample {
  path: string;
  relativePath: string;
  branch: string;
  count: number;
}

export interface DuplicateSymbolSample extends FileHealthSample {
  name: string;
  kind: string;
  count: number;
  startLine: number;
  startCharacter: number | null;
}

export interface ResolutionMethodMetric {
  entity: 'call' | 'type' | 'relationship' | 'import';
  method: string;
  count: number;
  rate: number;
}

export interface UnresolvedInternalSample extends FileHealthSample {
  entity: 'call' | 'type' | 'relationship' | 'import';
  id: number;
  target: string;
  reason: 'indexed-definition-path' | 'indexed-symbol-name' | 'internal-import-path';
}

export interface IndexRunInfo {
  id: string;
  mode: string;
  rootDir: string;
  branch: string;
  layer: string;
  generation: number;
  startedAt: number;
  completedAt: number | null;
  status: string;
  fallbackDegraded: boolean;
  error: string | null;
  config: unknown;
}

export interface IndexerRunInfo {
  provider: string;
  indexer: string;
  languages: string[];
  status: string;
  attempted: boolean;
  fallback: boolean;
  files: number | null;
  symbols: number | null;
  callRefs: number | null;
  typeRefs: number | null;
  imports: number | null;
  message: string | null;
  details: unknown;
  runId: string;
}

export interface IndexerDiagnosticInfo {
  runId: string;
  indexer: string;
  languages: string[];
  status: string;
  details: unknown;
}

export interface IndexHealthIssue {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  scope?: string;
  actual?: number | null;
  expected?: number;
  paths?: string[];
  guidance?: string;
}

export interface IndexHealthReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  status: 'healthy' | 'degraded' | 'invalid';
  profile: ValidationProfile;
  databaseSchema: LoreSchemaInspection;
  rootDir: string | null;
  branch: string | null;
  selection: {
    includeGlobs: string[];
    excludeGlobs: string[];
    requiredGlobs: string[];
    indexedFiles: number;
    selectedFiles: number;
  };
  coverage: {
    overall: CoverageMetrics;
    byLanguage: Record<string, CoverageMetrics>;
    byExtension: Record<string, CoverageMetrics>;
  };
  symbolLessFiles: {
    total: number;
    files: FileHealthSample[];
    truncated: boolean;
  };
  spans: {
    total: number;
    invalid: number;
    validRate: number | null;
    byEntity: Record<string, { total: number; invalid: number }>;
    samples: SpanHealthSample[];
    truncated: boolean;
  };
  duplicates: {
    paths: { groups: number; excessRows: number; samples: DuplicatePathSample[] };
    symbols: { groups: number; excessRows: number; samples: DuplicateSymbolSample[] };
  };
  resolution: {
    methods: ResolutionMethodMetric[];
    calls: ReferenceCoverage;
    types: ReferenceCoverage;
    relationships: ReferenceCoverage;
  };
  unresolvedInternal: {
    total: number;
    byEntity: Record<string, number>;
    samples: UnresolvedInternalSample[];
    truncated: boolean;
  };
  provenance: {
    latestRun: IndexRunInfo | null;
    latestBaselineRun: IndexRunInfo | null;
    indexers: IndexerRunInfo[];
    compilationDatabases: IndexerRunInfo[];
    legacyScipMetadata: unknown | null;
    promotedGeneration: number | null;
    diagnostics: {
      positionConversions: IndexerDiagnosticInfo[];
      supplementation: IndexerDiagnosticInfo[];
    };
  };
  freshness: {
    source: 'baseline' | 'mixed' | 'empty';
    baselineAgeSeconds: number | null;
    latestIndexedAt: number | null;
    dirtyFiles: number;
    overlayFiles: number;
    overlaySymbols: number;
    oldestDirtyAt: number | null;
    pendingGeneration: number | null;
    baselineHeadSha: string | null;
    overlayHeadSha: string | null;
  };
  warnings: IndexHealthIssue[];
  errors: IndexHealthIssue[];
}

export interface ValidateIndexOptions extends IndexValidationPolicy {
  rootDir?: string;
  branch?: string;
  profile?: ValidationProfile;
  policy?: IndexValidationPolicy;
  /** Maximum samples retained in each potentially large report section. */
  maxSamples?: number;
  /** Internal pre-promotion generation exposed by connection-local views. */
  candidateGeneration?: number;
  /** Internal run whose prospective final state should be validated. */
  candidateRunId?: string;
  candidateRunStatus?: 'succeeded' | 'degraded';
  candidateRunCompletedAt?: number;
  candidateFallbackDegraded?: boolean;
}

export type IndexValidationTarget = string | Database.Database;

export class IndexValidationError extends Error {
  readonly report: IndexHealthReport;

  constructor(report: IndexHealthReport) {
    const first = report.errors[0]?.message ?? 'index validation failed';
    super(`Index validation failed: ${first}`);
    this.name = 'IndexValidationError';
    this.report = report;
  }
}

interface FileCoverageRow {
  id: number;
  path: string;
  branch: string;
  language: string;
  indexed_at: number;
  layer: string;
  generation: number;
  symbols: number;
  calls: number;
  calls_resolved: number;
  calls_external: number;
  types: number;
  types_resolved: number;
  types_external: number;
  imports: number;
  imports_internal_resolved: number;
  imports_external_resolved: number;
  imports_heuristic: number;
}

interface InternalFileCoverageRow extends FileCoverageRow {
  extension: string;
  relativePath: string;
}

interface SpanRow {
  entity: SpanHealthSample['entity'];
  id: number;
  file_id: number;
  start_line: number | null;
  start_character: number | null;
  end_line: number | null;
  end_character: number | null;
  selection_line: number | null;
  selection_character: number | null;
}

interface Relations {
  files: string;
  symbols: string;
  calls: string;
  types: string;
  relationships: string;
  imports: string;
}

/** Validate an index file or an already-open database handle. */
export function validateIndex(
  target: IndexValidationTarget,
  options: ValidateIndexOptions = {},
): IndexHealthReport {
  const owned = typeof target === 'string';
  const db = owned ? openReadOnly(target, { allowIncompatibleSchema: true }) : target;
  try {
    return validateOpenDatabase(db, options);
  } finally {
    if (owned) db.close();
  }
}

/** Return the root persisted by the latest relevant index run, if run metadata exists. */
export function readRecordedIndexRoot(
  target: IndexValidationTarget,
  branch?: string,
): string | undefined {
  const owned = typeof target === 'string';
  const db = owned ? openReadOnly(target, { allowIncompatibleSchema: true }) : target;
  try {
    if (!tableHasColumns(
      db,
      'index_runs',
      branch === undefined ? ['root_dir', 'started_at'] : ['root_dir', 'started_at', 'branch'],
    )) return undefined;
    const row = (branch === undefined
      ? db.prepare(
          `SELECT root_dir FROM index_runs
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        ).get()
      : db.prepare(
          `SELECT root_dir FROM index_runs WHERE branch = ?
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        ).get(branch)) as { root_dir: string } | undefined;
    return row?.root_dir;
  } finally {
    if (owned) db.close();
  }
}

function validateOpenDatabase(
  db: Database.Database,
  options: ValidateIndexOptions,
): IndexHealthReport {
  const databaseSchema = inspectLoreSchema(db);
  if (databaseSchema.status !== 'current') {
    return incompatibleSchemaReport(options, databaseSchema);
  }

  const explicitPolicy: IndexValidationPolicy = {
    ...policyFieldsFromOptions(options),
    ...(options.policy ?? {}),
    ...(options.profile !== undefined && { profile: options.profile }),
  };
  const policy = resolveIndexValidationPolicy({}, explicitPolicy);
  const maxSamples = normalizeSampleLimit(options.maxSamples);
  const relations = resolveRelations(db);
  let provenance = readProvenance(db, options.branch);
  const branch = options.branch
    ?? provenance.latestRun?.branch
    ?? readOnlyBranch(db, relations.files);
  if (options.branch === undefined && branch !== undefined) {
    provenance = readProvenance(db, branch);
  }
  applyCandidateProvenance(provenance, options);
  const rootDir = options.rootDir
    ? resolve(options.rootDir)
    : provenance.latestRun?.rootDir ?? provenance.latestBaselineRun?.rootDir ?? null;

  const rows = readFileCoverage(db, relations, branch).map((row): InternalFileCoverageRow => ({
    ...row,
    extension: extname(row.path).toLowerCase() || '(none)',
    relativePath: relativeIndexPath(rootDir, row.path),
  }));
  const selected = rows.filter((row) => pathSelected(row.relativePath, policy));
  const selectedIds = new Set(selected.map((row) => row.id));
  const selectedPaths = new Set(selected.map((row) => row.path));
  const byId = new Map(selected.map((row) => [row.id, row]));

  const overall = aggregateCoverage(selected);
  const byLanguage = aggregateCoverageBy(selected, (row) => row.language);
  const byExtension = aggregateCoverageBy(selected, (row) => row.extension);
  const symbolLessRows = selected.filter((row) => row.symbols === 0);
  const symbolLessSamples = symbolLessRows.slice(0, maxSamples).map(toFileSample);

  const allSpanRows = readSpanRows(db, relations, branch)
    .filter((row) => selectedIds.has(row.file_id));
  const spanFileIds = new Set(allSpanRows.map((row) => row.file_id));
  const utf16LineLengths = readUtf16LineLengths(db, relations, branch, spanFileIds);
  const invalidReasons = new Map<SpanRow, string | null>();
  for (const row of allSpanRows) {
    invalidReasons.set(row, invalidSpanReason(row, utf16LineLengths.get(row.file_id)));
  }
  const invalidSpanRows = allSpanRows.filter((row) => invalidReasons.get(row) !== null);
  const spanSamples = invalidSpanRows.slice(0, maxSamples).flatMap((span): SpanHealthSample[] => {
    const file = byId.get(span.file_id);
    const reason = invalidReasons.get(span);
    return file && reason ? [{ ...toFileSample(file), entity: span.entity, id: span.id, reason }] : [];
  });
  const spansByEntity = buildSpanEntityMetrics(allSpanRows, invalidSpanRows);

  const pathDuplicates = readDuplicatePaths(db, relations, branch)
    .filter((duplicate) => selectedPaths.has(duplicate.path));
  const symbolDuplicates = readDuplicateSymbols(db, relations, branch)
    .filter((duplicate) => selectedIds.has(duplicate.file_id));
  const duplicateSymbolSamples = symbolDuplicates.slice(0, maxSamples).flatMap((duplicate) => {
    const file = byId.get(duplicate.file_id);
    return file ? [{
      ...toFileSample(file),
      name: duplicate.name,
      kind: duplicate.kind,
      count: duplicate.count,
      startLine: storageLineToPresentation(duplicate.start_line),
      startCharacter: nullableStorageCharacterToPresentation(duplicate.start_character),
    }] : [];
  });

  const methodRows = readResolutionMethods(db, relations, branch)
    .filter((row) => selectedIds.has(row.file_id));
  const resolutionMethods = aggregateResolutionMethods(methodRows);
  const relationshipCoverage = aggregateRelationshipCoverage(methodRows);

  const internalUnresolved = readInternalUnresolved(db, relations, branch)
    .filter((row) => selectedIds.has(row.file_id));
  internalUnresolved.push(...classifyInternalImports(db, relations, branch, selected, rows));
  const unresolvedSamples = internalUnresolved.slice(0, maxSamples).flatMap((item) => {
    const file = byId.get(item.file_id);
    return file ? [{
      ...toFileSample(file),
      entity: item.entity,
      id: item.id,
      target: item.target,
      reason: item.reason,
    }] : [];
  });
  const unresolvedByEntity = countBy(internalUnresolved, (row) => row.entity);

  const freshness = readFreshness(
    db,
    relations,
    branch,
    options.candidateGeneration,
  );
  if (options.candidateGeneration !== undefined
    && freshness.pendingGeneration === options.candidateGeneration) {
    freshness.pendingGeneration = null;
  }
  const issues: IndexHealthIssue[] = [];
  const invalidByLanguage = countRowsByFileLanguage(invalidSpanRows, byId);
  const duplicatesByLanguage = countRowsByFileLanguage(symbolDuplicates, byId, 'count');
  const unresolvedByLanguage = countRowsByFileLanguage(internalUnresolved, byId);

  evaluateGeneralHealth({
    policy,
    rows,
    selected,
    symbolLessRows,
    invalidSpanRows,
    pathDuplicates,
    symbolDuplicates,
    internalUnresolved,
    provenance,
    freshness,
    rootDir,
    branch,
    issues,
  });
  evaluateRequiredGlobs(policy, selected, issues);
  evaluateThresholds('overall', overall, policy.thresholds, {
    invalidSpans: invalidSpanRows.length,
    duplicateSymbols: excessCount(symbolDuplicates),
    unresolvedInternal: internalUnresolved.length,
  }, issues);
  for (const [language, thresholds] of Object.entries(policy.languages)) {
    evaluateThresholds(`language:${language}`, byLanguage[language] ?? emptyCoverage(), thresholds, {
      invalidSpans: invalidByLanguage[language] ?? 0,
      duplicateSymbols: duplicatesByLanguage[language] ?? 0,
      unresolvedInternal: unresolvedByLanguage[language] ?? 0,
    }, issues);
  }

  if (policy.failOnWarnings && issues.some((issue) => issue.severity === 'warning')) {
    issues.push({
      severity: 'error',
      code: 'WARNINGS_DISALLOWED',
      message: 'Validation policy rejects warnings.',
    });
  }
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const errors = issues.filter((issue) => issue.severity === 'error');
  const ok = errors.length === 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok,
    status: ok ? (warnings.length > 0 ? 'degraded' : 'healthy') : 'invalid',
    profile: policy.profile,
    databaseSchema,
    rootDir,
    branch: branch ?? null,
    selection: {
      includeGlobs: policy.includeGlobs,
      excludeGlobs: policy.excludeGlobs,
      requiredGlobs: policy.requiredGlobs,
      indexedFiles: rows.length,
      selectedFiles: selected.length,
    },
    coverage: { overall, byLanguage, byExtension },
    symbolLessFiles: {
      total: symbolLessRows.length,
      files: symbolLessSamples,
      truncated: symbolLessRows.length > symbolLessSamples.length,
    },
    spans: {
      total: allSpanRows.length,
      invalid: invalidSpanRows.length,
      validRate: ratio(allSpanRows.length - invalidSpanRows.length, allSpanRows.length),
      byEntity: spansByEntity,
      samples: spanSamples,
      truncated: invalidSpanRows.length > spanSamples.length,
    },
    duplicates: {
      paths: {
        groups: pathDuplicates.length,
        excessRows: excessCount(pathDuplicates),
        samples: pathDuplicates.slice(0, maxSamples).map((row) => ({
          path: row.path,
          relativePath: relativeIndexPath(rootDir, row.path),
          branch: row.branch,
          count: row.count,
        })),
      },
      symbols: {
        groups: symbolDuplicates.length,
        excessRows: excessCount(symbolDuplicates),
        samples: duplicateSymbolSamples,
      },
    },
    resolution: {
      methods: resolutionMethods,
      calls: overall.calls,
      types: overall.types,
      relationships: relationshipCoverage,
    },
    unresolvedInternal: {
      total: internalUnresolved.length,
      byEntity: unresolvedByEntity,
      samples: unresolvedSamples,
      truncated: internalUnresolved.length > unresolvedSamples.length,
    },
    provenance,
    freshness,
    warnings,
    errors,
  };
}

interface GeneralHealthInput {
  policy: ResolvedIndexValidationPolicy;
  rows: InternalFileCoverageRow[];
  selected: InternalFileCoverageRow[];
  symbolLessRows: InternalFileCoverageRow[];
  invalidSpanRows: SpanRow[];
  pathDuplicates: Array<{ path: string; branch: string; count: number }>;
  symbolDuplicates: Array<{ file_id: number; count: number }>;
  internalUnresolved: Array<{ file_id: number }>;
  provenance: IndexHealthReport['provenance'];
  freshness: IndexHealthReport['freshness'];
  rootDir: string | null;
  branch: string | undefined;
  issues: IndexHealthIssue[];
}

function evaluateGeneralHealth(input: GeneralHealthInput): void {
  const {
    policy, rows, selected, symbolLessRows, invalidSpanRows, pathDuplicates,
    symbolDuplicates, internalUnresolved, provenance, freshness, rootDir, branch, issues,
  } = input;
  const strict = policy.profile !== 'standard';
  const severity = (condition: boolean): 'warning' | 'error' => condition ? 'error' : 'warning';

  if (rows.length === 0) {
    issues.push({
      severity: policy.requireStructuralIndex ? 'error' : 'warning',
      code: 'INDEX_EMPTY',
      message: 'The index contains no effective source files.',
    });
  } else if (selected.length === 0) {
    issues.push({
      severity: 'error',
      code: 'SELECTION_EMPTY',
      message: 'Validation include/exclude globs selected no indexed files.',
    });
  }

  if (policy.requireStructuralIndex && selected.length > 0) {
    const missingLanguages = Object.entries(aggregateCoverageBy(selected, (row) => row.language))
      .filter(([, metrics]) => metrics.symbols === 0)
      .map(([language]) => language)
      .sort();
    if (missingLanguages.length > 0) {
      issues.push({
        severity: 'error',
        code: 'STRUCTURAL_INDEX_MISSING',
        scope: missingLanguages.join(','),
        message: `No structural symbols were indexed for: ${missingLanguages.join(', ')}.`,
      });
    }
  }

  if (symbolLessRows.length > 0 && policy.thresholds.maxSymbolLessFiles === undefined) {
    issues.push({
      severity: severity(strict),
      code: 'SYMBOL_LESS_FILES',
      message: `${symbolLessRows.length} selected source file(s) contain no symbols.`,
      actual: symbolLessRows.length,
      paths: symbolLessRows.slice(0, 10).map((row) => row.relativePath),
    });
  }
  if (invalidSpanRows.length > 0
    && (policy.requireValidSpans || policy.thresholds.maxInvalidSpans === undefined)) {
    issues.push({
      severity: severity(policy.requireValidSpans),
      code: 'INVALID_SPANS',
      message: `${invalidSpanRows.length} persisted source span(s) are invalid.`,
      actual: invalidSpanRows.length,
    });
  }
  if (pathDuplicates.length > 0) {
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_PATHS',
      message: `${pathDuplicates.length} active path/branch duplicate group(s) were found.`,
      actual: excessCount(pathDuplicates),
    });
  }
  if (symbolDuplicates.length > 0 && policy.thresholds.maxDuplicateSymbols === undefined) {
    issues.push({
      severity: 'warning',
      code: 'DUPLICATE_SYMBOLS',
      message: `${symbolDuplicates.length} exact duplicate symbol group(s) were found.`,
      actual: excessCount(symbolDuplicates),
    });
  }
  if (internalUnresolved.length > 0 && policy.thresholds.maxUnresolvedInternalRefs === undefined) {
    issues.push({
      severity: 'warning',
      code: 'UNRESOLVED_INTERNAL_REFS',
      message: `${internalUnresolved.length} unresolved reference(s) appear to target indexed code.`,
      actual: internalUnresolved.length,
    });
  }

  const relevantLanguages = new Set(selected.map((row) => row.language));
  const structuralRows = provenance.indexers.filter((row) =>
    row.provider === 'scip' || row.provider === 'lsp' || row.provider === 'compdb');
  const failed = structuralRows.filter((row) =>
    ['failed', 'unavailable', 'degraded'].includes(row.status)
      && (row.languages.length === 0 || row.languages.some((language) => relevantLanguages.has(language))));
  if (failed.length > 0) {
    issues.push({
      severity: severity(policy.requireIndexerSuccess),
      code: 'INDEXER_DEGRADED',
      message: `${failed.length} relevant indexer/compilation-database attempt(s) failed or degraded.`,
      scope: failed.map((row) => `${row.provider}:${row.indexer}`).join(','),
    });
  }

  const skippedPositionConversions = provenance.diagnostics.positionConversions.reduce(
    (total, row) => total + numericDetail(row.details, 'positionConversion', 'skippedMissingSource'),
    0,
  );
  if (skippedPositionConversions > 0) {
    issues.push({
      severity: severity(policy.requireIndexerSuccess),
      code: 'POSITION_CONVERSION_DEGRADED',
      message: `${skippedPositionConversions} required SCIP position conversion(s) were skipped because source text was unavailable.`,
      actual: skippedPositionConversions,
      expected: 0,
    });
  }
  const degradedSupplements = provenance.diagnostics.supplementation.filter((row) =>
    row.status === 'degraded'
      || numericDetail(row.details, 'supplementation', 'skippedByCap') > 0
      || numericDetail(row.details, 'supplementation', 'sourceMissing') > 0
      || numericDetail(row.details, 'supplementation', 'fileRowsMissing') > 0).length;
  if (degradedSupplements > 0) {
    issues.push({
      severity: severity(policy.requireIndexerSuccess),
      code: 'SUPPLEMENTATION_DEGRADED',
      message: `${degradedSupplements} structural supplementation result(s) were incomplete or degraded.`,
      actual: degradedSupplements,
      expected: 0,
    });
  }

  if (!provenance.latestBaselineRun) {
    issues.push({
      severity: severity(policy.requireProvenance),
      code: 'PROVENANCE_MISSING',
      message: 'No persisted baseline index-run provenance is available.',
    });
  } else if (policy.requireProvenance) {
    const successfulStructuralRows = structuralRows.filter((row) =>
      row.status === 'succeeded' && row.provider !== 'compdb');
    if (successfulStructuralRows.length === 0) {
      issues.push({
        severity: 'error',
        code: 'STRUCTURAL_PROVENANCE_MISSING',
        message: 'Migration-grade validation requires a successful persisted SCIP or LSP indexer run.',
      });
    }
  }

  if (policy.profile === 'migration-grade') {
    evaluateMigrationGradeProvenance({
      selected,
      provenance,
      rootDir,
      branch,
      issues,
    });
  }

  if (freshness.pendingGeneration !== null) {
    issues.push({
      severity: strict ? 'error' : 'warning',
      code: 'BASELINE_REBUILD_PENDING',
      message: `Baseline generation ${freshness.pendingGeneration} is still marked pending.`,
    });
  }
  if (policy.maxDirtyFiles !== undefined && freshness.dirtyFiles > policy.maxDirtyFiles) {
    issues.push({
      severity: 'error',
      code: 'DIRTY_FILE_LIMIT',
      message: `Dirty overlay file count ${freshness.dirtyFiles} exceeds ${policy.maxDirtyFiles}.`,
      actual: freshness.dirtyFiles,
      expected: policy.maxDirtyFiles,
    });
  }
  if (policy.maxBaselineAgeSeconds !== undefined
    && (freshness.baselineAgeSeconds === null
      || freshness.baselineAgeSeconds > policy.maxBaselineAgeSeconds)) {
    issues.push({
      severity: 'error',
      code: 'BASELINE_TOO_OLD',
      message: freshness.baselineAgeSeconds === null
        ? 'No baseline timestamp is available.'
        : `Baseline age ${freshness.baselineAgeSeconds}s exceeds ${policy.maxBaselineAgeSeconds}s.`,
      actual: freshness.baselineAgeSeconds,
      expected: policy.maxBaselineAgeSeconds,
    });
  }
}

function evaluateMigrationGradeProvenance(input: {
  selected: InternalFileCoverageRow[];
  provenance: IndexHealthReport['provenance'];
  rootDir: string | null;
  branch: string | undefined;
  issues: IndexHealthIssue[];
}): void {
  const { selected, provenance, rootDir, branch, issues } = input;
  const baseline = provenance.latestBaselineRun;
  if (!baseline) return;

  if (baseline.status !== 'succeeded') {
    issues.push({
      severity: 'error',
      code: 'BASELINE_RUN_NOT_SUCCESSFUL',
      message: `Latest relevant baseline run has status "${baseline.status}"; migration-grade validation requires "succeeded".`,
      scope: baseline.id,
    });
  }
  if (baseline.completedAt === null) {
    issues.push({
      severity: 'error',
      code: 'BASELINE_RUN_INCOMPLETE',
      message: 'Latest relevant baseline run has no completion timestamp.',
      scope: baseline.id,
    });
  }
  if (baseline.fallbackDegraded) {
    issues.push({
      severity: 'error',
      code: 'BASELINE_RUN_FALLBACK_DEGRADED',
      message: 'Latest relevant baseline run used a degraded structural fallback.',
      scope: baseline.id,
    });
  }
  if (provenance.promotedGeneration === null
    || baseline.generation !== provenance.promotedGeneration) {
    issues.push({
      severity: 'error',
      code: 'BASELINE_GENERATION_MISMATCH',
      message: provenance.promotedGeneration === null
        ? `Baseline run generation ${baseline.generation} is not backed by a promoted generation.`
        : `Latest baseline run generation ${baseline.generation} does not match promoted generation ${provenance.promotedGeneration}.`,
      actual: baseline.generation,
      ...(provenance.promotedGeneration !== null && { expected: provenance.promotedGeneration }),
    });
  }
  if (branch !== undefined && baseline.branch !== branch) {
    issues.push({
      severity: 'error',
      code: 'BASELINE_BRANCH_MISMATCH',
      message: `Latest baseline run branch "${baseline.branch}" does not match selected branch "${branch}".`,
      scope: baseline.branch,
    });
  }
  if (rootDir !== null && !sameRoot(rootDir, baseline.rootDir)) {
    issues.push({
      severity: 'error',
      code: 'BASELINE_ROOT_MISMATCH',
      message: `Latest baseline run root "${baseline.rootDir}" does not match validation root "${rootDir}".`,
      scope: baseline.rootDir,
      paths: [baseline.rootDir, rootDir],
    });
  }

  const baselineStructuralRows = provenance.indexers.filter((row) =>
    row.runId === baseline.id
    && (row.provider === 'scip' || row.provider === 'lsp')
    && row.status === 'succeeded');
  const requiredLanguages = [...new Set(selected.map((row) => row.language))].sort();
  const missingLanguages = requiredLanguages.filter((language) =>
    !baselineStructuralRows.some((row) => row.languages.includes(language)));
  if (missingLanguages.length > 0) {
    issues.push({
      severity: 'error',
      code: 'STRUCTURAL_PROVIDER_MISSING',
      scope: missingLanguages.join(','),
      message: `Latest baseline has no successful structural provider for: ${missingLanguages.join(', ')}.`,
    });
  }
}

function evaluateRequiredGlobs(
  policy: ResolvedIndexValidationPolicy,
  files: InternalFileCoverageRow[],
  issues: IndexHealthIssue[],
): void {
  for (const pattern of policy.requiredGlobs) {
    const matches = files.filter((file) => matchesAnyGlob(file.relativePath, [pattern]));
    if (matches.length === 0) {
      issues.push({
        severity: 'error',
        code: 'REQUIRED_GLOB_UNMATCHED',
        scope: pattern,
        message: `Required glob "${pattern}" matched no selected indexed files.`,
      });
      continue;
    }
    const symbolLess = matches.filter((file) => file.symbols === 0);
    if (symbolLess.length > 0) {
      issues.push({
        severity: 'error',
        code: 'REQUIRED_FILE_SYMBOL_LESS',
        scope: pattern,
        message: `${symbolLess.length} file(s) required by "${pattern}" contain no symbols.`,
        actual: symbolLess.length,
        expected: 0,
        paths: symbolLess.slice(0, 10).map((file) => file.relativePath),
      });
    }
  }
}

interface ThresholdExtras {
  invalidSpans: number;
  duplicateSymbols: number;
  unresolvedInternal: number;
}

function evaluateThresholds(
  scope: string,
  metrics: CoverageMetrics,
  thresholds: IndexCoverageThresholds,
  extras: ThresholdExtras,
  issues: IndexHealthIssue[],
): void {
  const minima: Array<[keyof IndexCoverageThresholds, number | null, string]> = [
    ['minFiles', metrics.files, 'files'],
    ['minSymbols', metrics.symbols, 'symbols'],
    ['minCallRefs', metrics.calls.total, 'call references'],
    ['minTypeRefs', metrics.types.total, 'type references'],
    ['minImports', metrics.imports.total, 'imports'],
    ['minSymbolCoverage', metrics.symbolCoverage, 'symbol file coverage'],
    ['minCallResolutionRate', metrics.calls.resolutionRate, 'call resolution rate'],
    ['minTypeResolutionRate', metrics.types.resolutionRate, 'type resolution rate'],
    ['minImportResolutionRate', metrics.imports.resolutionRate, 'import resolution rate'],
  ];
  for (const [key, actual, label] of minima) {
    const expected = thresholds[key];
    if (expected === undefined || (actual !== null && actual >= expected)) continue;
    issues.push({
      severity: 'error',
      code: `THRESHOLD_${String(key).replace(/([A-Z])/g, '_$1').toUpperCase()}`,
      scope,
      message: `${scope} ${label} ${formatMetric(actual)} is below ${formatMetric(expected)}.`,
      actual,
      expected,
    });
  }

  const maxima: Array<[keyof IndexCoverageThresholds, number, string]> = [
    ['maxSymbolLessFiles', metrics.symbolLessFiles, 'symbol-less files'],
    ['maxInvalidSpans', extras.invalidSpans, 'invalid spans'],
    ['maxDuplicateSymbols', extras.duplicateSymbols, 'duplicate symbols'],
    ['maxUnresolvedInternalRefs', extras.unresolvedInternal, 'apparently-internal unresolved references'],
  ];
  for (const [key, actual, label] of maxima) {
    const expected = thresholds[key];
    if (expected === undefined || actual <= expected) continue;
    issues.push({
      severity: 'error',
      code: `THRESHOLD_${String(key).replace(/([A-Z])/g, '_$1').toUpperCase()}`,
      scope,
      message: `${scope} ${label} ${actual} exceeds ${expected}.`,
      actual,
      expected,
    });
  }
}

function readFileCoverage(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
): FileCoverageRow[] {
  const sql = `
    WITH symbol_counts AS (
      SELECT file_id, COUNT(*) AS total FROM ${relations.symbols} GROUP BY file_id
    ), call_counts AS (
          SELECT r.file_id, COUNT(*) AS total,
            SUM(CASE WHEN target.id IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN r.resolution_method = 'external_definition' THEN 1 ELSE 0 END) AS external
          FROM ${relations.calls} r
          LEFT JOIN ${relations.symbols} target ON target.id = r.callee_id
          WHERE r.file_id IS NOT NULL GROUP BY r.file_id
    ), type_counts AS (
          SELECT r.file_id, COUNT(*) AS total,
            SUM(CASE WHEN target.id IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN r.resolution_method = 'external_definition' THEN 1 ELSE 0 END) AS external
          FROM ${relations.types} r
          LEFT JOIN ${relations.symbols} target ON target.id = r.type_id
          GROUP BY r.file_id
    ), import_counts AS (
          SELECT r.file_id, COUNT(*) AS total,
        SUM(CASE WHEN target.id IS NOT NULL
          AND r.resolution_method NOT LIKE 'include_%'
              THEN 1 ELSE 0 END) AS internal_resolved,
        SUM(CASE WHEN r.resolved_id IS NULL
          AND r.resolution_method IN ('external_dependency', 'external_definition')
              THEN 1 ELSE 0 END) AS external_resolved,
        SUM(CASE WHEN target.id IS NOT NULL
          AND r.resolution_method LIKE 'include_%'
              THEN 1 ELSE 0 END) AS heuristic
          FROM ${relations.imports} r
          LEFT JOIN ${relations.files} target ON target.id = r.resolved_id
          GROUP BY r.file_id
    )
    SELECT f.id, f.path, f.branch, f.language, f.indexed_at, f.layer, f.generation,
           COALESCE(sc.total, 0) AS symbols,
           COALESCE(cc.total, 0) AS calls,
           COALESCE(cc.resolved, 0) AS calls_resolved,
           COALESCE(cc.external, 0) AS calls_external,
           COALESCE(tc.total, 0) AS types,
           COALESCE(tc.resolved, 0) AS types_resolved,
           COALESCE(tc.external, 0) AS types_external,
           COALESCE(ic.total, 0) AS imports,
           COALESCE(ic.internal_resolved, 0) AS imports_internal_resolved,
           COALESCE(ic.external_resolved, 0) AS imports_external_resolved,
           COALESCE(ic.heuristic, 0) AS imports_heuristic
    FROM ${relations.files} f
    LEFT JOIN symbol_counts sc ON sc.file_id = f.id
    LEFT JOIN call_counts cc ON cc.file_id = f.id
    LEFT JOIN type_counts tc ON tc.file_id = f.id
    LEFT JOIN import_counts ic ON ic.file_id = f.id
    ${branch !== undefined ? 'WHERE f.branch = ?' : ''}
    ORDER BY f.path, f.branch`;
  return (branch !== undefined ? db.prepare(sql).all(branch) : db.prepare(sql).all()) as FileCoverageRow[];
}

function readSpanRows(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
): SpanRow[] {
  const branchWhere = branch !== undefined ? 'WHERE branch = ?' : '';
  const params = branch !== undefined ? [branch] : [];
  return db.prepare(`
    WITH file_bounds AS MATERIALIZED (
      SELECT id
      FROM ${relations.files}
      ${branchWhere}
    )
    SELECT 'symbol' AS entity, s.id, s.file_id,
           s.start_line, s.start_character, s.end_line, s.end_character,
      s.selection_line, s.selection_character
    FROM ${relations.symbols} s JOIN file_bounds f ON f.id = s.file_id
    UNION ALL
    SELECT 'call', r.id, r.file_id, r.call_line, r.call_character,
      r.call_line, r.call_character, NULL, NULL
    FROM ${relations.calls} r JOIN file_bounds f ON f.id = r.file_id
    WHERE r.file_id IS NOT NULL
    UNION ALL
    SELECT 'type', r.id, r.file_id, r.ref_line, r.ref_character,
      r.ref_line, r.ref_character, NULL, NULL
    FROM ${relations.types} r JOIN file_bounds f ON f.id = r.file_id
    UNION ALL
    SELECT 'relationship', r.id, r.file_id, r.line, r.character,
      r.line, r.character, NULL, NULL
    FROM ${relations.relationships} r JOIN file_bounds f ON f.id = r.file_id
    WHERE r.line IS NOT NULL
    ORDER BY 1, 3, 2
  `).all(...params) as SpanRow[];
}

function readUtf16LineLengths(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
  selectedIds: ReadonlySet<number>,
): Map<number, number[]> {
  const sql = `SELECT id, source FROM ${relations.files}`
    + (branch !== undefined ? ' WHERE branch = ?' : '')
    + ' ORDER BY id';
  const rows = (branch !== undefined ? db.prepare(sql).iterate(branch) : db.prepare(sql).iterate()) as
    IterableIterator<{ id: number; source: string }>;
  const result = new Map<number, number[]>();
  for (const row of rows) {
    if (!selectedIds.has(row.id)) continue;
    // JavaScript string length is the number of UTF-16 code units, matching
    // LSP and Lore's persisted character-coordinate convention.
    result.set(row.id, row.source.split(/\r\n|\r|\n/u).map((line) => line.length));
  }
  return result;
}

function invalidSpanReason(row: SpanRow, lineLengths: readonly number[] | undefined): string | null {
  if (row.start_line === null || row.end_line === null) return 'missing line coordinate';
  if (!Number.isSafeInteger(row.start_line) || !Number.isSafeInteger(row.end_line)) {
    return 'line coordinate is not an integer';
  }
  if (row.start_line < 0 || row.end_line < 0) return 'negative line coordinate';
  if (row.start_character !== null && !Number.isSafeInteger(row.start_character)) {
    return 'start character is not an integer';
  }
  if (row.end_character !== null && !Number.isSafeInteger(row.end_character)) {
    return 'end character is not an integer';
  }
  if (row.start_character !== null && row.start_character < 0) return 'negative start character';
  if (row.end_character !== null && row.end_character < 0) return 'negative end character';
  if (row.end_line < row.start_line) return 'end precedes start';
  if (row.end_line === row.start_line
    && row.start_character !== null && row.end_character !== null
    && row.end_character < row.start_character) return 'end character precedes start';
  if (!lineLengths || row.start_line >= lineLengths.length || row.end_line >= lineLengths.length) {
    return 'line coordinate is outside the stored source snapshot';
  }
  if (row.start_character !== null && row.start_character > lineLengths[row.start_line]!) {
    return 'start character is outside the UTF-16 line length';
  }
  if (row.end_character !== null && row.end_character > lineLengths[row.end_line]!) {
    return 'end character is outside the UTF-16 line length';
  }
  if (row.selection_line !== null && !Number.isSafeInteger(row.selection_line)) {
    return 'selection line is not an integer';
  }
  if (row.selection_character !== null && !Number.isSafeInteger(row.selection_character)) {
    return 'selection character is not an integer';
  }
  if (row.selection_line !== null
    && (row.selection_line < row.start_line || row.selection_line > row.end_line)) {
    return 'selection line is outside the symbol span';
  }
  if (row.selection_character !== null && row.selection_character < 0) {
    return 'negative selection character';
  }
  if (row.selection_character !== null && row.selection_line === null) {
    return 'selection character has no selection line';
  }
  if (row.selection_line !== null && row.selection_line >= lineLengths.length) {
    return 'selection line is outside the stored source snapshot';
  }
  if (row.selection_line !== null && row.selection_character !== null
    && row.selection_character > lineLengths[row.selection_line]!) {
    return 'selection character is outside the UTF-16 line length';
  }
  if (row.selection_line === row.start_line
    && row.selection_character !== null && row.start_character !== null
    && row.selection_character < row.start_character) {
    return 'selection character precedes the symbol span';
  }
  if (row.selection_line === row.end_line
    && row.selection_character !== null && row.end_character !== null
    && row.selection_character > row.end_character) {
    return 'selection character follows the symbol span';
  }
  return null;
}

function readDuplicatePaths(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
): Array<{ path: string; branch: string; count: number }> {
  const sql = `SELECT path, branch, COUNT(*) AS count FROM ${relations.files}
    ${branch !== undefined ? 'WHERE branch = ?' : ''}
    GROUP BY path, branch HAVING COUNT(*) > 1 ORDER BY count DESC, path`;
  return (branch !== undefined ? db.prepare(sql).all(branch) : db.prepare(sql).all()) as Array<{
    path: string; branch: string; count: number;
  }>;
}

interface DuplicateSymbolRow {
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  start_character: number | null;
  count: number;
}

function readDuplicateSymbols(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
): DuplicateSymbolRow[] {
  const sql = `
    SELECT s.file_id, s.name, s.kind, s.start_line, s.start_character, COUNT(*) AS count
    FROM ${relations.symbols} s JOIN ${relations.files} f ON f.id = s.file_id
    ${branch !== undefined ? 'WHERE f.branch = ?' : ''}
    GROUP BY s.file_id, s.name, s.kind, s.start_line, COALESCE(s.start_character, -1),
             s.end_line, COALESCE(s.end_character, -1),
             COALESCE(s.selection_line, -1), COALESCE(s.selection_character, -1),
             COALESCE(s.signature, ''), COALESCE(s.parent_symbol_id, -1)
    HAVING COUNT(*) > 1
    ORDER BY count DESC, s.file_id, s.start_line`;
  return (branch !== undefined ? db.prepare(sql).all(branch) : db.prepare(sql).all()) as DuplicateSymbolRow[];
}

interface ResolutionMethodRow {
  entity: ResolutionMethodMetric['entity'];
  file_id: number;
  method: string;
  count: number;
  resolved: number;
  external: number;
}

function readResolutionMethods(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
): ResolutionMethodRow[] {
  const branchAnd = branch !== undefined ? 'AND f.branch = ?' : '';
  const params = branch !== undefined ? [branch, branch, branch, branch] : [];
  return db.prepare(`
    SELECT 'call' AS entity, r.file_id, r.resolution_method AS method, COUNT(*) AS count,
          SUM(CASE WHEN target.id IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
           SUM(CASE WHEN r.resolution_method = 'external_definition' THEN 1 ELSE 0 END) AS external
    FROM ${relations.calls} r JOIN ${relations.files} f ON f.id = r.file_id
        LEFT JOIN ${relations.symbols} target ON target.id = r.callee_id
    WHERE r.file_id IS NOT NULL ${branchAnd}
    GROUP BY r.file_id, r.resolution_method
    UNION ALL
    SELECT 'type', r.file_id, r.resolution_method, COUNT(*),
          SUM(CASE WHEN target.id IS NOT NULL THEN 1 ELSE 0 END),
           SUM(CASE WHEN r.resolution_method = 'external_definition' THEN 1 ELSE 0 END)
    FROM ${relations.types} r JOIN ${relations.files} f ON f.id = r.file_id
        LEFT JOIN ${relations.symbols} target ON target.id = r.type_id
    WHERE 1 = 1 ${branchAnd}
    GROUP BY r.file_id, r.resolution_method
    UNION ALL
    SELECT 'relationship', r.file_id, r.resolution_method, COUNT(*),
          SUM(CASE WHEN target.id IS NOT NULL THEN 1 ELSE 0 END),
           SUM(CASE WHEN r.resolution_method = 'external_definition' THEN 1 ELSE 0 END)
    FROM ${relations.relationships} r JOIN ${relations.files} f ON f.id = r.file_id
        LEFT JOIN ${relations.symbols} target ON target.id = r.target_symbol_id
    WHERE 1 = 1 ${branchAnd}
    GROUP BY r.file_id, r.resolution_method
    UNION ALL
    SELECT 'import', r.file_id, r.resolution_method, COUNT(*),
          SUM(CASE WHEN target.id IS NOT NULL
                          OR r.resolution_method IN ('external_dependency', 'external_definition')
                    THEN 1 ELSE 0 END),
           SUM(CASE WHEN r.resolution_method IN ('external_dependency', 'external_definition')
                    THEN 1 ELSE 0 END)
    FROM ${relations.imports} r JOIN ${relations.files} f ON f.id = r.file_id
    LEFT JOIN ${relations.files} target ON target.id = r.resolved_id
    WHERE 1 = 1 ${branchAnd}
    GROUP BY r.file_id, r.resolution_method
  `).all(...params) as ResolutionMethodRow[];
}

function aggregateResolutionMethods(rows: ResolutionMethodRow[]): ResolutionMethodMetric[] {
  const totals = countBy(rows, (row) => row.entity, (row) => row.count);
  const grouped = new Map<string, { entity: ResolutionMethodMetric['entity']; method: string; count: number }>();
  for (const row of rows) {
    const key = `${row.entity}\0${row.method}`;
    const current = grouped.get(key) ?? { entity: row.entity, method: row.method, count: 0 };
    current.count += row.count;
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((row) => ({ ...row, rate: row.count / (totals[row.entity] ?? row.count) }))
    .sort((a, b) => a.entity.localeCompare(b.entity) || b.count - a.count || a.method.localeCompare(b.method));
}

function aggregateRelationshipCoverage(rows: ResolutionMethodRow[]): ReferenceCoverage {
  const relationshipRows = rows.filter((row) => row.entity === 'relationship');
  const total = sum(relationshipRows, (row) => row.count);
  const resolved = sum(relationshipRows, (row) => row.resolved);
  const external = sum(relationshipRows, (row) => row.external);
  return referenceCoverage(total, resolved, external);
}

interface InternalUnresolvedRow {
  entity: UnresolvedInternalSample['entity'];
  id: number;
  file_id: number;
  target: string;
  reason: UnresolvedInternalSample['reason'];
}

function readInternalUnresolved(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
): InternalUnresolvedRow[] {
  const branchWhere = branch !== undefined ? 'WHERE branch = ?' : '';
  const params = branch !== undefined ? [branch] : [];
  return db.prepare(`
    WITH scoped_files AS MATERIALIZED (
      SELECT id, path FROM ${relations.files} ${branchWhere}
    ), internal_symbol_names AS MATERIALIZED (
      SELECT DISTINCT lower(s.name) AS name
      FROM ${relations.symbols} s JOIN scoped_files f ON f.id = s.file_id
    )
    SELECT 'call' AS entity, r.id, r.file_id, r.callee_name AS target,
           CASE WHEN r.definition_path IS NOT NULL AND EXISTS (
             SELECT 1 FROM scoped_files candidate_file
             WHERE candidate_file.path = r.definition_path
           ) THEN 'indexed-definition-path' ELSE 'indexed-symbol-name' END AS reason
    FROM ${relations.calls} r JOIN scoped_files f ON f.id = r.file_id
    LEFT JOIN ${relations.symbols} target_symbol ON target_symbol.id = r.callee_id
    WHERE target_symbol.id IS NULL AND r.resolution_method != 'external_definition'
      AND ((r.definition_path IS NOT NULL AND EXISTS (
             SELECT 1 FROM scoped_files candidate_file
             WHERE candidate_file.path = r.definition_path
           )) OR EXISTS (
             SELECT 1 FROM internal_symbol_names
             WHERE name = lower(r.callee_name)
           ))
    UNION ALL
    SELECT 'type', r.id, r.file_id, r.type_name,
           CASE WHEN r.definition_path IS NOT NULL AND EXISTS (
             SELECT 1 FROM scoped_files candidate_file
             WHERE candidate_file.path = r.definition_path
           ) THEN 'indexed-definition-path' ELSE 'indexed-symbol-name' END
    FROM ${relations.types} r JOIN scoped_files f ON f.id = r.file_id
    LEFT JOIN ${relations.symbols} target_symbol ON target_symbol.id = r.type_id
    WHERE target_symbol.id IS NULL AND r.resolution_method != 'external_definition'
      AND ((r.definition_path IS NOT NULL AND EXISTS (
             SELECT 1 FROM scoped_files candidate_file
             WHERE candidate_file.path = r.definition_path
           )) OR EXISTS (
             SELECT 1 FROM internal_symbol_names
             WHERE name = lower(r.type_name_bare)
           ))
    UNION ALL
    SELECT 'relationship', r.id, r.file_id, r.target_symbol_name,
           CASE WHEN r.definition_path IS NOT NULL AND EXISTS (
             SELECT 1 FROM scoped_files candidate_file
             WHERE candidate_file.path = r.definition_path
           ) THEN 'indexed-definition-path' ELSE 'indexed-symbol-name' END
    FROM ${relations.relationships} r JOIN scoped_files f ON f.id = r.file_id
    LEFT JOIN ${relations.symbols} target_symbol ON target_symbol.id = r.target_symbol_id
    WHERE target_symbol.id IS NULL AND r.resolution_method != 'external_definition'
      AND ((r.definition_path IS NOT NULL AND EXISTS (
             SELECT 1 FROM scoped_files candidate_file
             WHERE candidate_file.path = r.definition_path
           )) OR EXISTS (
             SELECT 1 FROM internal_symbol_names
             WHERE name = lower(r.target_symbol_name)
           ))
    ORDER BY 1, 3, 2
  `).all(...params) as InternalUnresolvedRow[];
}

function classifyInternalImports(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
  selected: InternalFileCoverageRow[],
  allFiles: InternalFileCoverageRow[],
): InternalUnresolvedRow[] {
  const selectedIds = new Set(selected.map((row) => row.id));
  const sql = `SELECT i.id, i.file_id, i.raw_import
    FROM ${relations.imports} i JOIN ${relations.files} f ON f.id = i.file_id
    LEFT JOIN ${relations.files} target_file ON target_file.id = i.resolved_id
    WHERE target_file.id IS NULL AND i.resolution_method = 'unresolved'
      ${branch !== undefined ? 'AND f.branch = ?' : ''}
    ORDER BY f.path, i.id`;
  const rows = (branch !== undefined ? db.prepare(sql).all(branch) : db.prepare(sql).all()) as Array<{
    id: number; file_id: number; raw_import: string;
  }>;
  const indexedRelativePaths = allFiles.map((file) => file.relativePath);
  return rows.flatMap((row): InternalUnresolvedRow[] => {
    if (!selectedIds.has(row.file_id)) return [];
    const raw = row.raw_import.trim().replace(/^<|>$/gu, '').replace(/^['"]|['"]$/gu, '').replace(/\\/gu, '/');
    const explicitlyRelative = raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/');
    const normalized = raw.replace(/^\.\//u, '').replace(/^(\.\.\/)+/u, '');
    const suffixMatch = normalized.length > 0 && indexedRelativePaths.some((candidate) =>
      candidate === normalized
        || candidate.endsWith(`/${normalized}`)
        || candidate.replace(/\.[^/.]+$/u, '') === normalized
        || candidate.replace(/\.[^/.]+$/u, '').endsWith(`/${normalized}`));
    if (!explicitlyRelative && !suffixMatch) return [];
    return [{
      entity: 'import',
      id: row.id,
      file_id: row.file_id,
      target: row.raw_import,
      reason: 'internal-import-path',
    }];
  });
}

function readProvenance(
  db: Database.Database,
  branch: string | undefined,
): IndexHealthReport['provenance'] {
  const promotedGeneration = readPromotedGeneration(db, branch);
  const empty = {
    latestRun: null,
    latestBaselineRun: null,
    indexers: [],
    compilationDatabases: [],
    legacyScipMetadata: parseJson(getLoreMeta(db, 'scip_c_cpp_reproducibility')),
    promotedGeneration,
    diagnostics: {
      positionConversions: [],
      supplementation: [],
    },
  } satisfies IndexHealthReport['provenance'];
  if (!objectExists(db, 'index_runs') || !objectExists(db, 'indexer_runs')) return empty;

  const branchClause = branch !== undefined ? 'WHERE branch = ?' : '';
  const latestRaw = (branch !== undefined
    ? db.prepare(`SELECT * FROM index_runs ${branchClause} ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(branch)
    : db.prepare('SELECT * FROM index_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get()) as IndexRunDbRow | undefined;
  const baselineWhere = branch !== undefined
    ? "WHERE branch = ? AND layer = 'baseline'"
    : "WHERE layer = 'baseline'";
  const baselineRaw = (branch !== undefined
    ? db.prepare(`SELECT * FROM index_runs ${baselineWhere} ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(branch)
    : db.prepare(`SELECT * FROM index_runs ${baselineWhere} ORDER BY started_at DESC, rowid DESC LIMIT 1`).get()) as IndexRunDbRow | undefined;
  const runIds = [...new Set([latestRaw?.id, baselineRaw?.id].filter((id): id is string => Boolean(id)))];
  if (runIds.length === 0) return empty;
  const placeholders = runIds.map(() => '?').join(', ');
  const indexers = (db.prepare(
    `SELECT * FROM indexer_runs WHERE run_id IN (${placeholders}) ORDER BY id`,
  ).all(...runIds) as IndexerRunDbRow[]).map(mapIndexerRun);
  const toDiagnostic = (row: IndexerRunInfo): IndexerDiagnosticInfo => ({
    runId: row.runId,
    indexer: row.indexer,
    languages: row.languages,
    status: row.status,
    details: row.details,
  });
  return {
    latestRun: latestRaw ? mapIndexRun(latestRaw) : null,
    latestBaselineRun: baselineRaw ? mapIndexRun(baselineRaw) : null,
    indexers,
    compilationDatabases: indexers.filter((row) => row.provider === 'compdb'),
    legacyScipMetadata: empty.legacyScipMetadata,
    promotedGeneration,
    diagnostics: {
      positionConversions: indexers
        .filter((row) => detailObject(row.details, 'positionConversion') !== null)
        .map(toDiagnostic),
      supplementation: indexers
        .filter((row) => detailObject(row.details, 'supplementation') !== null)
        .map(toDiagnostic),
    },
  };
}

function applyCandidateProvenance(
  provenance: IndexHealthReport['provenance'],
  options: ValidateIndexOptions,
): void {
  if (options.candidateGeneration === undefined) return;
  provenance.promotedGeneration = options.candidateGeneration;
  if (!options.candidateRunId || !options.candidateRunStatus) return;

  for (const run of [provenance.latestRun, provenance.latestBaselineRun]) {
    if (run?.id !== options.candidateRunId) continue;
    run.status = options.candidateRunStatus;
    run.completedAt = options.candidateRunCompletedAt ?? Math.floor(Date.now() / 1000);
    run.fallbackDegraded = options.candidateFallbackDegraded ?? run.fallbackDegraded;
    run.error = null;
  }
}

function readPromotedGeneration(
  db: Database.Database,
  branch: string | undefined,
): number | null {
  if (branch === undefined) {
    const rows = db.prepare(
      'SELECT DISTINCT generation FROM baseline_generations ORDER BY generation LIMIT 2',
    ).all() as Array<{ generation: number }>;
    return rows.length === 1 ? rows[0]!.generation : null;
  }
  const row = db.prepare(
    'SELECT generation FROM baseline_generations WHERE branch = ?',
  ).get(branch) as { generation: number } | undefined;
  return row?.generation ?? null;
}

interface IndexRunDbRow {
  id: string;
  mode: string;
  root_dir: string;
  branch: string;
  layer: string;
  generation: number;
  started_at: number;
  completed_at: number | null;
  status: string;
  fallback_degraded: number;
  error: string | null;
  config_json: string | null;
}

interface IndexerRunDbRow {
  run_id: string;
  provider: string;
  indexer: string;
  languages_json: string;
  status: string;
  attempted: number;
  fallback: number;
  files: number | null;
  symbols: number | null;
  call_refs: number | null;
  type_refs: number | null;
  imports: number | null;
  message: string | null;
  details_json: string | null;
}

function mapIndexRun(row: IndexRunDbRow): IndexRunInfo {
  return {
    id: row.id,
    mode: row.mode,
    rootDir: row.root_dir,
    branch: row.branch,
    layer: row.layer,
    generation: row.generation,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    fallbackDegraded: row.fallback_degraded !== 0,
    error: row.error,
    config: parseJson(row.config_json),
  };
}

function mapIndexerRun(row: IndexerRunDbRow): IndexerRunInfo {
  const parsedLanguages = parseJson(row.languages_json);
  return {
    provider: row.provider,
    indexer: row.indexer,
    languages: Array.isArray(parsedLanguages)
      ? parsedLanguages.filter((value): value is string => typeof value === 'string')
      : [],
    status: row.status,
    attempted: row.attempted !== 0,
    fallback: row.fallback !== 0,
    files: row.files,
    symbols: row.symbols,
    callRefs: row.call_refs,
    typeRefs: row.type_refs,
    imports: row.imports,
    message: row.message,
    details: parseJson(row.details_json),
    runId: row.run_id,
  };
}

function readFreshness(
  db: Database.Database,
  relations: Relations,
  branch: string | undefined,
  candidateGeneration?: number,
): IndexHealthReport['freshness'] {
  const branchClause = branch !== undefined ? 'AND f.branch = ?' : '';
  const queryArgs = branch !== undefined ? [branch] : [];
  const baseline = candidateGeneration === undefined
    ? db.prepare(
        `SELECT MAX(f.indexed_at) AS latest
           FROM files f
           JOIN baseline_generations promoted
             ON promoted.branch = f.branch
            AND promoted.generation = f.generation
          WHERE f.layer = 'baseline' ${branchClause}`,
      ).get(...queryArgs) as { latest: number | null }
    : db.prepare(
        `SELECT MAX(f.indexed_at) AS latest
           FROM files f
          WHERE f.layer = 'baseline'
            AND f.generation = ? ${branchClause}`,
      ).get(candidateGeneration, ...queryArgs) as { latest: number | null };
  const latest = db.prepare(
    `SELECT MAX(f.indexed_at) AS latest FROM ${relations.files} f WHERE 1 = 1 ${branchClause}`,
  ).get(...queryArgs) as { latest: number | null };
  const overlays = db.prepare(
    `SELECT COUNT(*) AS files,
            COALESCE((SELECT COUNT(*)
                        FROM ${relations.symbols} s
                        JOIN ${relations.files} sf ON sf.id = s.file_id
                       WHERE sf.layer = 'overlay' ${branch !== undefined ? 'AND sf.branch = ?' : ''}), 0) AS symbols
       FROM ${relations.files} f
      WHERE f.layer = 'overlay' ${branchClause}`,
  ).get(...(branch !== undefined ? [branch, branch] : [])) as { files: number; symbols: number };
  let dirty = { count: 0, oldest: null as number | null };
  if (objectExists(db, 'dirty_files')) {
    dirty = db.prepare(
      `SELECT COUNT(*) AS count, MIN(dirty_since) AS oldest FROM dirty_files
       ${branch !== undefined ? 'WHERE branch = ?' : ''}`,
    ).get(...queryArgs) as { count: number; oldest: number | null };
  }
  const now = Math.floor(Date.now() / 1000);
  const pendingRaw = getLoreMeta(db, 'generation_pending');
  return {
    source: latest.latest === null ? 'empty' : dirty.count > 0 ? 'mixed' : 'baseline',
    baselineAgeSeconds: baseline.latest === null ? null : Math.max(0, now - baseline.latest),
    latestIndexedAt: latest.latest,
    dirtyFiles: dirty.count,
    overlayFiles: overlays.files,
    overlaySymbols: overlays.symbols,
    oldestDirtyAt: dirty.oldest,
    pendingGeneration: pendingRaw !== undefined && Number.isFinite(Number(pendingRaw))
      ? Number(pendingRaw)
      : null,
    baselineHeadSha: getLoreMeta(db, 'baseline_head_sha') ?? null,
    overlayHeadSha: getLoreMeta(db, 'overlay_head_sha') ?? null,
  };
}

function aggregateCoverage(rows: InternalFileCoverageRow[]): CoverageMetrics {
  const files = rows.length;
  const filesWithSymbols = rows.filter((row) => row.symbols > 0).length;
  const filesWithCallRefs = rows.filter((row) => row.calls > 0).length;
  const filesWithTypeRefs = rows.filter((row) => row.types > 0).length;
  const filesWithImports = rows.filter((row) => row.imports > 0).length;
  const calls = referenceCoverage(
    sum(rows, (row) => row.calls),
    sum(rows, (row) => row.calls_resolved),
    sum(rows, (row) => row.calls_external),
  );
  const types = referenceCoverage(
    sum(rows, (row) => row.types),
    sum(rows, (row) => row.types_resolved),
    sum(rows, (row) => row.types_external),
  );
  const importTotal = sum(rows, (row) => row.imports);
  const importInternalResolved = sum(rows, (row) => row.imports_internal_resolved);
  const importExternalResolved = sum(rows, (row) => row.imports_external_resolved);
  const importHeuristic = sum(rows, (row) => row.imports_heuristic);
  const importResolved = importInternalResolved + importExternalResolved + importHeuristic;
  return {
    files,
    filesWithSymbols,
    symbolLessFiles: files - filesWithSymbols,
    symbols: sum(rows, (row) => row.symbols),
    symbolCoverage: ratio(filesWithSymbols, files),
    filesWithCallRefs,
    callFileCoverage: ratio(filesWithCallRefs, files),
    calls,
    filesWithTypeRefs,
    typeFileCoverage: ratio(filesWithTypeRefs, files),
    types,
    filesWithImports,
    importFileCoverage: ratio(filesWithImports, files),
    imports: {
      total: importTotal,
      internalResolved: importInternalResolved,
      externalResolved: importExternalResolved,
      heuristic: importHeuristic,
      resolved: importResolved,
      unresolved: Math.max(0, importTotal - importResolved),
      resolutionRate: ratio(importResolved, importTotal),
    },
  };
}

function emptyCoverage(): CoverageMetrics {
  return aggregateCoverage([]);
}

function aggregateCoverageBy(
  rows: InternalFileCoverageRow[],
  key: (row: InternalFileCoverageRow) => string,
): Record<string, CoverageMetrics> {
  const grouped = new Map<string, InternalFileCoverageRow[]>();
  for (const row of rows) {
    const name = key(row);
    const values = grouped.get(name) ?? [];
    values.push(row);
    grouped.set(name, values);
  }
  return Object.fromEntries([...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, values]) => [name, aggregateCoverage(values)]));
}

function referenceCoverage(total: number, resolved: number, external: number): ReferenceCoverage {
  const classified = Math.min(total, resolved + external);
  return {
    total,
    resolved,
    external,
    unresolved: Math.max(0, total - classified),
    resolutionRate: ratio(classified, total),
  };
}

function buildSpanEntityMetrics(
  rows: SpanRow[],
  invalidRows: SpanRow[],
): Record<string, { total: number; invalid: number }> {
  const totals = countBy(rows, (row) => row.entity);
  const invalid = countBy(invalidRows, (row) => row.entity);
  return Object.fromEntries(['symbol', 'call', 'type', 'relationship'].map((entity) => [entity, {
    total: totals[entity] ?? 0,
    invalid: invalid[entity] ?? 0,
  }]));
}

function resolveRelations(db: Database.Database): Relations {
  const effective = objectExists(db, 'effective_files');
  return {
    files: effective ? 'effective_files' : 'files',
    symbols: effective && objectExists(db, 'effective_symbols') ? 'effective_symbols' : 'symbols',
    calls: effective && objectExists(db, 'effective_symbol_refs') ? 'effective_symbol_refs' : 'symbol_refs',
    types: effective && objectExists(db, 'effective_type_refs') ? 'effective_type_refs' : 'type_refs',
    relationships: effective && objectExists(db, 'effective_symbol_relationships')
      ? 'effective_symbol_relationships' : 'symbol_relationships',
    imports: effective && objectExists(db, 'effective_file_imports') ? 'effective_file_imports' : 'file_imports',
  };
}

function objectExists(db: Database.Database, name: string): boolean {
  return db.prepare(
    `SELECT 1 AS found FROM sqlite_master
     WHERE name = ? AND type IN ('table', 'view') LIMIT 1`,
  ).get(name) !== undefined;
}

function readOnlyBranch(db: Database.Database, filesRelation: string): string | undefined {
  const rows = db.prepare(`SELECT DISTINCT branch FROM ${filesRelation} ORDER BY branch LIMIT 2`)
    .all() as Array<{ branch: string }>;
  return rows.length === 1 ? rows[0]!.branch : undefined;
}

function toFileSample(row: InternalFileCoverageRow): FileHealthSample {
  return {
    path: row.path,
    relativePath: row.relativePath,
    language: row.language,
    extension: row.extension,
    layer: row.layer,
  };
}

function pathSelected(path: string, policy: ResolvedIndexValidationPolicy): boolean {
  return matchesAnyGlob(path, policy.includeGlobs)
    && !matchesAnyGlob(path, policy.excludeGlobs);
}

function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  return patterns.some((pattern) => expandBraces(pattern).some((expanded) =>
    globToRegExp(expanded).test(normalized)));
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]+)\}/u.exec(pattern);
  if (!match || match.index === undefined) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  return match[1]!.split(',').flatMap((choice) => expandBraces(`${prefix}${choice}${suffix}`));
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/^\//u, '');
  let source = '^';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    const next = normalized[i + 1];
    if (char === '*' && next === '*') {
      const after = normalized[i + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i++;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

function relativeIndexPath(rootDir: string | null, filePath: string): string {
  if (!rootDir) return filePath.replace(/\\/gu, '/');
  const candidate = relative(rootDir, filePath);
  if (candidate === '' || candidate === '..' || candidate.startsWith(`..${sep}`)) {
    return filePath.replace(/\\/gu, '/');
  }
  return candidate.split(sep).join('/');
}

function sameRoot(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    try { return realpathSync(value); } catch { return resolve(value); }
  };
  return canonical(left) === canonical(right);
}

function countRowsByFileLanguage<T extends { file_id: number }>(
  rows: T[],
  files: Map<number, InternalFileCoverageRow>,
  excessField?: keyof T,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const language = files.get(row.file_id)?.language;
    if (!language) continue;
    const raw = excessField ? row[excessField] : 1;
    const amount = typeof raw === 'number' ? (excessField ? Math.max(0, raw - 1) : raw) : 1;
    result[language] = (result[language] ?? 0) + amount;
  }
  return result;
}

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  amount: (value: T) => number = () => 1,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    const name = key(value);
    result[name] = (result[name] ?? 0) + amount(value);
  }
  return result;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  let total = 0;
  for (const value of values) total += select(value);
  return total;
}

function excessCount(values: Array<{ count: number }>): number {
  return sum(values, (value) => Math.max(0, value.count - 1));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function normalizeSampleLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(1000, Math.floor(value)));
}

function parseJson(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function detailObject(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

function numericDetail(value: unknown, group: string, key: string): number {
  const raw = detailObject(value, group)?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function formatMetric(value: number | null): string {
  if (value === null) return 'n/a';
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function incompatibleSchemaReport(
  options: ValidateIndexOptions,
  databaseSchema: LoreSchemaInspection,
): IndexHealthReport {
  const policy = resolveIndexValidationPolicy({}, {
    ...policyFieldsFromOptions(options),
    ...(options.policy ?? {}),
    ...(options.profile && { profile: options.profile }),
  });
  const outdated = databaseSchema.status === 'outdated';
  const newer = databaseSchema.status === 'newer';
  const guidance = newer
    ? `Use Lore version ${databaseSchema.version} or newer; this build supports schema ${databaseSchema.requiredVersion} and will not downgrade the database.`
    : outdated
    ? 'Validation is read-only and did not modify the database. Run an explicit `lore migrate --db <path>` with this Lore version, or rebuild into a new database with `lore index`.'
    : 'Create a Lore index with `lore index --root <dir> --db <path>` before running validation.';
  const error: IndexHealthIssue = {
    severity: 'error',
    code: newer ? 'SCHEMA_NEWER' : outdated ? 'SCHEMA_OUTDATED' : 'SCHEMA_MISSING',
    message: newer
      ? `The Lore database schema version ${databaseSchema.version} is newer than this validator supports (${databaseSchema.requiredVersion}).`
      : outdated
      ? `The Lore database schema is not compatible with this validator (${databaseSchema.missing.length} required table/column capability entries are missing).`
      : 'The database does not contain a Lore schema.',
    scope: databaseSchema.missing.slice(0, 20).join(','),
    guidance,
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ok: false,
    status: 'invalid',
    profile: policy.profile,
    databaseSchema,
    rootDir: options.rootDir ?? null,
    branch: options.branch ?? null,
    selection: {
      includeGlobs: policy.includeGlobs,
      excludeGlobs: policy.excludeGlobs,
      requiredGlobs: policy.requiredGlobs,
      indexedFiles: 0,
      selectedFiles: 0,
    },
    coverage: { overall: emptyCoverage(), byLanguage: {}, byExtension: {} },
    symbolLessFiles: { total: 0, files: [], truncated: false },
    spans: { total: 0, invalid: 0, validRate: null, byEntity: {}, samples: [], truncated: false },
    duplicates: {
      paths: { groups: 0, excessRows: 0, samples: [] },
      symbols: { groups: 0, excessRows: 0, samples: [] },
    },
    resolution: {
      methods: [], calls: referenceCoverage(0, 0, 0), types: referenceCoverage(0, 0, 0),
      relationships: referenceCoverage(0, 0, 0),
    },
    unresolvedInternal: { total: 0, byEntity: {}, samples: [], truncated: false },
    provenance: {
      latestRun: null, latestBaselineRun: null, indexers: [], compilationDatabases: [],
      legacyScipMetadata: null, promotedGeneration: null,
      diagnostics: { positionConversions: [], supplementation: [] },
    },
    freshness: {
      source: 'empty', baselineAgeSeconds: null, latestIndexedAt: null, dirtyFiles: 0,
      overlayFiles: 0, overlaySymbols: 0, oldestDirtyAt: null, pendingGeneration: null,
      baselineHeadSha: null, overlayHeadSha: null,
    },
    warnings: [],
    errors: [error],
  };
}

function policyFieldsFromOptions(options: ValidateIndexOptions): IndexValidationPolicy {
  return {
    ...(options.profile !== undefined && { profile: options.profile }),
    ...(options.includeGlobs !== undefined && { includeGlobs: options.includeGlobs }),
    ...(options.excludeGlobs !== undefined && { excludeGlobs: options.excludeGlobs }),
    ...(options.requiredGlobs !== undefined && { requiredGlobs: options.requiredGlobs }),
    ...(options.thresholds !== undefined && { thresholds: options.thresholds }),
    ...(options.languages !== undefined && { languages: options.languages }),
    ...(options.requireStructuralIndex !== undefined && { requireStructuralIndex: options.requireStructuralIndex }),
    ...(options.requireValidSpans !== undefined && { requireValidSpans: options.requireValidSpans }),
    ...(options.requireIndexerSuccess !== undefined && { requireIndexerSuccess: options.requireIndexerSuccess }),
    ...(options.requireProvenance !== undefined && { requireProvenance: options.requireProvenance }),
    ...(options.failOnWarnings !== undefined && { failOnWarnings: options.failOnWarnings }),
    ...(options.maxBaselineAgeSeconds !== undefined && { maxBaselineAgeSeconds: options.maxBaselineAgeSeconds }),
    ...(options.maxDirtyFiles !== undefined && { maxDirtyFiles: options.maxDirtyFiles }),
  };
}

/** Render a compact terminal-oriented summary; JSON consumers should use the report directly. */
export function formatIndexHealthReport(report: IndexHealthReport): string {
  const metric = report.coverage.overall;
  const status = report.ok
    ? report.status === 'healthy' ? 'HEALTHY' : 'DEGRADED'
    : 'INVALID';
  const lines = [
    `Lore index: ${status} (${report.profile})`,
    `Files ${metric.files} | symbols ${metric.symbols} | symbol coverage ${formatPercent(metric.symbolCoverage)}`,
    `Calls ${metric.calls.total} (${formatPercent(metric.calls.resolutionRate)} resolved) | types ${metric.types.total} (${formatPercent(metric.types.resolutionRate)}) | imports ${metric.imports.total} (${formatPercent(metric.imports.resolutionRate)})`,
    `Import provenance internal ${metric.imports.internalResolved} | external ${metric.imports.externalResolved} | heuristic ${metric.imports.heuristic} | unresolved ${metric.imports.unresolved}`,
    `Spans ${report.spans.invalid}/${report.spans.total} invalid | symbol-less ${report.symbolLessFiles.total} | internal unresolved ${report.unresolvedInternal.total}`,
    `Freshness ${report.freshness.source} | dirty ${report.freshness.dirtyFiles} | baseline age ${report.freshness.baselineAgeSeconds === null ? 'n/a' : `${report.freshness.baselineAgeSeconds}s`}`,
  ];
  for (const [language, coverage] of Object.entries(report.coverage.byLanguage)) {
    lines.push(
      `  ${language}: ${coverage.files} files, ${coverage.symbols} symbols, ${formatPercent(coverage.symbolCoverage)} symbol coverage`,
    );
  }
  for (const diagnostic of report.provenance.diagnostics.positionConversions) {
    const details = detailObject(diagnostic.details, 'positionConversion');
    lines.push(
      `  position conversion (${diagnostic.indexer}): ${String(details?.converted ?? 0)}/${String(details?.conversionRequired ?? 0)} converted, ${String(details?.skippedMissingSource ?? 0)} skipped`,
    );
  }
  for (const diagnostic of report.provenance.diagnostics.supplementation) {
    const details = detailObject(diagnostic.details, 'supplementation');
    lines.push(
      `  supplementation (${diagnostic.indexer}): ${diagnostic.status}, ${String(details?.skippedByCap ?? 0)} capped, ${String(details?.sourceMissing ?? 0)} source-missing`,
    );
  }
  for (const issue of [...report.errors, ...report.warnings].slice(0, 20)) {
    lines.push(`${issue.severity === 'error' ? 'ERROR' : 'WARN'} ${issue.code}: ${issue.message}`);
    if (issue.guidance) lines.push(`  ${issue.guidance}`);
  }
  const issueCount = report.errors.length + report.warnings.length;
  if (issueCount > 20) lines.push(`... ${issueCount - 20} more issue(s)`);
  return lines.join('\n');
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}