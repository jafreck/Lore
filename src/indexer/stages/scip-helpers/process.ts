/**
 * @module indexer/stages/scip-helpers/process
 *
 * SCIP binary invocation, subprocess management, and index file handling.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_SCIP_INDEXER_REGISTRY,
  SCIP_SUPPORTED_LANGUAGES,
  resolveScipIndexerRegistry,
} from '../../../scip/registry.js';
import {
  DEFAULT_SCIP_C_FAMILY_TIMEOUT_MS,
  type EffectiveScipSettings,
} from '../../../scip/config.js';
import { resolveApprovedCommandCwd } from '../../../execution-policy.js';
import { getLogger } from '../../../logger.js';
import { getSpecsForLanguage, installScipIndexer, type ScipInstallSpec } from '../../../scip/installer.js';
import {
  ensureCompilationDatabase,
  type CompdbCandidateDiagnostic,
  type LoadedCompilationDatabase,
  type ResponseFileLimits,
} from '../../../scip/compdb.js';
import { detectLanguageForPath } from '../../../discovery/walker.js';

// ─── IO interface ───────────────────────────────────────────────────────────

/** Injectable I/O seam for testing `loadScipIndexes`. */
export interface ScipCompilationDatabaseResult {
  path: string | null;
  buildSystem?: string;
  preExisting?: boolean;
  database?: LoadedCompilationDatabase | null;
  candidateDiagnostics?: CompdbCandidateDiagnostic[];
  generationAttempted?: boolean;
  failure?: string;
}

export interface ScipIndexLoadDiagnostics {
  detectedLanguages?: string[];
  indexers?: ScipIndexerLoadDiagnostic[];
  cCpp?: {
    compilationDatabase: ScipCompilationDatabaseResult;
    indexerCommand: string;
  };
}

export interface ScipIndexerLoadDiagnostic {
  source: 'precomputed' | 'command';
  indexer: string;
  languages: string[];
  status: 'succeeded' | 'failed' | 'unavailable' | 'skipped';
  attempted: boolean;
  startedAt?: number;
  completedAt?: number;
  outputPath?: string;
  outputBytes?: number;
  outputSha256?: string;
  arguments?: string[];
  /** Position of this indexer's bytes in the returned buffer array. */
  bufferIndex?: number;
  message?: string;
}

export interface ScipProcessIO {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  unlinkSync(path: string): void;
  execFile(cmd: string, args: string[], opts: { cwd: string; timeout: number; signal?: AbortSignal }): Promise<void>;
  installScipIndexer(spec: ScipInstallSpec): Promise<{ installed: boolean; path?: string | null; error?: string }>;
  ensureCompilationDatabase(
    rootDir: string,
    timeoutMs: number,
    allowBuildExecution: boolean,
    signal?: AbortSignal,
    approvedExternalRoots?: readonly string[],
    responseFileLimits?: Partial<ResponseFileLimits>,
  ): Promise<ScipCompilationDatabaseResult>;
}

export function createDefaultScipProcessIO(): ScipProcessIO {
  const execFileAsync = promisify(execFile);
  return {
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p),
    unlinkSync: (p) => { try { fs.unlinkSync(p); } catch { /* best effort */ } },
    execFile: async (cmd, args, opts) => { await execFileAsync(cmd, args, opts); },
    installScipIndexer: (spec) => installScipIndexer(spec),
    ensureCompilationDatabase: (
      rootDir,
      timeoutMs,
      allowBuildExecution,
      signal,
      approvedExternalRoots,
      responseFileLimits,
    ) => ensureCompilationDatabase(rootDir, timeoutMs, undefined, {
      allowBuildExecution,
      ...(signal && { signal }),
      ...(approvedExternalRoots && { approvedExternalRoots }),
      ...(responseFileLimits && { responseFileLimits }),
    }),
  };
}

// ─── tsconfig generation ────────────────────────────────────────────────────

/** Fields that only affect build output, not type-checking or SCIP indexing. */
const TSCONFIG_BUILD_ONLY_FIELDS = [
  'outDir', 'rootDir', 'declaration', 'declarationMap', 'declarationDir',
  'sourceMap', 'inlineSourceMap', 'inlineSources', 'composite',
  'tsBuildInfoFile', 'emitDeclarationOnly',
] as const;

/**
 * Generate a temporary tsconfig that includes **all** `.ts`/`.tsx` files
 * in the project, so `scip-typescript` indexes tests and other files
 * excluded by the project's production tsconfig.
 *
 * The file is written to `os.tmpdir()` so the indexed repo is never mutated.
 * Include/exclude globs use absolute paths rooted at `rootDir` so
 * `scip-typescript` resolves source files correctly even though the
 * tsconfig lives elsewhere.
 *
 * Strips build-only compiler options (`outDir`, `rootDir`, `declaration`,
 * etc.) that would conflict with the broad `include` and are irrelevant
 * for SCIP analysis.  Preserves all type-checking options (`strict`,
 * `paths`, `baseUrl`, etc.) so SCIP still resolves types correctly.
 *
 * Returns the path to the temp file, or `null` if no tsconfig exists.
 */
export function createLoreScipTsconfig(rootDir: string): string | null {
  const log = getLogger();
  const tsconfigPath = join(rootDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    const compilerOptions = { ...(raw.compilerOptions ?? {}) };

    // Strip build-only fields
    for (const field of TSCONFIG_BUILD_ONLY_FIELDS) {
      delete compilerOptions[field];
    }

    // Use absolute paths so the tsconfig works from tmpdir
    const absRoot = resolve(rootDir);
    const loreTsconfig = {
      compilerOptions,
      include: [join(absRoot, '**/*.ts'), join(absRoot, '**/*.tsx')],
      exclude: (raw.exclude ?? ['node_modules']).map((e: string) => join(absRoot, e)),
    };

    const outPath = join(tmpdir(), `lore-scip-${crypto.randomUUID()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(loreTsconfig, null, 2));
    log.debug('scip', `generated broad tsconfig for SCIP: ${outPath}`);
    return outPath;
  } catch {
    return null;
  }
}

// ─── Project language detection ─────────────────────────────────────────────

/**
 * Quick scan of the project root to detect which SCIP-supported languages
 * are present.  Checks for telltale file extensions and build files.
 * Only scans top-level + one directory deep to stay fast.
 */
export function detectProjectLanguages(
  rootDir: string,
  supportedLanguages: ReadonlySet<string> = SCIP_SUPPORTED_LANGUAGES,
): Set<string> {
  const found = new Set<string>();
  const langIndicators: Record<string, string[]> = {
    typescript: ['tsconfig.json', 'package.json'],
    python: ['setup.py', 'pyproject.toml', 'requirements.txt'],
    java:   ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    rust:   ['Cargo.toml'],
    c:      ['Makefile', 'CMakeLists.txt', 'meson.build', 'configure', 'configure.ac'],
    cpp:    ['CMakeLists.txt', 'meson.build'],
    csharp: ['.csproj', '.sln'],
    ruby:   ['Gemfile'],
    go:     ['go.mod'],
    php:    ['composer.json'],
    dart:   ['pubspec.yaml'],
  };

  // Check for language indicator files at the root
  for (const [lang, indicators] of Object.entries(langIndicators)) {
    if (!supportedLanguages.has(lang)) continue;
    for (const indicator of indicators) {
      if (existsSync(join(rootDir, indicator))) {
        found.add(lang);
        break;
      }
    }
  }

  // Quick extension scan: read first-level directory entries
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const lang = detectLanguageForPath(entry.name);
        if (lang && supportedLanguages.has(lang)) found.add(lang);
      } else if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        // One level deep
        try {
          const subEntries = fs.readdirSync(join(rootDir, entry.name), { withFileTypes: true });
          for (const sub of subEntries.slice(0, 50)) { // Limit to avoid scanning huge dirs
            if (sub.isFile()) {
              const lang = detectLanguageForPath(sub.name);
              if (lang && supportedLanguages.has(lang)) found.add(lang);
            }
          }
        } catch { /* ignore permission errors */ }
      }
    }
  } catch { /* ignore */ }

  return found;
}

// ─── SCIP index loading ─────────────────────────────────────────────────────

/**
 * Load SCIP index buffers by running indexers or reading pre-computed files.
 */
export async function loadScipIndexes(
  settings: EffectiveScipSettings,
  rootDir: string,
  staleLanguages: Set<string> | null = null,
  io: ScipProcessIO = createDefaultScipProcessIO(),
  diagnostics?: ScipIndexLoadDiagnostics,
  signal?: AbortSignal,
  responseFileLimits?: Partial<ResponseFileLimits>,
): Promise<Uint8Array[]> {
  signal?.throwIfAborted();
  const indexerDiagnostics = diagnostics
    ? (diagnostics.indexers ??= [])
    : undefined;
  // Try pre-computed index directory first
  if (settings.indexDir) {
    const precomputed: Uint8Array[] = [];
    // When staleLanguages is set, prefer per-language index files so
    // we only load the languages that actually need re-processing.
    if (staleLanguages) {
      for (const lang of staleLanguages) {
        const candidate = join(rootDir, settings.indexDir, `${lang}.scip`);
        if (io.existsSync(candidate)) {
          const data = io.readFileSync(candidate);
          const bufferIndex = precomputed.push(data) - 1;
          indexerDiagnostics?.push({
            source: 'precomputed',
            indexer: basename(candidate),
            languages: [lang],
            status: 'succeeded',
            attempted: false,
            outputPath: candidate,
            outputBytes: data.byteLength,
            outputSha256: crypto.createHash('sha256').update(data).digest('hex'),
            bufferIndex,
          });
        }
      }
    }
    if (precomputed.length === 0) {
      const precomputedLanguages = new Set([
        ...SCIP_SUPPORTED_LANGUAGES,
        ...Object.keys(settings.indexers),
      ]);
      const candidates = [
        join(rootDir, settings.indexDir, 'index.scip'),
        ...[...precomputedLanguages].sort().map(
          lang => join(rootDir, settings.indexDir!, `${lang}.scip`),
        ),
      ];
      for (const candidate of candidates) {
        if (io.existsSync(candidate)) {
          const data = io.readFileSync(candidate);
          const fileName = basename(candidate);
          const language = fileName === 'index.scip' ? [] : [fileName.slice(0, -'.scip'.length)];
          const bufferIndex = precomputed.push(data) - 1;
          indexerDiagnostics?.push({
            source: 'precomputed',
            indexer: fileName,
            languages: language,
            status: 'succeeded',
            attempted: false,
            outputPath: candidate,
            outputBytes: data.byteLength,
            outputSha256: crypto.createHash('sha256').update(data).digest('hex'),
            bufferIndex,
          });
        }
      }
    }
    if (precomputed.length > 0) return precomputed;
  }

  // Try running an indexer. Detection is based on the effective registry so
  // an authorized custom language is not silently discarded by static defaults.
  let resolvedIndexers = resolveScipIndexerRegistry(settings.indexers);
  const log = getLogger();
  const configuredLanguages = new Set(Object.keys(settings.indexers));

  // Determine which SCIP-supported languages actually exist in the project
  // so we don't waste time running irrelevant indexers (e.g., scip-go on a C project).
  const projectLanguages = staleLanguages
    ?? detectProjectLanguages(resolve(rootDir), configuredLanguages);
  if (diagnostics) diagnostics.detectedLanguages = [...projectLanguages].sort();

  if (settings.allowIndexerExecution !== true) {
    for (const language of [...projectLanguages].sort()) {
      const indexer = resolvedIndexers[language];
      indexerDiagnostics?.push({
        source: 'command',
        indexer: indexer?.command ?? '(not configured)',
        languages: [language],
        status: 'skipped',
        attempted: false,
        message: 'SCIP indexer execution is disabled by host policy',
      });
    }
    return [];
  }

  // Auto-install missing indexers only for languages present in the project.
  const missingLanguages = [...projectLanguages].filter(
    (lang) => {
      const indexer = resolvedIndexers[lang];
      const defaultIndexer = DEFAULT_SCIP_INDEXER_REGISTRY[lang];
      return settings.allowAutoInstall === true
        && indexer !== undefined
        && !indexer.available
        && indexer.command === defaultIndexer?.command;
    },
  );
  if (missingLanguages.length > 0) {
    const attempted = new Set<string>();
    for (const lang of missingLanguages) {
      signal?.throwIfAborted();
      for (const spec of getSpecsForLanguage(lang)) {
        if (attempted.has(spec.command)) continue;
        attempted.add(spec.command);
        log.indexing(`scip-indexer: auto-installing ${spec.command} for ${lang}...`);
        const result = await io.installScipIndexer(spec);
        if (result.installed) {
          log.indexing(`scip-indexer: installed ${spec.command} at ${result.path}`);
        } else {
          log.indexing(`scip-indexer: could not install ${spec.command}: ${result.error ?? 'unknown'}`);
        }
      }
    }
    // Re-resolve after installation
    resolvedIndexers = resolveScipIndexerRegistry(settings.indexers);
  }

  for (const language of [...projectLanguages].sort()) {
    const indexer = resolvedIndexers[language];
    if (!indexer) {
      indexerDiagnostics?.push({
        source: 'command',
        indexer: '(not configured)',
        languages: [language],
        status: 'unavailable',
        attempted: false,
        message: 'no SCIP indexer is configured for this language',
      });
    } else if (!indexer.available) {
      indexerDiagnostics?.push({
        source: 'command',
        indexer: indexer.command,
        languages: [language],
        status: 'unavailable',
        attempted: false,
        message: 'indexer executable is unavailable after installation attempts',
      });
    }
  }

  // Run all available indexers and merge results — don't stop at the first success.
  // Group only identical invocations. Sharing an executable is insufficient:
  // arguments and cwd can select different projects or output semantics.
  const commandsRun = new Set<string>();
  const indexBuffers: Uint8Array[] = [];

  for (const [lang, indexer] of Object.entries(resolvedIndexers)) {
    signal?.throwIfAborted();
    if (!indexer.available) continue;
    // Skip languages not present in the project
    if (!projectLanguages.has(lang)) continue;
    const invocationKey = indexerInvocationKey(indexer);
    if (commandsRun.has(invocationKey)) continue;
    commandsRun.add(invocationKey);
    const commandLanguages = Object.entries(resolvedIndexers)
      .filter(([candidateLanguage, candidate]) =>
        projectLanguages.has(candidateLanguage)
        && indexerInvocationKey(candidate) === invocationKey)
      .map(([candidateLanguage]) => candidateLanguage)
      .sort();
    const startedAt = Math.floor(Date.now() / 1000);
    let outputDirectory: string | null = null;
    let indexerAttempted = false;
    try {
      if (!indexer.args.some(argument => argument.includes('{output}'))) {
        throw new Error(
          `SCIP indexer ${indexer.command} must declare a {output} argument; checkout output fallbacks are disabled`,
        );
      }
      outputDirectory = createPrivateScipOutputDirectory();
      const outputPath = join(outputDirectory, `${crypto.randomUUID()}.scip`);
      let args = indexer.args.map(a => a.replace(/\{output\}/g, outputPath));
      const cwd = resolveApprovedCommandCwd(
        rootDir,
        indexer.cwd,
        settings.allowedCwdRoots,
      );
      const cFamilyInvocation = commandLanguages.some(
        language => language === 'c' || language === 'cpp',
      );
      const indexerTimeout = cFamilyInvocation && settings.timeoutMsExplicit === false
        ? DEFAULT_SCIP_C_FAMILY_TIMEOUT_MS
        : settings.timeoutMs;

      // For C/C++: ensure a compile_commands.json exists and pass it to scip-clang
      if (cFamilyInvocation && args.some(a => a.includes('{compdb}'))) {
        const compdb = await io.ensureCompilationDatabase(
          rootDir,
          indexerTimeout,
          settings.allowBuildExecution === true,
          signal,
          settings.allowedCwdRoots,
          responseFileLimits,
        );
        if (diagnostics) {
          diagnostics.cCpp = {
            compilationDatabase: compdb,
            indexerCommand: indexer.command,
          };
        }
        if (!compdb.path) {
          const compdbReason = compdb.failure
            ?? compdb.database?.validation.reason
            ?? 'no usable compilation database was available';
          log.indexing(`scip-indexer: ${compdbReason} for ${lang}, skipping`);
          indexerDiagnostics?.push({
            source: 'command',
            indexer: indexer.command,
            languages: commandLanguages,
            status: 'failed',
            attempted: false,
            startedAt,
            completedAt: Math.floor(Date.now() / 1000),
            message: compdbReason,
            arguments: [...indexer.args],
          });
          continue;
        }
        args = args.map(a => a.replace(/\{compdb\}/g, compdb.path!));
      }

      // For TypeScript: generate a broad tsconfig so scip-typescript
      // indexes ALL .ts files (including tests), not just those in the
      // project's tsconfig "include" (which typically excludes tests).
      let tempTsconfigPath: string | null = null;
      if (commandLanguages.includes('typescript')) {
        tempTsconfigPath = createLoreScipTsconfig(rootDir);
        if (tempTsconfigPath) {
          args.push(tempTsconfigPath);
        }
      }

      const executablePath = indexer.resolvedPath ?? indexer.command;
      try {
        indexerAttempted = true;
        await io.execFile(executablePath, args, {
          cwd,
          timeout: indexerTimeout,
          signal,
        });
      } finally {
        if (tempTsconfigPath) {
          io.unlinkSync(tempTsconfigPath);
        }
      }

      if (fs.existsSync(outputPath)) {
        const data = readGeneratedScipOutput(outputPath);
        const bufferIndex = indexBuffers.push(data) - 1;
        indexerDiagnostics?.push({
          source: 'command',
          indexer: indexer.command,
          languages: commandLanguages,
          status: 'succeeded',
          attempted: true,
          startedAt,
          completedAt: Math.floor(Date.now() / 1000),
          outputPath,
          outputBytes: data.byteLength,
          outputSha256: crypto.createHash('sha256').update(data).digest('hex'),
          arguments: [...indexer.args],
          bufferIndex,
        });
      } else {
        indexerDiagnostics?.push({
          source: 'command',
          indexer: indexer.command,
          languages: commandLanguages,
          status: 'failed',
          attempted: true,
          startedAt,
          completedAt: Math.floor(Date.now() / 1000),
          message: 'indexer exited without producing a SCIP index',
          arguments: [...indexer.args],
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.indexing(`scip-indexer: indexer failed for ${lang}: ${msg}`);
      indexerDiagnostics?.push({
        source: 'command',
        indexer: indexer.command,
        languages: commandLanguages,
        status: 'failed',
        attempted: indexerAttempted,
        startedAt,
        completedAt: Math.floor(Date.now() / 1000),
        message: msg,
        arguments: [...indexer.args],
      });
      continue;
    } finally {
      if (outputDirectory) {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
      }
    }
  }

  return indexBuffers;
}

function createPrivateScipOutputDirectory(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lore-scip-output-'));
  try {
    fs.chmodSync(directory, 0o700);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      throw new Error('Could not establish a private SCIP output directory');
    }
    return directory;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function readGeneratedScipOutput(outputPath: string): Uint8Array {
  const before = fs.lstatSync(outputPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('Generated SCIP output is not a private regular file');
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number'
    ? fs.constants.O_NOFOLLOW
    : 0;
  const fd = fs.openSync(outputPath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.nlink !== 1) {
      throw new Error('Generated SCIP output changed during secure open');
    }
    return new Uint8Array(fs.readFileSync(fd));
  } finally {
    fs.closeSync(fd);
  }
}

function indexerInvocationKey(indexer: {
  command: string;
  args: readonly string[];
  cwd?: string;
}): string {
  return JSON.stringify([indexer.command, indexer.args, indexer.cwd ?? '']);
}
