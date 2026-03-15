/**
 * @module scip/compdb
 *
 * Generate a `compile_commands.json` for C/C++ projects so scip-clang
 * can produce a SCIP index.
 *
 * Lore automatically detects the build system and generates the compilation
 * database if one doesn't already exist.  Supported build systems:
 *
 * | Build system | Detection                  | Strategy                    |
 * |-------------|----------------------------|-----------------------------|
 * | CMake       | CMakeLists.txt             | cmake -DCMAKE_EXPORT_...    |
 * | Meson       | meson.build                | meson setup                 |
 * | Make        | Makefile / configure       | bear -- make                |
 *
 * The generated file is placed in a `.lore-compdb/` directory inside the
 * project root so it doesn't interfere with the user's build.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

type BuildSystem = 'cmake' | 'meson' | 'make' | 'none';

export interface CompdbResult {
  /** Absolute path to compile_commands.json, or null if generation failed. */
  path: string | null;
  /** Build system detected. */
  buildSystem: BuildSystem;
  /** Whether the file already existed (vs. was freshly generated). */
  preExisting: boolean;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure a compile_commands.json exists for the given project.
 *
 * 1. Check for an existing compile_commands.json in standard locations.
 * 2. If not found, detect the build system and generate one.
 *
 * @returns Path to compile_commands.json or null if generation failed.
 */
export async function ensureCompilationDatabase(
  rootDir: string,
  timeoutMs: number = 300_000,
): Promise<CompdbResult> {
  const log = getLogger();
  const absRoot = resolve(rootDir);

  // Check standard locations for existing compile_commands.json
  const existing = findExistingCompdb(absRoot);
  if (existing) {
    log.indexing(`compdb: found existing compile_commands.json at ${existing}`);
    return { path: existing, buildSystem: detectBuildSystem(absRoot), preExisting: true };
  }

  const buildSystem = detectBuildSystem(absRoot);
  if (buildSystem === 'none') {
    log.indexing('compdb: no supported build system detected');
    return { path: null, buildSystem: 'none', preExisting: false };
  }

  log.indexing(`compdb: detected ${buildSystem} build system, generating compile_commands.json...`);

  try {
    const path = await generateCompdb(absRoot, buildSystem, timeoutMs);
    if (path) {
      log.indexing(`compdb: generated compile_commands.json at ${path}`);
      return { path, buildSystem, preExisting: false };
    }
    log.indexing('compdb: build system configuration produced no compile_commands.json');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr;
    log.indexing(`compdb: generation failed: ${msg}${stderr ? '\n' + stderr : ''}`);
  }

  return { path: null, buildSystem, preExisting: false };
}

// ─── Detection ────────────────────────────────────────────────────────────────

function findExistingCompdb(rootDir: string): string | null {
  const candidates = [
    join(rootDir, 'compile_commands.json'),
    join(rootDir, 'build', 'compile_commands.json'),
    join(rootDir, 'builddir', 'compile_commands.json'),
    join(rootDir, '.lore-compdb', 'compile_commands.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function detectBuildSystem(rootDir: string): BuildSystem {
  // Check in priority order
  if (existsSync(join(rootDir, 'CMakeLists.txt'))) return 'cmake';
  if (existsSync(join(rootDir, 'meson.build'))) return 'meson';
  if (existsSync(join(rootDir, 'Makefile')) || existsSync(join(rootDir, 'configure'))) return 'make';
  return 'none';
}

// ─── Generation ───────────────────────────────────────────────────────────────

async function generateCompdb(
  rootDir: string,
  buildSystem: BuildSystem,
  timeoutMs: number,
): Promise<string | null> {
  switch (buildSystem) {
    case 'cmake':
      return generateCmakeCompdb(rootDir, timeoutMs);
    case 'meson':
      return generateMesonCompdb(rootDir, timeoutMs);
    case 'make':
      return generateBearCompdb(rootDir, timeoutMs);
    default:
      return null;
  }
}

async function generateCmakeCompdb(rootDir: string, timeoutMs: number): Promise<string | null> {
  const buildDir = join(rootDir, '.lore-compdb');
  mkdirSync(buildDir, { recursive: true });

  await execFileAsync('cmake', [
    '-S', rootDir,
    '-B', buildDir,
    '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
  ], { cwd: rootDir, timeout: timeoutMs });

  const result = join(buildDir, 'compile_commands.json');
  return existsSync(result) ? result : null;
}

async function generateMesonCompdb(rootDir: string, timeoutMs: number): Promise<string | null> {
  const log = getLogger();
  const buildDir = join(rootDir, '.lore-compdb');

  // Meson fails if the build dir already has a configured project from a different source dir.
  // If .lore-compdb already exists with a meson-private dir, just check for compile_commands.json.
  if (existsSync(join(buildDir, 'meson-private'))) {
    const result = join(buildDir, 'compile_commands.json');
    if (existsSync(result)) return result;
  }

  // Don't pre-create the directory — meson setup creates it and
  // refuses to run if it already exists but isn't a meson build dir.
  log.indexing(`compdb: running meson setup ${buildDir} (timeout: ${timeoutMs}ms)`);
  const { stdout, stderr } = await execFileAsync('meson', ['setup', buildDir], {
    cwd: rootDir,
    timeout: timeoutMs,
  });
  if (stderr) log.indexing(`compdb: meson stderr: ${stderr.slice(-200)}`);

  const result = join(buildDir, 'compile_commands.json');
  const found = existsSync(result);
  log.indexing(`compdb: meson complete, compile_commands.json exists: ${found}`);
  return found ? result : null;
}

async function generateBearCompdb(rootDir: string, timeoutMs: number): Promise<string | null> {
  const log = getLogger();

  // Check if bear is available
  try {
    await execFileAsync('bear', ['--version'], { timeout: 5000 });
  } catch {
    log.indexing('compdb: bear not found — cannot generate compile_commands.json for Make projects. Install via: brew install bear / apt install bear');
    return null;
  }

  // If there's a configure script that hasn't been run, run it first
  if (existsSync(join(rootDir, 'configure')) && !existsSync(join(rootDir, 'config.status'))) {
    try {
      await execFileAsync('./configure', [], { cwd: rootDir, timeout: timeoutMs });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.indexing(`compdb: ./configure failed: ${msg}`);
      // Continue anyway — Makefile might work without configure
    }
  }

  const output = join(rootDir, 'compile_commands.json');
  await execFileAsync('bear', ['--output', output, '--', 'make', '-j4'], {
    cwd: rootDir,
    timeout: timeoutMs,
  });

  return existsSync(output) ? output : null;
}
