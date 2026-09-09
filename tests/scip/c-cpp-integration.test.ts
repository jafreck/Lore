/**
 * Opt-in scip-clang integration matrix for larger local repositories.
 *
 * Enable with `LORE_C_CPP_INTEGRATION=1`. Repositories are supplied through
 * per-project environment variables or discovered below cache roots; this file
 * deliberately contains no developer-specific absolute paths.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from '../../src/db/schema.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';
import { resolveEffectiveLspSettings } from '../../src/lsp/config.js';
import { discoverCompilationDatabase } from '../../src/scip/compdb.js';
import type { ScipIndexerCommand } from '../../src/scip/registry.js';
import { IndexValidationError, validateIndex } from '../../src/validation/index-health.js';

interface ExternalRepoSpec {
  name: string;
  label: string;
  environmentVariable: string;
  aliases: string[];
  markerSets: string[][];
}

interface ReadyRepo {
  ready: true;
  rootDir: string;
  compdbPath: string;
  compilationFiles: string[];
  scipClangPath: string;
}

interface SkippedRepo {
  ready: false;
  reason: string;
}

type RepoReadiness = ReadyRepo | SkippedRepo;

const ENABLED = process.env['LORE_C_CPP_INTEGRATION'] === '1';
const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const SOURCE_GLOBS = ['**/*.c', '**/*.h', '**/*.cc', '**/*.cpp', '**/*.cxx', '**/*.hpp', '**/*.hh', '**/*.hxx'];
const TEST_TIMEOUT_MS = positiveInteger(process.env['LORE_C_CPP_INTEGRATION_TIMEOUT_MS'], 20 * 60_000);

describe.runIf(ENABLED && findScipClang() !== null)('native compiler diagnostics', () => {
  it('rejects an exit-zero scip-clang result with a fatal include error', async () => {
    const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-native-diagnostics-')));
    try {
      fs.writeFileSync(path.join(rootDir, 'main.c'), '#include "lore_missing_header_for_validation.h"\nint main(void) { return 0; }\n');
      fs.writeFileSync(path.join(rootDir, 'compile_commands.json'), JSON.stringify([{
        directory: rootDir, file: path.join(rootDir, 'main.c'),
        arguments: ['clang', '-c', path.join(rootDir, 'main.c')],
      }]));
      const builder = new IndexBuilder(path.join(rootDir, 'lore.db'), { rootDir, branch: 'main' }, undefined, {
        scip: true, scipScope: { languages: ['c'] }, lsp: false, embeddings: false,
        execution: { allowSubprocessExecution: true }, validation: 'migration-grade',
      });
      await expect(builder.build()).rejects.toBeInstanceOf(IndexValidationError);
      const report = builder.lastValidationReport!;
      expect(report.errors).toContainEqual(expect.objectContaining({ code: 'SCIP_COMPILER_ERRORS' }));
      expect(report.provenance.indexers).toContainEqual(expect.objectContaining({
        provider: 'scip', indexer: 'scip-clang', status: 'failed',
        details: expect.objectContaining({ compilerDiagnostics: expect.objectContaining({
          requested: true, complete: true,
          summary: expect.objectContaining({ errors: 1, fatalErrors: 1 }),
        }) }),
      }));
      expect(report.provenance.indexers.filter(row => row.provider === 'lsp').every(row => !row.attempted)).toBe(true);
      const db = openDb(path.join(rootDir, 'lore.db'));
      expect(db.prepare('SELECT COUNT(*) AS count FROM baseline_generations').get()).toEqual({ count: 0 });
      db.close();
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }, 60_000);
});

const REPOSITORIES: ExternalRepoSpec[] = [
  {
    name: 'zstd',
    label: 'zstd',
    environmentVariable: 'LORE_C_CPP_ZSTD_REPO',
    aliases: ['zstd', 'zstd-src'],
    markerSets: [['lib/zstd.h']],
  },
  {
    name: 'cjson',
    label: 'cJSON',
    environmentVariable: 'LORE_C_CPP_CJSON_REPO',
    aliases: ['cJSON', 'cjson'],
    markerSets: [['cJSON.c', 'cJSON.h']],
  },
  {
    name: 'postgresql',
    label: 'PostgreSQL',
    environmentVariable: 'LORE_C_CPP_POSTGRES_REPO',
    aliases: ['postgresql', 'postgres'],
    markerSets: [['src/backend', 'src/include', 'configure.ac']],
  },
  {
    name: 'nlohmann-json',
    label: 'nlohmann/json',
    environmentVariable: 'LORE_C_CPP_NLOHMANN_JSON_REPO',
    aliases: ['nlohmann-json', 'nlohmann_json', 'json'],
    markerSets: [
      ['include/nlohmann/json.hpp'],
      ['single_include/nlohmann/json.hpp'],
    ],
  },
];

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function isRepository(spec: ExternalRepoSpec, candidate: string): boolean {
  return spec.markerSets.some((markers) => markers.every((marker) => (
    fs.existsSync(path.join(candidate, marker))
  )));
}

function cacheRoots(): string[] {
  const explicit = [
    process.env['LORE_C_CPP_REPO_CACHE'],
    process.env['LORE_REPO_CACHE'],
  ].flatMap((value) => value?.split(path.delimiter) ?? []);
  const cacheHome = process.env['XDG_CACHE_HOME']
    ? path.resolve(expandHome(process.env['XDG_CACHE_HOME']))
    : path.join(os.homedir(), '.cache');
  return [...new Set([
    ...explicit.filter(Boolean).map((value) => path.resolve(expandHome(value))),
    path.join(cacheHome, 'lore', 'c-cpp-repos'),
    path.join(cacheHome, 'lore', 'integration-repos'),
    path.join(WORKSPACE_ROOT, '.integration-repos'),
    WORKSPACE_ROOT,
  ])];
}

function findRepository(spec: ExternalRepoSpec): string | null {
  const explicit = process.env[spec.environmentVariable];
  if (explicit) {
    const candidate = path.resolve(expandHome(explicit));
    return isRepository(spec, candidate) ? candidate : null;
  }

  for (const cacheRoot of cacheRoots()) {
    const candidates = [cacheRoot];
    try {
      for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(cacheRoot, entry.name));
      }
    } catch {
      // An absent or unreadable optional cache root is not an integration error.
    }
    candidates.push(...spec.aliases.map((alias) => path.join(cacheRoot, alias)));
    for (const candidate of candidates) {
      if (isRepository(spec, candidate)) return fs.realpathSync(candidate);
    }
  }
  return null;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findScipClang(): string | null {
  const managed = path.join(os.homedir(), '.lore', 'bin', 'scip-clang');
  if (isExecutable(managed)) return managed;
  for (const directory of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, 'scip-clang');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function readiness(spec: ExternalRepoSpec): RepoReadiness {
  if (!ENABLED) {
    return { ready: false, reason: 'set LORE_C_CPP_INTEGRATION=1 to enable local external-repository tests' };
  }
  const scipClangPath = findScipClang();
  if (!scipClangPath) {
    return { ready: false, reason: 'scip-clang is unavailable on PATH and in ~/.lore/bin' };
  }
  const rootDir = findRepository(spec);
  if (!rootDir) {
    return {
      ready: false,
      reason: `repository unavailable; set ${spec.environmentVariable} or LORE_C_CPP_REPO_CACHE`,
    };
  }
  const discovery = discoverCompilationDatabase(rootDir);
  if (!discovery.database) {
    const statuses = discovery.candidates.map((candidate) => candidate.validation.status).join(', ') || 'none found';
    return { ready: false, reason: `no usable compile_commands.json (${statuses})` };
  }
  if (discovery.database.validation.status !== 'valid') {
    return {
      ready: false,
      reason: `compile_commands.json is ${discovery.database.validation.status}; migration-grade integration requires a valid database`,
    };
  }
  const compilationFiles = [...new Set(discovery.database.entries.flatMap((entry) => {
    const relative = path.relative(rootDir, entry.filePath);
    if (
      !fs.existsSync(entry.filePath)
      || path.isAbsolute(relative)
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
    ) {
      return [];
    }
    return [relative.split(path.sep).join('/')];
  }))].sort();
  if (compilationFiles.length === 0) {
    return { ready: false, reason: 'compilation database has no existing translation units inside the repository' };
  }
  return {
    ready: true,
    rootDir,
    compdbPath: discovery.database.path,
    compilationFiles,
    scipClangPath,
  };
}

function scipClangCommand(executable: string): ScipIndexerCommand {
  return {
    command: executable,
    args: [
      '--compdb-path={compdb}',
      '--index-output-path={output}',
      '--no-progress-report',
      '--log-level=warning',
    ],
  };
}

describe('scip-clang external repository integration matrix', () => {
  for (const spec of REPOSITORIES) {
    const state = readiness(spec);
    const testName = state.ready
      ? `${spec.label}: builds and passes migration-grade structural validation`
      : `${spec.label}: SKIP — ${state.reason}`;

    it.skipIf(!state.ready)(testName, async () => {
      if (!state.ready) return;
      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `lore-${spec.name}-integration-`));
      const dbPath = path.join(temporaryDirectory, 'lore.db');
      resetLogger();
      initLogger({ level: LogLevel.SILENT });

      try {
        const clang = scipClangCommand(state.scipClangPath);
        const builder = new IndexBuilder(dbPath, {
          rootDir: state.rootDir,
          includeGlobs: SOURCE_GLOBS,
        }, undefined, {
          scip: {
            enabled: true,
            timeoutMs: TEST_TIMEOUT_MS,
            allowBuildExecution: false,
            indexers: { c: clang, cpp: clang },
            indexDir: null,
          },
          execution: {
            allowSubprocessExecution: true,
            allowCustomIndexerCommands: true,
          },
          lsp: resolveEffectiveLspSettings({}, { enabled: false }),
          maxWorkers: 0,
          validation: false,
        });
        await builder.build();

        const db = openDb(dbPath);
        try {
          const preflight = validateIndex(db, {
            rootDir: state.rootDir,
            includeGlobs: SOURCE_GLOBS,
          });
          const coverage = preflight.coverage.overall;
          expect(coverage.files).toBeGreaterThan(0);
          expect(coverage.symbols).toBeGreaterThan(0);
          expect(coverage.calls.total).toBeGreaterThan(0);
          expect(coverage.types.total).toBeGreaterThan(0);
          expect(coverage.symbolCoverage).not.toBeNull();
          expect(coverage.symbolCoverage!).toBeGreaterThan(0);
          expect(preflight.spans.invalid).toBe(0);
          expect(preflight.duplicates.paths.excessRows).toBe(0);

          // Migration gates apply to the build's authoritative TU scope,
          // rather than uncompiled examples and alternate configurations that
          // happen to be present elsewhere in the checkout.
          const compilationScope = validateIndex(db, {
            rootDir: state.rootDir,
            includeGlobs: state.compilationFiles,
          });
          const compiledCoverage = compilationScope.coverage.overall;
          expect(compiledCoverage.files).toBeGreaterThan(0);
          expect(compiledCoverage.symbolCoverage).not.toBeNull();
          expect(compiledCoverage.symbolCoverage!).toBeGreaterThanOrEqual(0.8);

          const migration = validateIndex(db, {
            rootDir: state.rootDir,
            policy: {
              profile: 'migration-grade',
              includeGlobs: state.compilationFiles,
              thresholds: {
                minFiles: 1,
                minSymbols: 1,
                minCallRefs: 1,
                minTypeRefs: 1,
                minSymbolCoverage: 0.8,
                maxSymbolLessFiles: Math.floor(compiledCoverage.files * 0.2),
                maxInvalidSpans: 0,
              },
            },
          });

          expect(migration.ok, migration.errors.map((error) => error.message).join('\n')).toBe(true);
          expect(migration.profile).toBe('migration-grade');
          expect(migration.provenance.indexers).toContainEqual(expect.objectContaining({
            provider: 'scip',
            indexer: 'scip-clang',
            status: 'succeeded',
          }));
          expect(migration.provenance.compilationDatabases).toContainEqual(expect.objectContaining({
            provider: 'compdb',
            status: 'succeeded',
          }));
          expect(migration.provenance.compilationDatabases.some((row) => (
            (row.details as { path?: string } | null)?.path === state.compdbPath
          ))).toBe(true);
        } finally {
          db.close();
        }
      } finally {
        resetLogger();
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }, TEST_TIMEOUT_MS);
  }
});