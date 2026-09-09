/** Configuration and profile resolution for index-health validation. */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { RESOLUTION_METHODS, RESOLVED_METHODS, type ResolutionMethod } from '../resolution/resolution-method.js';

export const VALIDATION_PROFILES = ['standard', 'strict', 'migration-grade'] as const;
export type ValidationProfile = (typeof VALIDATION_PROFILES)[number];

export interface RequiredIndexSymbol {
  name: string;
  path?: string;
  kind?: string;
}

export interface RequiredIndexCall {
  caller: RequiredIndexSymbol;
  callee: RequiredIndexSymbol;
  resolutionMethod?: ResolutionMethod;
}

/** Thresholds apply to the selected index as a whole or to one language. */
export interface IndexCoverageThresholds {
  minFiles?: number;
  minSymbols?: number;
  minCallRefs?: number;
  minTypeRefs?: number;
  minImports?: number;
  minSymbolCoverage?: number;
  minCallResolutionRate?: number;
  minTypeResolutionRate?: number;
  minImportResolutionRate?: number;
  maxSymbolLessFiles?: number;
  maxInvalidSpans?: number;
  maxDuplicateSymbols?: number;
  maxUnresolvedInternalRefs?: number;
}

export interface IndexValidationPolicy {
  profile?: ValidationProfile;
  /** Relative-path globs selecting files to validate. Defaults to every indexed file. */
  includeGlobs?: string[];
  /** Relative-path globs removed from the selected set. */
  excludeGlobs?: string[];
  /** Each glob must match, and every matching file must contain a symbol. */
  requiredGlobs?: string[];
  requiredSymbols?: RequiredIndexSymbol[];
  requiredCalls?: RequiredIndexCall[];
  thresholds?: IndexCoverageThresholds;
  /** Threshold overrides keyed by Lore language name. */
  languages?: Record<string, IndexCoverageThresholds>;
  requireStructuralIndex?: boolean;
  requireValidSpans?: boolean;
  requireIndexerSuccess?: boolean;
  requireProvenance?: boolean;
  failOnWarnings?: boolean;
  maxBaselineAgeSeconds?: number;
  maxDirtyFiles?: number;
}

export interface ResolvedIndexValidationPolicy extends IndexValidationPolicy {
  profile: ValidationProfile;
  includeGlobs: string[];
  excludeGlobs: string[];
  requiredGlobs: string[];
  thresholds: IndexCoverageThresholds;
  languages: Record<string, IndexCoverageThresholds>;
  requireStructuralIndex: boolean;
  requireValidSpans: boolean;
  requireIndexerSuccess: boolean;
  requireProvenance: boolean;
  failOnWarnings: boolean;
}

const RateSchema = z.number().min(0).max(1);
const CountSchema = z.number().int().min(0);
const RequiredSymbolSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1).refine(value => !isAbsolute(value) && !value.includes('\\')
    && !/^[A-Za-z]:/u.test(value) && !value.split('/').includes('..'), 'must be a root-relative file path')
    .transform(value => value.replace(/^(\.\/)+/u, '')).optional(),
  kind: z.string().min(1).optional(),
}).strict();
const RequiredCallSchema = z.object({
  caller: RequiredSymbolSchema,
  callee: RequiredSymbolSchema,
  resolutionMethod: z.enum(RESOLUTION_METHODS).refine(value => RESOLVED_METHODS.has(value),
    'must identify a resolved internal call').optional(),
}).strict();
const ThresholdSchema = z.object({
  minFiles: CountSchema.optional(),
  minSymbols: CountSchema.optional(),
  minCallRefs: CountSchema.optional(),
  minTypeRefs: CountSchema.optional(),
  minImports: CountSchema.optional(),
  minSymbolCoverage: RateSchema.optional(),
  minCallResolutionRate: RateSchema.optional(),
  minTypeResolutionRate: RateSchema.optional(),
  minImportResolutionRate: RateSchema.optional(),
  maxSymbolLessFiles: CountSchema.optional(),
  maxInvalidSpans: CountSchema.optional(),
  maxDuplicateSymbols: CountSchema.optional(),
  maxUnresolvedInternalRefs: CountSchema.optional(),
}).strict();

const ValidationSchema = z.object({
  profile: z.enum(VALIDATION_PROFILES).optional(),
  includeGlobs: z.array(z.string().min(1)).optional(),
  excludeGlobs: z.array(z.string().min(1)).optional(),
  requiredGlobs: z.array(z.string().min(1)).optional(),
  requiredSymbols: z.array(RequiredSymbolSchema).optional(),
  requiredCalls: z.array(RequiredCallSchema).optional(),
  thresholds: ThresholdSchema.optional(),
  languages: z.record(z.string(), ThresholdSchema).optional(),
  requireStructuralIndex: z.boolean().optional(),
  requireValidSpans: z.boolean().optional(),
  requireIndexerSuccess: z.boolean().optional(),
  requireProvenance: z.boolean().optional(),
  failOnWarnings: z.boolean().optional(),
  maxBaselineAgeSeconds: CountSchema.optional(),
  maxDirtyFiles: CountSchema.optional(),
}).strict();

/** Load the optional `validation` section from a repository `.lore.config`. */
export function loadValidationPolicyFromLoreConfig(
  rootDir: string,
): IndexValidationPolicy | undefined {
  const configPath = join(rootDir, '.lore.config');
  if (!existsSync(configPath)) return undefined;

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .lore.config: ${message}`);
  }
  if (!isRecord(parsedConfig)) {
    throw new Error('Invalid .lore.config: root must be a JSON object');
  }
  if (!Object.prototype.hasOwnProperty.call(parsedConfig, 'validation')) return undefined;

  const parsed = ValidationSchema.safeParse(parsedConfig.validation);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid .lore.config validation settings: ${issue?.path.join('.') ?? 'validation'} ${issue?.message ?? 'invalid value'}`,
    );
  }
  return parsed.data;
}

/**
 * Resolve profile defaults and merge repository settings with explicit
 * overrides. Arrays supplied by the explicit policy replace configured arrays;
 * threshold maps are merged field-by-field.
 */
export function resolveIndexValidationPolicy(
  configured: IndexValidationPolicy = {},
  explicit: IndexValidationPolicy = {},
): ResolvedIndexValidationPolicy {
  const profile = explicit.profile ?? configured.profile ?? 'standard';
  const strict = profile === 'strict' || profile === 'migration-grade';
  const migrationGrade = profile === 'migration-grade';
  const requiredSymbols = explicit.requiredSymbols ?? configured.requiredSymbols;
  const requiredCalls = explicit.requiredCalls ?? configured.requiredCalls;
  const mergedLanguages: Record<string, IndexCoverageThresholds> = {};
  for (const language of new Set([
    ...Object.keys(configured.languages ?? {}),
    ...Object.keys(explicit.languages ?? {}),
  ])) {
    mergedLanguages[language] = {
      ...(configured.languages?.[language] ?? {}),
      ...(explicit.languages?.[language] ?? {}),
    };
  }

  return {
    profile,
    includeGlobs: explicit.includeGlobs ?? configured.includeGlobs ?? ['**/*'],
    excludeGlobs: explicit.excludeGlobs ?? configured.excludeGlobs ?? [],
    requiredGlobs: explicit.requiredGlobs ?? configured.requiredGlobs ?? [],
    ...(requiredSymbols !== undefined && { requiredSymbols: z.array(RequiredSymbolSchema).parse(requiredSymbols) }),
    ...(requiredCalls !== undefined && { requiredCalls: z.array(RequiredCallSchema).parse(requiredCalls) }),
    thresholds: {
      ...(strict ? { maxSymbolLessFiles: 0 } : {}),
      ...(configured.thresholds ?? {}),
      ...(explicit.thresholds ?? {}),
    },
    languages: mergedLanguages,
    requireStructuralIndex:
      explicit.requireStructuralIndex
      ?? configured.requireStructuralIndex
      ?? strict,
    requireValidSpans:
      explicit.requireValidSpans
      ?? configured.requireValidSpans
      ?? strict,
    requireIndexerSuccess:
      explicit.requireIndexerSuccess
      ?? configured.requireIndexerSuccess
      ?? strict,
    requireProvenance:
      explicit.requireProvenance
      ?? configured.requireProvenance
      ?? migrationGrade,
    failOnWarnings:
      explicit.failOnWarnings
      ?? configured.failOnWarnings
      ?? false,
    ...(explicit.maxBaselineAgeSeconds !== undefined
      ? { maxBaselineAgeSeconds: explicit.maxBaselineAgeSeconds }
      : configured.maxBaselineAgeSeconds !== undefined
        ? { maxBaselineAgeSeconds: configured.maxBaselineAgeSeconds }
        : {}),
    ...(explicit.maxDirtyFiles !== undefined
      ? { maxDirtyFiles: explicit.maxDirtyFiles }
      : configured.maxDirtyFiles !== undefined
        ? { maxDirtyFiles: configured.maxDirtyFiles }
        : {}),
  };
}

export function parseValidationProfile(value: string | undefined): ValidationProfile | undefined {
  if (value === undefined) return undefined;
  if ((VALIDATION_PROFILES as readonly string[]).includes(value)) {
    return value as ValidationProfile;
  }
  throw new Error(
    `unknown validation profile "${value}"; expected ${VALIDATION_PROFILES.join(', ')}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}