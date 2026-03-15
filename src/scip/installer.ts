/**
 * @module scip/installer
 *
 * Auto-download and manage SCIP indexer binaries.
 *
 * Lore can automatically fetch pre-built SCIP indexers so users don't need
 * to install them separately.  Binaries are stored in `~/.lore/bin/` and
 * the registry resolution checks that directory.
 *
 * ## Supported auto-install methods
 *
 * | Indexer          | Method                           |
 * |------------------|----------------------------------|
 * | scip-typescript  | Bundled npm dependency           |
 * | scip-clang       | GitHub release (binary)          |
 * | scip-go          | GitHub release (tar.gz)          |
 * | scip-python      | pip install                      |
 * | scip-ruby        | gem install                      |
 * | scip-dotnet      | dotnet tool install              |
 * | scip-java        | coursier bootstrap               |
 * | rust-analyzer    | manual (system package)          |
 */

import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { execFile, execSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScipInstallResult {
  command: string;
  installed: boolean;
  path: string | null;
  error?: string;
}

export interface ScipInstallSpec {
  /** The binary name (e.g., 'scip-clang'). */
  command: string;
  /** Languages this indexer covers. */
  languages: string[];
  /** How to install it. */
  method: 'github-binary' | 'github-tarball' | 'npm-bundled' | 'pip' | 'gem' | 'dotnet-tool' | 'coursier' | 'manual';
  /** GitHub repo owner/name (for github-* methods). */
  repo?: string;
  /** Function to compute the asset name for the current platform. */
  assetName?: (tag: string) => string | null;
  /** pip/gem/dotnet package name. */
  packageName?: string;
  /** Human-readable install instructions for manual installs. */
  manualInstructions?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Directory where Lore stores managed SCIP indexer binaries. */
export function getLoreBinDir(): string {
  return join(homedir(), '.lore', 'bin');
}

// ─── Install specs ────────────────────────────────────────────────────────────

function getPlatformArch(): { os: string; cpu: string } {
  const os = platform();
  const cpu = arch();
  return { os, cpu };
}

export const SCIP_INSTALL_SPECS: ScipInstallSpec[] = [
  {
    command: 'scip-typescript',
    languages: ['typescript'],
    method: 'npm-bundled',
    manualInstructions: 'npm install -g @sourcegraph/scip-typescript',
  },
  {
    command: 'scip-clang',
    languages: ['c', 'cpp'],
    method: 'github-binary',
    repo: 'sourcegraph/scip-clang',
    assetName: () => {
      const { os, cpu } = getPlatformArch();
      if (os === 'darwin' && cpu === 'arm64') return 'scip-clang-arm64-darwin';
      if (os === 'linux' && cpu === 'x64') return 'scip-clang-x86_64-linux';
      return null; // No binary available for this platform
    },
  },
  {
    command: 'scip-go',
    languages: ['go'],
    method: 'github-tarball',
    repo: 'sourcegraph/scip-go',
    assetName: (tag: string) => {
      const { os, cpu } = getPlatformArch();
      const version = tag.replace(/^v/, '');
      const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
      const cpuMap: Record<string, string> = { arm64: 'arm64', x64: 'amd64' };
      const osName = osMap[os];
      const cpuName = cpuMap[cpu];
      if (!osName || !cpuName) return null;
      return `scip-go_${version}_${osName}_${cpuName}.tar.gz`;
    },
  },
  {
    command: 'scip-python',
    languages: ['python'],
    method: 'npm-bundled',
    manualInstructions: 'npm install -g @sourcegraph/scip-python',
  },
  {
    command: 'scip-ruby',
    languages: ['ruby'],
    method: 'github-binary',
    repo: 'sourcegraph/scip-ruby',
    assetName: () => {
      const { os, cpu } = getPlatformArch();
      if (os === 'darwin' && cpu === 'arm64') return 'scip-ruby-arm64-darwin';
      if (os === 'linux' && cpu === 'x64') return 'scip-ruby-x86_64-linux';
      return null;
    },
  },
  {
    command: 'scip-dotnet',
    languages: ['csharp'],
    method: 'dotnet-tool',
    packageName: 'scip-dotnet',
    manualInstructions: 'dotnet tool install --global scip-dotnet',
  },
  {
    command: 'scip-java',
    languages: ['java', 'scala', 'kotlin'],
    method: 'coursier',
    manualInstructions: 'cs install scip-java (requires Coursier: https://get-coursier.io)',
  },
  {
    command: 'rust-analyzer',
    languages: ['rust'],
    method: 'manual',
    manualInstructions: 'Install via rustup: rustup component add rust-analyzer',
  },
  {
    command: 'scip-php',
    languages: ['php'],
    method: 'manual',
    manualInstructions: 'See https://github.com/nicovank/scip-php for installation',
  },
  {
    command: 'scip-dart',
    languages: ['dart'],
    method: 'manual',
    manualInstructions: 'See https://github.com/nicovank/scip-dart for installation',
  },
];

// ─── Core install logic ───────────────────────────────────────────────────────

/**
 * Install a SCIP indexer.  Returns the result including the installed path.
 */
export async function installScipIndexer(spec: ScipInstallSpec): Promise<ScipInstallResult> {
  const log = getLogger();
  const binDir = getLoreBinDir();

  switch (spec.method) {
    case 'npm-bundled':
      return installNpmBundled(spec);

    case 'github-binary':
      return installGitHubBinary(spec, binDir);

    case 'github-tarball':
      return installGitHubTarball(spec, binDir);

    case 'pip':
      return installViaPip(spec);

    case 'gem':
      return installViaGem(spec);

    case 'dotnet-tool':
      return installViaDotnetTool(spec);

    case 'coursier':
      return installViaCoursier(spec);

    case 'manual':
      return {
        command: spec.command,
        installed: false,
        path: null,
        error: `Manual install required: ${spec.manualInstructions}`,
      };

    default:
      return { command: spec.command, installed: false, path: null, error: `Unknown install method: ${spec.method}` };
  }
}

/**
 * Install all SCIP indexers that are currently missing.
 * Optionally filter to specific languages.
 */
export async function installAllMissing(
  options: { languages?: string[]; quiet?: boolean } = {},
): Promise<ScipInstallResult[]> {
  const log = getLogger();
  const results: ScipInstallResult[] = [];

  // Deduplicate by command
  const seen = new Set<string>();

  for (const spec of SCIP_INSTALL_SPECS) {
    if (seen.has(spec.command)) continue;
    seen.add(spec.command);

    // Filter by language if requested
    if (options.languages && !spec.languages.some((l) => options.languages!.includes(l))) {
      continue;
    }

    // Skip if already available on PATH or in managed dir
    if (isCommandAvailable(spec.command)) {
      if (!options.quiet) {
        log.indexing(`scip-install: ${spec.command} already available`);
      }
      results.push({ command: spec.command, installed: true, path: spec.command });
      continue;
    }

    if (!options.quiet) {
      log.indexing(`scip-install: installing ${spec.command}...`);
    }

    const result = await installScipIndexer(spec);
    results.push(result);

    if (!options.quiet) {
      if (result.installed) {
        log.indexing(`scip-install: ${spec.command} installed at ${result.path}`);
      } else {
        log.indexing(`scip-install: ${spec.command} not installed: ${result.error ?? 'unknown error'}`);
      }
    }
  }

  return results;
}

/**
 * Get the spec for a specific command.
 */
export function getSpecForCommand(command: string): ScipInstallSpec | undefined {
  return SCIP_INSTALL_SPECS.find((s) => s.command === command);
}

/**
 * Get the spec(s) for a specific language.
 */
export function getSpecsForLanguage(language: string): ScipInstallSpec[] {
  return SCIP_INSTALL_SPECS.filter((s) => s.languages.includes(language));
}

// ─── Install methods ──────────────────────────────────────────────────────────

async function installNpmBundled(spec: ScipInstallSpec): Promise<ScipInstallResult> {
  // scip-typescript is a direct dependency — resolve from node_modules
  try {
    const binPath = findNpmBinPath(spec.command);
    if (binPath) {
      return { command: spec.command, installed: true, path: binPath };
    }
    return {
      command: spec.command,
      installed: false,
      path: null,
      error: `${spec.command} not found in node_modules. Run: npm install @sourcegraph/scip-typescript`,
    };
  } catch {
    return {
      command: spec.command,
      installed: false,
      path: null,
      error: `Failed to resolve npm-bundled ${spec.command}`,
    };
  }
}

async function installGitHubBinary(spec: ScipInstallSpec, binDir: string): Promise<ScipInstallResult> {
  if (!spec.repo || !spec.assetName) {
    return { command: spec.command, installed: false, path: null, error: 'Missing repo or assetName config' };
  }

  try {
    // Get latest release tag
    const tag = await getLatestGitHubReleaseTag(spec.repo);
    if (!tag) {
      return { command: spec.command, installed: false, path: null, error: `No releases found for ${spec.repo}` };
    }

    const assetName = spec.assetName(tag);
    if (!assetName) {
      return {
        command: spec.command,
        installed: false,
        path: null,
        error: `No binary available for ${platform()}-${arch()}`,
      };
    }

    const url = `https://github.com/${spec.repo}/releases/download/${tag}/${assetName}`;
    const destPath = join(binDir, spec.command);

    mkdirSync(binDir, { recursive: true });
    await downloadFile(url, destPath);
    chmodSync(destPath, 0o755);

    return { command: spec.command, installed: true, path: destPath };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { command: spec.command, installed: false, path: null, error: msg };
  }
}

async function installGitHubTarball(spec: ScipInstallSpec, binDir: string): Promise<ScipInstallResult> {
  if (!spec.repo || !spec.assetName) {
    return { command: spec.command, installed: false, path: null, error: 'Missing repo or assetName config' };
  }

  try {
    const tag = await getLatestGitHubReleaseTag(spec.repo);
    if (!tag) {
      return { command: spec.command, installed: false, path: null, error: `No releases found for ${spec.repo}` };
    }

    const assetName = spec.assetName(tag);
    if (!assetName) {
      return {
        command: spec.command,
        installed: false,
        path: null,
        error: `No binary available for ${platform()}-${arch()}`,
      };
    }

    const url = `https://github.com/${spec.repo}/releases/download/${tag}/${assetName}`;
    const tmpPath = join(binDir, `${spec.command}.tar.gz`);
    const destPath = join(binDir, spec.command);

    mkdirSync(binDir, { recursive: true });
    await downloadFile(url, tmpPath);

    // Extract the binary from the tarball
    await execFileAsync('tar', ['xzf', tmpPath, '-C', binDir]);

    // Clean up tarball
    try { unlinkSync(tmpPath); } catch { /* ignore */ }

    // Ensure the extracted binary is executable
    if (existsSync(destPath)) {
      chmodSync(destPath, 0o755);
    }

    return { command: spec.command, installed: existsSync(destPath), path: existsSync(destPath) ? destPath : null };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { command: spec.command, installed: false, path: null, error: msg };
  }
}

async function installViaPip(spec: ScipInstallSpec): Promise<ScipInstallResult> {
  if (!spec.packageName) {
    return { command: spec.command, installed: false, path: null, error: 'Missing pip package name' };
  }
  try {
    // Try pip3 first, then pip
    const pipCmd = await findCommand(['pip3', 'pip']);
    if (!pipCmd) {
      return {
        command: spec.command,
        installed: false,
        path: null,
        error: `pip not found. Install manually: ${spec.manualInstructions}`,
      };
    }
    await execFileAsync(pipCmd, ['install', '--user', spec.packageName], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { command: spec.command, installed: false, path: null, error: msg };
  }
}

async function installViaGem(spec: ScipInstallSpec): Promise<ScipInstallResult> {
  if (!spec.packageName) {
    return { command: spec.command, installed: false, path: null, error: 'Missing gem package name' };
  }
  try {
    const gemCmd = await findCommand(['gem']);
    if (!gemCmd) {
      return {
        command: spec.command,
        installed: false,
        path: null,
        error: `gem not found. Install manually: ${spec.manualInstructions}`,
      };
    }
    await execFileAsync(gemCmd, ['install', spec.packageName, '--user-install'], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { command: spec.command, installed: false, path: null, error: msg };
  }
}

async function installViaDotnetTool(spec: ScipInstallSpec): Promise<ScipInstallResult> {
  if (!spec.packageName) {
    return { command: spec.command, installed: false, path: null, error: 'Missing dotnet package name' };
  }
  try {
    const dotnetCmd = await findCommand(['dotnet']);
    if (!dotnetCmd) {
      return {
        command: spec.command,
        installed: false,
        path: null,
        error: `dotnet not found. Install manually: ${spec.manualInstructions}`,
      };
    }
    await execFileAsync(dotnetCmd, ['tool', 'install', '--global', spec.packageName], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { command: spec.command, installed: false, path: null, error: msg };
  }
}

async function installViaCoursier(spec: ScipInstallSpec): Promise<ScipInstallResult> {
  try {
    const csCmd = await findCommand(['cs', 'coursier']);
    if (!csCmd) {
      return {
        command: spec.command,
        installed: false,
        path: null,
        error: `Coursier not found. Install manually: ${spec.manualInstructions}`,
      };
    }
    await execFileAsync(csCmd, ['install', spec.command], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { command: spec.command, installed: false, path: null, error: msg };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getLatestGitHubReleaseTag(repo: string): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'lore-scip-installer' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { tag_name?: string };
    return data.tag_name ?? null;
  } catch {
    return null;
  }
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'lore-scip-installer' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  const fileStream = createWriteStream(destPath);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);
}

function isCommandAvailable(command: string): boolean {
  try {
    const { execSync } = childProcess;
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function findCommand(candidates: string[]): Promise<string | null> {
  for (const cmd of candidates) {
    if (isCommandAvailable(cmd)) return cmd;
  }
  return null;
}

/**
 * Find the binary path for an npm-bundled SCIP indexer.
 * Tries both local node_modules/.bin and the package's bin entry.
 */
function findNpmBinPath(command: string): string | null {
  // Try to find it in node_modules/.bin relative to this module
  const candidates = [
    // Relative to the Lore package itself
    join(dirname(new URL(import.meta.url).pathname), '..', '..', 'node_modules', '.bin', command),
    // Global node_modules
    join(dirname(process.execPath), command),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
