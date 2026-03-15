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
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export type BuildSystem = 'cmake' | 'meson' | 'make' | 'none';

export interface CompdbResult {
  path: string | null;
  buildSystem: BuildSystem;
  preExisting: boolean;
}

/** Injectable I/O seam for testing. */
export interface CompdbIO {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts?: { recursive: boolean }) => void;
  execFileAsync: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
}

// ─── Default I/O ──────────────────────────────────────────────────────────────

export function createDefaultCompdbIO(): CompdbIO {
  return {
    existsSync,
    mkdirSync: (p, o) => mkdirSync(p, o),
    execFileAsync: (cmd, args, opts) => execFileAsync(cmd, args, opts as Record<string, unknown>),
  };
}

// ─── Detection (pure, exported for testing) ───────────────────────────────────

export function findExistingCompdb(rootDir: string, io: Pick<CompdbIO, 'existsSync'> = { existsSync }): string | null {
  const candidates = [
    join(rootDir, 'compile_commands.json'),
    join(rootDir, 'build', 'compile_commands.json'),
    join(rootDir, 'builddir', 'compile_commands.json'),
    join(rootDir, '.lore-compdb', 'compile_commands.json'),
  ];
  for (const p of candidates) {
    if (io.existsSync(p)) return p;
  }
  return null;
}

export function detectBuildSystem(rootDir: string, io: Pick<CompdbIO, 'existsSync'> = { existsSync }): BuildSystem {
  if (io.existsSync(join(rootDir, 'CMakeLists.txt'))) return 'cmake';
  if (io.existsSync(join(rootDir, 'meson.build'))) return 'meson';
  if (io.existsSync(join(rootDir, 'Makefile')) || io.existsSync(join(rootDir, 'configure'))) return 'make';
  return 'none';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function ensureCompilationDatabase(
  rootDir: string,
  timeoutMs: number = 300_000,
  io: CompdbIO = createDefaultCompdbIO(),
): Promise<CompdbResult> {
  const log = getLogger();
  const absRoot = resolve(rootDir);

  const existing = findExistingCompdb(absRoot, io);
  if (existing) {
    log.indexing(`compdb: found existing compile_commands.json at ${existing}`);
    return { path: existing, buildSystem: detectBuildSystem(absRoot, io), preExisting: true };
  }

  const buildSystem = detectBuildSystem(absRoot, io);
  if (buildSystem === 'none') {
    log.indexing('compdb: no supported build system detected');
    return { path: null, buildSystem: 'none', preExisting: false };
  }

  log.indexing(`compdb: detected ${buildSystem} build system, generating compile_commands.json...`);

  try {
    const path = await generateCompdb(absRoot, buildSystem, timeoutMs, io);
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

// ─── Generation ───────────────────────────────────────────────────────────────

export async function generateCompdb(
  rootDir: string,
  buildSystem: BuildSystem,
  timeoutMs: number,
  io: CompdbIO = createDefaultCompdbIO(),
): Promise<string | null> {
  switch (buildSystem) {
    case 'cmake': return generateCmakeCompdb(rootDir, timeoutMs, io);
    case 'meson': return generateMesonCompdb(rootDir, timeoutMs, io);
    case 'make':  return generateBearCompdb(rootDir, timeoutMs, io);
    default:      return null;
  }
}

async function generateCmakeCompdb(rootDir: string, timeoutMs: number, io: CompdbIO): Promise<string | null> {
  const buildDir = join(rootDir, '.lore-compdb');
  io.mkdirSync(buildDir, { recursive: true });
  await io.execFileAsync('cmake', ['-S', rootDir, '-B', buildDir, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'], { cwd: rootDir, timeout: timeoutMs });
  const result = join(buildDir, 'compile_commands.json');
  return io.existsSync(result) ? result : null;
}

async function generateMesonCompdb(rootDir: string, timeoutMs: number, io: CompdbIO): Promise<string | null> {
  const log = getLogger();
  const buildDir = join(rootDir, '.lore-compdb');

  if (io.existsSync(join(buildDir, 'meson-private'))) {
    const result = join(buildDir, 'compile_commands.json');
    if (io.existsSync(result)) return result;
  }

  log.indexing(`compdb: running meson setup ${buildDir} (timeout: ${timeoutMs}ms)`);
  const { stderr } = await io.execFileAsync('meson', ['setup', buildDir], { cwd: rootDir, timeout: timeoutMs });
  if (stderr) log.indexing(`compdb: meson stderr: ${stderr.slice(-200)}`);

  const result = join(buildDir, 'compile_commands.json');
  const found = io.existsSync(result);
  log.indexing(`compdb: meson complete, compile_commands.json exists: ${found}`);
  return found ? result : null;
}

async function generateBearCompdb(rootDir: string, timeoutMs: number, io: CompdbIO): Promise<string | null> {
  const log = getLogger();

  try {
    await io.execFileAsync('bear', ['--version'], { timeout: 5000 });
  } catch {
    log.indexing('compdb: bear not found — cannot generate compile_commands.json for Make projects. Install via: brew install bear / apt install bear');
    return null;
  }

  if (io.existsSync(join(rootDir, 'configure')) && !io.existsSync(join(rootDir, 'config.status'))) {
    try {
      await io.execFileAsync('./configure', [], { cwd: rootDir, timeout: timeoutMs });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.indexing(`compdb: ./configure failed: ${msg}`);
    }
  }

  const output = join(rootDir, 'compile_commands.json');
  await io.execFileAsync('bear', ['--output', output, '--', 'make', '-j4'], { cwd: rootDir, timeout: timeoutMs });

  return io.existsSync(output) ? output : null;
}
