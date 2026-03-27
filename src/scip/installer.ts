/**
 * @module scip/installer
 *
 * Auto-download and manage SCIP indexer binaries.
 *
 * Lore can automatically fetch pre-built SCIP indexers so users don't need
 * to install them separately.  Binaries are stored in `~/.lore/bin/` and
 * the registry resolution checks that directory.
 */

import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
  command: string;
  languages: string[];
  method: 'github-binary' | 'github-tarball' | 'npm-bundled' | 'pip' | 'gem' | 'dotnet-tool' | 'coursier' | 'manual';
  repo?: string;
  assetName?: (tag: string) => string | null;
  packageName?: string;
  manualInstructions?: string;
}

/** Injectable I/O seam for testing. */
export interface InstallerIO {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  chmodSync: (path: string, mode: number) => void;
  downloadFile: (url: string, destPath: string) => Promise<void>;
  execFileAsync: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
  isCommandAvailable: (command: string) => boolean;
  findNpmBinPath: (command: string) => string | null;
  getLatestGitHubReleaseTag: (repo: string) => Promise<string | null>;
  unlinkSync: (path: string) => void;
  getPlatformArch: () => { os: string; cpu: string };
  getLoreBinDir: () => string;
}

// ─── Default I/O ──────────────────────────────────────────────────────────────

export function getLoreBinDir(): string {
  return join(homedir(), '.lore', 'bin');
}

async function defaultDownloadFile(url: string, destPath: string): Promise<void> {
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

function defaultIsCommandAvailable(command: string): boolean {
  try {
    childProcess.execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function defaultFindNpmBinPath(command: string): string | null {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.bin', command),
    join(dirname(process.execPath), command),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function defaultGetLatestGitHubReleaseTag(repo: string): Promise<string | null> {
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

export function createDefaultIO(): InstallerIO {
  return {
    existsSync,
    mkdirSync: (p, o) => mkdirSync(p, o),
    chmodSync,
    downloadFile: defaultDownloadFile,
    execFileAsync: (cmd, args, opts) => execFileAsync(cmd, args, opts as Record<string, unknown>),
    isCommandAvailable: defaultIsCommandAvailable,
    findNpmBinPath: defaultFindNpmBinPath,
    getLatestGitHubReleaseTag: defaultGetLatestGitHubReleaseTag,
    unlinkSync,
    getPlatformArch: () => ({ os: platform(), cpu: arch() }),
    getLoreBinDir,
  };
}

// ─── Install specs ────────────────────────────────────────────────────────────

export function buildInstallSpecs(io: Pick<InstallerIO, 'getPlatformArch'> = { getPlatformArch: () => ({ os: platform(), cpu: arch() }) }): ScipInstallSpec[] {
  return [
    { command: 'scip-typescript', languages: ['typescript'], method: 'npm-bundled', manualInstructions: 'npm install -g @sourcegraph/scip-typescript' },
    {
      command: 'scip-clang', languages: ['c', 'cpp'], method: 'github-binary', repo: 'sourcegraph/scip-clang',
      assetName: () => {
        const { os, cpu } = io.getPlatformArch();
        if (os === 'darwin' && cpu === 'arm64') return 'scip-clang-arm64-darwin';
        if (os === 'linux' && cpu === 'x64') return 'scip-clang-x86_64-linux';
        return null;
      },
    },
    {
      command: 'scip-go', languages: ['go'], method: 'github-tarball', repo: 'sourcegraph/scip-go',
      assetName: (tag: string) => {
        const { os, cpu } = io.getPlatformArch();
        const version = tag.replace(/^v/, '');
        const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
        const cpuMap: Record<string, string> = { arm64: 'arm64', x64: 'amd64' };
        const osName = osMap[os]; const cpuName = cpuMap[cpu];
        if (!osName || !cpuName) return null;
        return `scip-go_${version}_${osName}_${cpuName}.tar.gz`;
      },
    },
    { command: 'scip-python', languages: ['python'], method: 'npm-bundled', manualInstructions: 'npm install -g @sourcegraph/scip-python' },
    {
      command: 'scip-ruby', languages: ['ruby'], method: 'github-binary', repo: 'sourcegraph/scip-ruby',
      assetName: () => {
        const { os, cpu } = io.getPlatformArch();
        if (os === 'darwin' && cpu === 'arm64') return 'scip-ruby-arm64-darwin';
        if (os === 'linux' && cpu === 'x64') return 'scip-ruby-x86_64-linux';
        return null;
      },
    },
    { command: 'scip-dotnet', languages: ['csharp'], method: 'dotnet-tool', packageName: 'scip-dotnet', manualInstructions: 'dotnet tool install --global scip-dotnet' },
    { command: 'scip-java', languages: ['java', 'scala', 'kotlin'], method: 'coursier', manualInstructions: 'cs install scip-java (requires Coursier: https://get-coursier.io)' },
    { command: 'rust-analyzer', languages: ['rust'], method: 'manual', manualInstructions: 'Install via rustup: rustup component add rust-analyzer' },
    { command: 'scip-php', languages: ['php'], method: 'manual', manualInstructions: 'See https://github.com/nicovank/scip-php for installation' },
    { command: 'scip-dart', languages: ['dart'], method: 'manual', manualInstructions: 'See https://github.com/nicovank/scip-dart for installation' },
  ];
}

export const SCIP_INSTALL_SPECS: ScipInstallSpec[] = buildInstallSpecs();

// ─── Core install logic ───────────────────────────────────────────────────────

export async function installScipIndexer(spec: ScipInstallSpec, io: InstallerIO = createDefaultIO()): Promise<ScipInstallResult> {
  const binDir = io.getLoreBinDir();
  switch (spec.method) {
    case 'npm-bundled':   return installNpmBundled(spec, io);
    case 'github-binary': return installGitHubBinary(spec, binDir, io);
    case 'github-tarball':return installGitHubTarball(spec, binDir, io);
    case 'pip':           return installViaPip(spec, io);
    case 'gem':           return installViaGem(spec, io);
    case 'dotnet-tool':   return installViaDotnetTool(spec, io);
    case 'coursier':      return installViaCoursier(spec, io);
    case 'manual':        return { command: spec.command, installed: false, path: null, error: `Manual install required: ${spec.manualInstructions}` };
    default:              return { command: spec.command, installed: false, path: null, error: `Unknown install method: ${spec.method}` };
  }
}

export async function installAllMissing(options: { languages?: string[]; quiet?: boolean; io?: InstallerIO } = {}): Promise<ScipInstallResult[]> {
  const log = getLogger();
  const io = options.io ?? createDefaultIO();
  const results: ScipInstallResult[] = [];
  const seen = new Set<string>();
  for (const spec of SCIP_INSTALL_SPECS) {
    if (seen.has(spec.command)) continue;
    seen.add(spec.command);
    if (options.languages && !spec.languages.some((l) => options.languages!.includes(l))) continue;
    if (io.isCommandAvailable(spec.command)) {
      if (!options.quiet) log.indexing(`scip-install: ${spec.command} already available`);
      results.push({ command: spec.command, installed: true, path: spec.command });
      continue;
    }
    if (!options.quiet) log.indexing(`scip-install: installing ${spec.command}...`);
    const result = await installScipIndexer(spec, io);
    results.push(result);
    if (!options.quiet) {
      if (result.installed) log.indexing(`scip-install: ${spec.command} installed at ${result.path}`);
      else log.indexing(`scip-install: ${spec.command} not installed: ${result.error ?? 'unknown error'}`);
    }
  }
  return results;
}

export function getSpecForCommand(command: string): ScipInstallSpec | undefined {
  return SCIP_INSTALL_SPECS.find((s) => s.command === command);
}

export function getSpecsForLanguage(language: string): ScipInstallSpec[] {
  return SCIP_INSTALL_SPECS.filter((s) => s.languages.includes(language));
}

// ─── Install methods (internal, using io seam) ──────────────────────────────

async function installNpmBundled(spec: ScipInstallSpec, io: InstallerIO): Promise<ScipInstallResult> {
  try {
    const binPath = io.findNpmBinPath(spec.command);
    if (binPath) return { command: spec.command, installed: true, path: binPath };
    return { command: spec.command, installed: false, path: null, error: `${spec.command} not found in node_modules` };
  } catch {
    return { command: spec.command, installed: false, path: null, error: `Failed to resolve npm-bundled ${spec.command}` };
  }
}

async function installGitHubBinary(spec: ScipInstallSpec, binDir: string, io: InstallerIO): Promise<ScipInstallResult> {
  if (!spec.repo || !spec.assetName) return { command: spec.command, installed: false, path: null, error: 'Missing repo or assetName config' };
  try {
    const tag = await io.getLatestGitHubReleaseTag(spec.repo);
    if (!tag) return { command: spec.command, installed: false, path: null, error: `No releases found for ${spec.repo}` };
    const assetName = spec.assetName(tag);
    if (!assetName) { const { os, cpu } = io.getPlatformArch(); return { command: spec.command, installed: false, path: null, error: `No binary available for ${os}-${cpu}` }; }
    const url = `https://github.com/${spec.repo}/releases/download/${tag}/${assetName}`;
    const destPath = join(binDir, spec.command);
    io.mkdirSync(binDir, { recursive: true });
    await io.downloadFile(url, destPath);
    io.chmodSync(destPath, 0o755);
    return { command: spec.command, installed: true, path: destPath };
  } catch (error) {
    return { command: spec.command, installed: false, path: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function installGitHubTarball(spec: ScipInstallSpec, binDir: string, io: InstallerIO): Promise<ScipInstallResult> {
  if (!spec.repo || !spec.assetName) return { command: spec.command, installed: false, path: null, error: 'Missing repo or assetName config' };
  try {
    const tag = await io.getLatestGitHubReleaseTag(spec.repo);
    if (!tag) return { command: spec.command, installed: false, path: null, error: `No releases found for ${spec.repo}` };
    const assetName = spec.assetName(tag);
    if (!assetName) { const { os, cpu } = io.getPlatformArch(); return { command: spec.command, installed: false, path: null, error: `No binary available for ${os}-${cpu}` }; }
    const url = `https://github.com/${spec.repo}/releases/download/${tag}/${assetName}`;
    const tmpPath = join(binDir, `${spec.command}.tar.gz`);
    const destPath = join(binDir, spec.command);
    io.mkdirSync(binDir, { recursive: true });
    await io.downloadFile(url, tmpPath);
    await io.execFileAsync('tar', ['xzf', tmpPath, '-C', binDir]);
    try { io.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (io.existsSync(destPath)) io.chmodSync(destPath, 0o755);
    return { command: spec.command, installed: io.existsSync(destPath), path: io.existsSync(destPath) ? destPath : null };
  } catch (error) {
    return { command: spec.command, installed: false, path: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function installViaPip(spec: ScipInstallSpec, io: InstallerIO): Promise<ScipInstallResult> {
  if (!spec.packageName) return { command: spec.command, installed: false, path: null, error: 'Missing pip package name' };
  const pipCmd = io.isCommandAvailable('pip3') ? 'pip3' : io.isCommandAvailable('pip') ? 'pip' : null;
  if (!pipCmd) return { command: spec.command, installed: false, path: null, error: `pip not found` };
  try {
    await io.execFileAsync(pipCmd, ['install', '--user', spec.packageName], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) { return { command: spec.command, installed: false, path: null, error: error instanceof Error ? error.message : String(error) }; }
}

async function installViaGem(spec: ScipInstallSpec, io: InstallerIO): Promise<ScipInstallResult> {
  if (!spec.packageName) return { command: spec.command, installed: false, path: null, error: 'Missing gem package name' };
  if (!io.isCommandAvailable('gem')) return { command: spec.command, installed: false, path: null, error: 'gem not found' };
  try {
    await io.execFileAsync('gem', ['install', spec.packageName, '--user-install'], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) { return { command: spec.command, installed: false, path: null, error: error instanceof Error ? error.message : String(error) }; }
}

async function installViaDotnetTool(spec: ScipInstallSpec, io: InstallerIO): Promise<ScipInstallResult> {
  if (!spec.packageName) return { command: spec.command, installed: false, path: null, error: 'Missing dotnet package name' };
  if (!io.isCommandAvailable('dotnet')) return { command: spec.command, installed: false, path: null, error: 'dotnet not found' };
  try {
    await io.execFileAsync('dotnet', ['tool', 'install', '--global', spec.packageName], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) { return { command: spec.command, installed: false, path: null, error: error instanceof Error ? error.message : String(error) }; }
}

async function installViaCoursier(spec: ScipInstallSpec, io: InstallerIO): Promise<ScipInstallResult> {
  const csCmd = io.isCommandAvailable('cs') ? 'cs' : io.isCommandAvailable('coursier') ? 'coursier' : null;
  if (!csCmd) return { command: spec.command, installed: false, path: null, error: 'Coursier not found' };
  try {
    await io.execFileAsync(csCmd, ['install', spec.command], { timeout: 120_000 });
    return { command: spec.command, installed: true, path: spec.command };
  } catch (error) { return { command: spec.command, installed: false, path: null, error: error instanceof Error ? error.message : String(error) }; }
}
