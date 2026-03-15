import { describe, it, expect, vi } from 'vitest';
import {
  installScipIndexer,
  installAllMissing,
  getSpecForCommand,
  getSpecsForLanguage,
  buildInstallSpecs,
  SCIP_INSTALL_SPECS,
  getLoreBinDir,
  createDefaultIO,
  type InstallerIO,
  type ScipInstallSpec,
} from '../../src/scip/installer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockIO(overrides: Partial<InstallerIO> = {}): InstallerIO {
  return {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    downloadFile: vi.fn(async () => {}),
    execFileAsync: vi.fn(async () => ({ stdout: '', stderr: '' })),
    isCommandAvailable: vi.fn(() => false),
    findNpmBinPath: vi.fn(() => null),
    getLatestGitHubReleaseTag: vi.fn(async () => 'v1.0.0'),
    unlinkSync: vi.fn(),
    getPlatformArch: vi.fn(() => ({ os: 'linux', cpu: 'x64' })),
    getLoreBinDir: vi.fn(() => '/tmp/test-lore-bin'),
    ...overrides,
  };
}

// ─── Spec catalogue ───────────────────────────────────────────────────────────

describe('SCIP installer specs', () => {
  it('covers all expected languages', () => {
    const langs = new Set(SCIP_INSTALL_SPECS.flatMap((s) => s.languages));
    for (const l of ['typescript', 'python', 'c', 'cpp', 'go', 'ruby', 'csharp', 'java', 'rust', 'php', 'dart']) {
      expect(langs.has(l)).toBe(true);
    }
  });

  it('has unique commands', () => {
    const cmds = SCIP_INSTALL_SPECS.map((s) => s.command);
    expect(new Set(cmds).size).toBe(cmds.length);
  });

  it('getSpecForCommand returns the right spec', () => {
    expect(getSpecForCommand('scip-clang')?.languages).toContain('c');
    expect(getSpecForCommand('nonexistent')).toBeUndefined();
  });

  it('getSpecsForLanguage returns matching specs', () => {
    const cSpecs = getSpecsForLanguage('c');
    expect(cSpecs.length).toBeGreaterThan(0);
    expect(cSpecs[0]!.command).toBe('scip-clang');
    expect(getSpecsForLanguage('unknown')).toEqual([]);
  });

  it('getLoreBinDir returns a path under home', () => {
    const dir = getLoreBinDir();
    expect(dir).toContain('.lore');
    expect(dir).toContain('bin');
  });
});

// ─── buildInstallSpecs platform-dependent asset names ─────────────────────────

describe('buildInstallSpecs asset names', () => {
  it('scip-clang returns correct asset for darwin arm64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'darwin', cpu: 'arm64' }) });
    const clang = specs.find((s) => s.command === 'scip-clang')!;
    expect(clang.assetName!('v1.0.0')).toBe('scip-clang-arm64-darwin');
  });

  it('scip-clang returns correct asset for linux x64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'linux', cpu: 'x64' }) });
    const clang = specs.find((s) => s.command === 'scip-clang')!;
    expect(clang.assetName!('v1.0.0')).toBe('scip-clang-x86_64-linux');
  });

  it('scip-clang returns null for unsupported platform', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'win32', cpu: 'x64' }) });
    const clang = specs.find((s) => s.command === 'scip-clang')!;
    expect(clang.assetName!('v1.0.0')).toBeNull();
  });

  it('scip-go builds tarball name with version', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'darwin', cpu: 'arm64' }) });
    const goSpec = specs.find((s) => s.command === 'scip-go')!;
    expect(goSpec.assetName!('v0.1.26')).toBe('scip-go_0.1.26_darwin_arm64.tar.gz');
  });

  it('scip-ruby returns correct asset for darwin arm64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'darwin', cpu: 'arm64' }) });
    const ruby = specs.find((s) => s.command === 'scip-ruby')!;
    expect(ruby.assetName!('v0.4.7')).toBe('scip-ruby-arm64-darwin');
  });
});

// ─── installScipIndexer ───────────────────────────────────────────────────────

describe('installScipIndexer', () => {
  it('npm-bundled: returns path when found in node_modules', async () => {
    const io = createMockIO({ findNpmBinPath: vi.fn(() => '/path/to/scip-typescript') });
    const spec: ScipInstallSpec = { command: 'scip-typescript', languages: ['typescript'], method: 'npm-bundled' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(result.path).toBe('/path/to/scip-typescript');
  });

  it('npm-bundled: returns error when not found', async () => {
    const io = createMockIO({ findNpmBinPath: vi.fn(() => null) });
    const spec: ScipInstallSpec = { command: 'scip-typescript', languages: ['typescript'], method: 'npm-bundled' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('github-binary: downloads, makes executable, returns path', async () => {
    const io = createMockIO({
      getLatestGitHubReleaseTag: vi.fn(async () => 'v0.4.0'),
      getPlatformArch: vi.fn(() => ({ os: 'linux', cpu: 'x64' })),
    });
    const specs = buildInstallSpecs(io);
    const clangSpec = specs.find((s) => s.command === 'scip-clang')!;
    const result = await installScipIndexer(clangSpec, io);
    expect(result.installed).toBe(true);
    expect(result.path).toBe('/tmp/test-lore-bin/scip-clang');
    expect(io.mkdirSync).toHaveBeenCalled();
    expect(io.downloadFile).toHaveBeenCalled();
    expect(io.chmodSync).toHaveBeenCalledWith('/tmp/test-lore-bin/scip-clang', 0o755);
  });

  it('github-binary: returns error when no release found', async () => {
    const io = createMockIO({ getLatestGitHubReleaseTag: vi.fn(async () => null) });
    const spec: ScipInstallSpec = {
      command: 'scip-clang', languages: ['c'], method: 'github-binary',
      repo: 'sourcegraph/scip-clang', assetName: () => 'binary',
    };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No releases');
  });

  it('github-binary: returns error when no asset for platform', async () => {
    const io = createMockIO({ getPlatformArch: vi.fn(() => ({ os: 'win32', cpu: 'x64' })) });
    const specs = buildInstallSpecs(io);
    const clangSpec = specs.find((s) => s.command === 'scip-clang')!;
    const result = await installScipIndexer(clangSpec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No binary');
  });

  it('github-binary: returns error on download failure', async () => {
    const io = createMockIO({
      downloadFile: vi.fn(async () => { throw new Error('network error'); }),
      getPlatformArch: vi.fn(() => ({ os: 'linux', cpu: 'x64' })),
    });
    const specs = buildInstallSpecs(io);
    const clangSpec = specs.find((s) => s.command === 'scip-clang')!;
    const result = await installScipIndexer(clangSpec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('network error');
  });

  it('github-tarball: downloads, extracts, cleans up', async () => {
    const existsCalls: string[] = [];
    const io = createMockIO({
      getLatestGitHubReleaseTag: vi.fn(async () => 'v0.1.26'),
      getPlatformArch: vi.fn(() => ({ os: 'darwin', cpu: 'arm64' })),
      existsSync: vi.fn((p: string) => { existsCalls.push(p); return p.endsWith('scip-go'); }),
    });
    const specs = buildInstallSpecs(io);
    const goSpec = specs.find((s) => s.command === 'scip-go')!;
    const result = await installScipIndexer(goSpec, io);
    expect(result.installed).toBe(true);
    const tarCall = (io.execFileAsync as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'tar');
    expect(tarCall).toBeDefined();
    expect(tarCall![1]).toContain('xzf');
    expect(io.unlinkSync).toHaveBeenCalled();
  });

  it('manual: returns error with instructions', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'rust-analyzer', languages: ['rust'], method: 'manual', manualInstructions: 'use rustup' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Manual install');
    expect(result.error).toContain('use rustup');
  });

  it('pip: uses pip3 when available', async () => {
    const io = createMockIO({
      isCommandAvailable: vi.fn((cmd: string) => cmd === 'pip3'),
    });
    const spec: ScipInstallSpec = { command: 'scip-python', languages: ['python'], method: 'pip', packageName: 'scip-python' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(io.execFileAsync).toHaveBeenCalledWith('pip3', ['install', '--user', 'scip-python'], expect.anything());
  });

  it('pip: returns error when pip not found', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'scip-python', languages: ['python'], method: 'pip', packageName: 'scip-python' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('pip not found');
  });

  it('gem: calls gem install when available', async () => {
    const io = createMockIO({ isCommandAvailable: vi.fn((cmd: string) => cmd === 'gem') });
    const spec: ScipInstallSpec = { command: 'scip-ruby', languages: ['ruby'], method: 'gem', packageName: 'scip-ruby' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(io.execFileAsync).toHaveBeenCalledWith('gem', expect.arrayContaining(['install', 'scip-ruby']), expect.anything());
  });

  it('dotnet-tool: calls dotnet tool install when available', async () => {
    const io = createMockIO({ isCommandAvailable: vi.fn((cmd: string) => cmd === 'dotnet') });
    const spec: ScipInstallSpec = { command: 'scip-dotnet', languages: ['csharp'], method: 'dotnet-tool', packageName: 'scip-dotnet' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(io.execFileAsync).toHaveBeenCalledWith('dotnet', expect.arrayContaining(['tool', 'install', '--global', 'scip-dotnet']), expect.anything());
  });

  it('coursier: uses cs when available', async () => {
    const io = createMockIO({ isCommandAvailable: vi.fn((cmd: string) => cmd === 'cs') });
    const spec: ScipInstallSpec = { command: 'scip-java', languages: ['java'], method: 'coursier' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(io.execFileAsync).toHaveBeenCalledWith('cs', ['install', 'scip-java'], expect.anything());
  });

  it('coursier: returns error when neither cs nor coursier found', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'scip-java', languages: ['java'], method: 'coursier' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Coursier not found');
  });

  it('unknown method: returns error', async () => {
    const io = createMockIO();
    const spec = { command: 'x', languages: ['x'], method: 'unknown' as 'manual' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Unknown install method');
  });
});

// ─── installAllMissing ────────────────────────────────────────────────────────

describe('installAllMissing', () => {
  it('skips commands already available', async () => {
    const io = createMockIO({
      isCommandAvailable: vi.fn(() => true),
      findNpmBinPath: vi.fn(() => '/usr/bin/scip-typescript'),
    });
    const results = await installAllMissing({ quiet: true, io });
    for (const r of results) {
      expect(r.installed).toBe(true);
    }
  });

  it('filters by language', async () => {
    const io = createMockIO({
      findNpmBinPath: vi.fn(() => '/path/to/bin'),
    });
    const results = await installAllMissing({ languages: ['typescript'], quiet: true, io });
    expect(results.length).toBe(1);
    expect(results[0]!.command).toBe('scip-typescript');
  });

  it('deduplicates commands', async () => {
    const io = createMockIO({ isCommandAvailable: vi.fn(() => true) });
    const results = await installAllMissing({ quiet: true, io });
    const commands = results.map((r) => r.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});

// ─── createDefaultIO ──────────────────────────────────────────────────────────

describe('createDefaultIO', () => {
  it('returns an object with all InstallerIO methods', () => {
    const io = createDefaultIO();
    expect(typeof io.existsSync).toBe('function');
    expect(typeof io.mkdirSync).toBe('function');
    expect(typeof io.chmodSync).toBe('function');
    expect(typeof io.downloadFile).toBe('function');
    expect(typeof io.execFileAsync).toBe('function');
    expect(typeof io.isCommandAvailable).toBe('function');
    expect(typeof io.findNpmBinPath).toBe('function');
    expect(typeof io.getLatestGitHubReleaseTag).toBe('function');
    expect(typeof io.unlinkSync).toBe('function');
    expect(typeof io.getPlatformArch).toBe('function');
    expect(typeof io.getLoreBinDir).toBe('function');
  });

  it('getPlatformArch returns os and cpu strings', () => {
    const io = createDefaultIO();
    const { os, cpu } = io.getPlatformArch();
    expect(typeof os).toBe('string');
    expect(typeof cpu).toBe('string');
    expect(os.length).toBeGreaterThan(0);
    expect(cpu.length).toBeGreaterThan(0);
  });

  it('getLoreBinDir returns a path containing .lore/bin', () => {
    const io = createDefaultIO();
    expect(io.getLoreBinDir()).toContain('.lore');
  });

  it('isCommandAvailable returns boolean for known command', () => {
    const io = createDefaultIO();
    // node should always be available
    expect(typeof io.isCommandAvailable('node')).toBe('boolean');
    expect(io.isCommandAvailable('node')).toBe(true);
    // random gibberish should not be
    expect(io.isCommandAvailable('__nonexistent_cmd_xyz__')).toBe(false);
  });

  it('findNpmBinPath returns string or null', () => {
    const io = createDefaultIO();
    // scip-typescript is a bundled dep
    const result = io.findNpmBinPath('scip-typescript');
    // It may or may not be found depending on the environment, but should be string|null
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('existsSync delegates to fs.existsSync', () => {
    const io = createDefaultIO();
    expect(io.existsSync('/definitely/does/not/exist/abc123')).toBe(false);
  });
});

// ─── Additional edge-case tests ───────────────────────────────────────────────

describe('installScipIndexer edge cases', () => {
  it('github-binary: missing repo config', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'github-binary' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Missing repo');
  });

  it('github-tarball: missing repo config', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'github-tarball' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Missing repo');
  });

  it('github-tarball: returns false when extracted binary not found', async () => {
    const io = createMockIO({
      getPlatformArch: vi.fn(() => ({ os: 'linux', cpu: 'x64' })),
      // existsSync always returns false (binary not found after extraction)
      existsSync: vi.fn(() => false),
    });
    const spec: ScipInstallSpec = {
      command: 'scip-go', languages: ['go'], method: 'github-tarball',
      repo: 'sourcegraph/scip-go', assetName: () => 'scip-go.tar.gz',
    };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.path).toBeNull();
  });

  it('github-tarball: no release found', async () => {
    const io = createMockIO({ getLatestGitHubReleaseTag: vi.fn(async () => null) });
    const spec: ScipInstallSpec = {
      command: 'scip-go', languages: ['go'], method: 'github-tarball',
      repo: 'sourcegraph/scip-go', assetName: () => 'x.tar.gz',
    };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No releases');
  });

  it('github-tarball: no asset for platform', async () => {
    const io = createMockIO({ getPlatformArch: vi.fn(() => ({ os: 'freebsd', cpu: 'mips' })) });
    const specs = buildInstallSpecs(io);
    const goSpec = specs.find((s) => s.command === 'scip-go')!;
    const result = await installScipIndexer(goSpec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No binary');
  });

  it('github-tarball: download failure', async () => {
    const io = createMockIO({
      getPlatformArch: vi.fn(() => ({ os: 'linux', cpu: 'x64' })),
      downloadFile: vi.fn(async () => { throw new Error('timeout'); }),
    });
    const specs = buildInstallSpecs(io);
    const goSpec = specs.find((s) => s.command === 'scip-go')!;
    const result = await installScipIndexer(goSpec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('timeout');
  });

  it('pip: missing packageName', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'pip' };
    const result = await installScipIndexer(spec, io);
    expect(result.error).toContain('Missing pip');
  });

  it('pip: exec failure', async () => {
    const io = createMockIO({
      isCommandAvailable: vi.fn((cmd: string) => cmd === 'pip3'),
      execFileAsync: vi.fn(async () => { throw new Error('pip failed'); }),
    });
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'pip', packageName: 'pkg' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('pip failed');
  });

  it('pip: falls back to pip when pip3 not available', async () => {
    const io = createMockIO({
      isCommandAvailable: vi.fn((cmd: string) => cmd === 'pip'),
    });
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'pip', packageName: 'pkg' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(io.execFileAsync).toHaveBeenCalledWith('pip', expect.anything(), expect.anything());
  });

  it('gem: missing packageName', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'gem' };
    const result = await installScipIndexer(spec, io);
    expect(result.error).toContain('Missing gem');
  });

  it('gem: exec failure', async () => {
    const io = createMockIO({
      isCommandAvailable: vi.fn((cmd: string) => cmd === 'gem'),
      execFileAsync: vi.fn(async () => { throw new Error('gem failed'); }),
    });
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'gem', packageName: 'pkg' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('gem failed');
  });

  it('gem: not available', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'gem', packageName: 'pkg' };
    const result = await installScipIndexer(spec, io);
    expect(result.error).toContain('gem not found');
  });

  it('dotnet-tool: missing packageName', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'dotnet-tool' };
    const result = await installScipIndexer(spec, io);
    expect(result.error).toContain('Missing dotnet');
  });

  it('dotnet-tool: exec failure', async () => {
    const io = createMockIO({
      isCommandAvailable: vi.fn((cmd: string) => cmd === 'dotnet'),
      execFileAsync: vi.fn(async () => { throw new Error('dotnet err'); }),
    });
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'dotnet-tool', packageName: 'pkg' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('dotnet err');
  });

  it('dotnet-tool: not available', async () => {
    const io = createMockIO();
    const spec: ScipInstallSpec = { command: 'x', languages: ['x'], method: 'dotnet-tool', packageName: 'pkg' };
    const result = await installScipIndexer(spec, io);
    expect(result.error).toContain('dotnet not found');
  });

  it('coursier: uses coursier when cs not available', async () => {
    const io = createMockIO({ isCommandAvailable: vi.fn((cmd: string) => cmd === 'coursier') });
    const spec: ScipInstallSpec = { command: 'scip-java', languages: ['java'], method: 'coursier' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(io.execFileAsync).toHaveBeenCalledWith('coursier', expect.anything(), expect.anything());
  });

  it('coursier: exec failure', async () => {
    const io = createMockIO({
      isCommandAvailable: vi.fn((cmd: string) => cmd === 'cs'),
      execFileAsync: vi.fn(async () => { throw new Error('cs err'); }),
    });
    const spec: ScipInstallSpec = { command: 'scip-java', languages: ['java'], method: 'coursier' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toBe('cs err');
  });

  it('npm-bundled: catches exceptions', async () => {
    const io = createMockIO({
      findNpmBinPath: vi.fn(() => { throw new Error('npm error'); }),
    });
    const spec: ScipInstallSpec = { command: 'scip-typescript', languages: ['typescript'], method: 'npm-bundled' };
    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Failed to resolve');
  });
});

// ─── installAllMissing verbose logging ────────────────────────────────────────

describe('installAllMissing logging', () => {
  it('logs when not quiet', async () => {
    const io = createMockIO({
      findNpmBinPath: vi.fn(() => '/path/to/bin'),
    });
    // Not quiet: should not throw
    const results = await installAllMissing({ languages: ['typescript'], io });
    expect(results[0]!.installed).toBe(true);
  });

  it('logs failed installs when not quiet', async () => {
    const io = createMockIO();
    const results = await installAllMissing({ languages: ['rust'], io });
    expect(results[0]!.installed).toBe(false);
  });
});
