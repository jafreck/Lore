/**
 * @module indexer/stages/scip-helpers/process
 *
 * SCIP binary invocation, subprocess management, and index file handling.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SCIP_SUPPORTED_LANGUAGES, resolveScipIndexerRegistry } from '../../../scip/registry.js';
import type { EffectiveScipSettings } from '../../../scip/config.js';
import { getLogger } from '../../../logger.js';
import { getSpecsForLanguage, installScipIndexer, type ScipInstallSpec } from '../../../scip/installer.js';
import { ensureCompilationDatabase } from '../../../scip/compdb.js';
import { EXT_TO_LANG } from '../../../discovery/walker.js';

// ─── IO interface ───────────────────────────────────────────────────────────

/** Injectable I/O seam for testing `loadScipIndexes`. */
export interface ScipProcessIO {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  unlinkSync(path: string): void;
  execFile(cmd: string, args: string[], opts: { cwd: string; timeout: number }): Promise<void>;
  installScipIndexer(spec: ScipInstallSpec): Promise<{ installed: boolean; path?: string | null; error?: string }>;
  ensureCompilationDatabase(rootDir: string, timeoutMs: number): Promise<{ path: string | null }>;
}

export function createDefaultScipProcessIO(): ScipProcessIO {
  const execFileAsync = promisify(execFile);
  return {
    existsSync: (p) => existsSync(p),
    readFileSync: (p) => readFileSync(p),
    unlinkSync: (p) => { try { fs.unlinkSync(p); } catch { /* best effort */ } },
    execFile: async (cmd, args, opts) => { await execFileAsync(cmd, args, opts); },
    installScipIndexer: (spec) => installScipIndexer(spec),
    ensureCompilationDatabase: (rootDir, timeoutMs) => ensureCompilationDatabase(rootDir, timeoutMs),
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
export function detectProjectLanguages(rootDir: string): Set<string> {
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
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        const lang = EXT_TO_LANG[ext];
        if (lang && SCIP_SUPPORTED_LANGUAGES.has(lang)) found.add(lang);
      } else if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        // One level deep
        try {
          const subEntries = fs.readdirSync(join(rootDir, entry.name), { withFileTypes: true });
          for (const sub of subEntries.slice(0, 50)) { // Limit to avoid scanning huge dirs
            if (sub.isFile()) {
              const ext = sub.name.slice(sub.name.lastIndexOf('.')).toLowerCase();
              const lang = EXT_TO_LANG[ext];
              if (lang && SCIP_SUPPORTED_LANGUAGES.has(lang)) found.add(lang);
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
): Promise<Uint8Array[]> {
  // Try pre-computed index directory first
  if (settings.indexDir) {
    const precomputed: Uint8Array[] = [];
    // When staleLanguages is set, prefer per-language index files so
    // we only load the languages that actually need re-processing.
    if (staleLanguages) {
      for (const lang of staleLanguages) {
        const candidate = join(rootDir, settings.indexDir, `${lang}.scip`);
        if (io.existsSync(candidate)) {
          precomputed.push(io.readFileSync(candidate));
        }
      }
    }
    if (precomputed.length === 0) {
      const candidates = [
        join(rootDir, settings.indexDir, 'index.scip'),
        ...['typescript', 'javascript', 'python', 'java', 'rust', 'c', 'cpp', 'csharp', 'ruby', 'php', 'go', 'dart'].map(
          lang => join(rootDir, settings.indexDir!, `${lang}.scip`),
        ),
      ];
      for (const candidate of candidates) {
        if (io.existsSync(candidate)) {
          precomputed.push(io.readFileSync(candidate));
        }
      }
    }
    if (precomputed.length > 0) return precomputed;
  }

  // Try running an indexer
  let resolvedIndexers = resolveScipIndexerRegistry(settings.indexers);
  const log = getLogger();

  // Determine which SCIP-supported languages actually exist in the project
  // so we don't waste time running irrelevant indexers (e.g., scip-go on a C project).
  const projectLanguages = staleLanguages ?? detectProjectLanguages(resolve(rootDir));

  // Auto-install missing indexers only for languages present in the project.
  const missingLanguages = [...projectLanguages].filter(
    (lang) => resolvedIndexers[lang] && !resolvedIndexers[lang]!.available,
  );
  if (missingLanguages.length > 0) {
    const attempted = new Set<string>();
    for (const lang of missingLanguages) {
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

  // Run all available indexers and merge results — don't stop at the first success.
  // Group by shared command to avoid running the same indexer twice (e.g., scip-java for java/scala/kotlin).
  const commandsRun = new Set<string>();
  const indexBuffers: Uint8Array[] = [];

  for (const [lang, indexer] of Object.entries(resolvedIndexers)) {
    if (!indexer.available) continue;
    // Skip languages not present in the project
    if (!projectLanguages.has(lang)) continue;
    // Don't run the same command twice (e.g., scip-clang for both c and cpp)
    if (commandsRun.has(indexer.command)) continue;
    commandsRun.add(indexer.command);
    try {
      const outputPath = resolve(rootDir, `.lore-scip-${lang}.scip`);
      let args = indexer.args.map(a => a.replace(/\{output\}/g, outputPath));
      const cwd = resolve(rootDir);

      // For C/C++: ensure a compile_commands.json exists and pass it to scip-clang
      if ((lang === 'c' || lang === 'cpp') && args.some(a => a.includes('{compdb}'))) {
        const compdb = await io.ensureCompilationDatabase(rootDir, settings.timeoutMs);
        if (!compdb.path) {
          log.indexing(`scip-indexer: no compile_commands.json for ${lang}, skipping`);
          continue;
        }
        args = args.map(a => a.replace(/\{compdb\}/g, compdb.path!));
      }

      // For TypeScript: generate a broad tsconfig so scip-typescript
      // indexes ALL .ts files (including tests), not just those in the
      // project's tsconfig "include" (which typically excludes tests).
      let tempTsconfigPath: string | null = null;
      if (lang === 'typescript') {
        tempTsconfigPath = createLoreScipTsconfig(rootDir);
        if (tempTsconfigPath) {
          args.push(tempTsconfigPath);
        }
      }

      // scip-clang needs a longer timeout for large C projects
      const indexerTimeout = (lang === 'c' || lang === 'cpp')
        ? Math.max(settings.timeoutMs, 600_000)
        : settings.timeoutMs;

      const executablePath = indexer.resolvedPath ?? indexer.command;
      try {
        await io.execFile(executablePath, args, {
          cwd,
          timeout: indexerTimeout,
        });
      } finally {
        if (tempTsconfigPath) {
          io.unlinkSync(tempTsconfigPath);
        }
      }

      // Check for output
      for (const candidate of [outputPath, resolve(rootDir, 'index.scip')]) {
        if (io.existsSync(candidate)) {
          const data = io.readFileSync(candidate);
          io.unlinkSync(candidate);
          indexBuffers.push(data);
          break;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.indexing(`scip-indexer: indexer failed for ${lang}: ${msg}`);
      continue;
    }
  }

  return indexBuffers;
}
