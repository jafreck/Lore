import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadValidationPolicyFromLoreConfig,
  resolveIndexValidationPolicy,
} from '../../src/validation/config.js';
import { validationPolicyFromArgs } from '../../src/cli/args.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(config: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-validation-config-'));
  dirs.push(root);
  fs.writeFileSync(path.join(root, '.lore.config'), JSON.stringify(config));
  return root;
}

describe('index validation configuration', () => {
  it('preserves explicit semantic requirements over repository requests and normalizes paths', () => {
    const policy = resolveIndexValidationPolicy({ requiredSymbols: [{ name: 'other' }], requiredCalls: [] }, {
      requiredSymbols: [{ name: 'entry', path: './src/main.c' }],
      requiredCalls: [{ caller: { name: 'entry' }, callee: { name: 'target' }, resolutionMethod: 'scip_definition' }],
    });
    expect(policy.requiredSymbols).toEqual([{ name: 'entry', path: 'src/main.c' }]);
    expect(policy.requiredCalls).toHaveLength(1);
    expect(() => resolveIndexValidationPolicy({}, { requiredSymbols: [{ name: 'entry', path: '../outside.c' }] }))
      .toThrow('root-relative');
    expect(() => resolveIndexValidationPolicy({}, { requiredCalls: [{ caller: { name: 'entry' }, callee: { name: 'target' }, resolutionMethod: 'unresolved' }] }))
      .toThrow('resolved internal call');
  });

  it('loads globs and per-language thresholds from .lore.config', () => {
    const root = tempRoot({
      validation: {
        profile: 'migration-grade',
        includeGlobs: ['src/**'],
        excludeGlobs: ['**/*.generated.ts'],
        requiredGlobs: ['src/core/**'],
        thresholds: { minSymbolCoverage: 0.95 },
        languages: { c: { minSymbolCoverage: 1, minCallRefs: 10 } },
      },
    });
    expect(loadValidationPolicyFromLoreConfig(root)).toEqual(expect.objectContaining({
      profile: 'migration-grade',
      includeGlobs: ['src/**'],
      languages: { c: { minSymbolCoverage: 1, minCallRefs: 10 } },
    }));
  });

  it('applies strict defaults while allowing explicit threshold overrides', () => {
    const policy = resolveIndexValidationPolicy(
      { profile: 'strict', thresholds: { minSymbolCoverage: 0.9 }, languages: { c: { minSymbols: 5 } } },
      { thresholds: { maxSymbolLessFiles: 2 }, languages: { c: { minSymbols: 10 } } },
    );
    expect(policy).toMatchObject({
      profile: 'strict',
      requireStructuralIndex: true,
      requireValidSpans: true,
      requireIndexerSuccess: true,
      requireProvenance: false,
      thresholds: { minSymbolCoverage: 0.9, maxSymbolLessFiles: 2 },
      languages: { c: { minSymbols: 10 } },
    });
  });

  it('rejects invalid rates in repository config', () => {
    const root = tempRoot({ validation: { thresholds: { minSymbolCoverage: 2 } } });
    expect(() => loadValidationPolicyFromLoreConfig(root)).toThrow('Invalid .lore.config validation settings');
  });

  it('parses repeatable globs and thresholds from CLI arguments', () => {
    expect(validationPolicyFromArgs([
      '--validation-profile', 'strict',
      '--include', 'src/**',
      '--exclude', '**/*.gen.ts',
      '--required', 'src/core/**',
      '--min-symbol-coverage', '0.98',
      '--max-invalid-spans', '0',
    ], { includeScope: true })).toEqual({
      profile: 'strict',
      includeGlobs: ['src/**'],
      excludeGlobs: ['**/*.gen.ts'],
      requiredGlobs: ['src/core/**'],
      thresholds: { minSymbolCoverage: 0.98, maxInvalidSpans: 0 },
    });
  });
});