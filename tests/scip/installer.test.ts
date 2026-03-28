import { describe, it, expect } from 'vitest';
import {
  getSpecsForLanguage,
  getSpecForCommand,
  buildInstallSpecs,
  installScipIndexer,
  installAllMissing,
  SCIP_INSTALL_SPECS,
  type InstallerIO,
  type ScipInstallSpec,
} from '../../src/scip/installer.js';

// ─── Mock IO ──────────────────────────────────────────────────────────────────

function mockIO(overrides: Partial<InstallerIO> = {}): InstallerIO {
  return {
    existsSync: () => false,
    mkdirSync: () => {},
    chmodSync: () => {},
    downloadFile: async () => {},
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    isCommandAvailable: () => false,
    findNpmBinPath: () => null,
    getLatestGitHubReleaseTag: async () => 'v1.0.0',
    unlinkSync: () => {},
    getPlatformArch: () => ({ os: 'linux', cpu: 'x64' }),
    getLoreBinDir: () => '/tmp/lore-test-bin',
    ...overrides,
  };
}

// ─── SCIP_INSTALL_SPECS ────────────────────────────────────────────────────────

describe('SCIP_INSTALL_SPECS', () => {
  it('covers all expected languages', () => {
    const allLangs = new Set(SCIP_INSTALL_SPECS.flatMap((s) => s.languages));
    expect(allLangs.has('typescript')).toBe(true);
    expect(allLangs.has('python')).toBe(true);
    expect(allLangs.has('java')).toBe(true);
    expect(allLangs.has('rust')).toBe(true);
    expect(allLangs.has('go')).toBe(true);
    expect(allLangs.has('c')).toBe(true);
    expect(allLangs.has('cpp')).toBe(true);
  });

  it('each spec has a command and method', () => {
    for (const spec of SCIP_INSTALL_SPECS) {
      expect(typeof spec.command).toBe('string');
      expect(spec.command.length).toBeGreaterThan(0);
      expect(typeof spec.method).toBe('string');
      expect(spec.languages.length).toBeGreaterThan(0);
    }
  });
});

// ─── getSpecsForLanguage ──────────────────────────────────────────────────────

describe('getSpecsForLanguage', () => {
  it('returns specs for typescript', () => {
    const specs = getSpecsForLanguage('typescript');
    expect(specs.length).toBeGreaterThanOrEqual(1);
    expect(specs[0]!.languages).toContain('typescript');
  });

  it('returns specs for python', () => {
    const specs = getSpecsForLanguage('python');
    expect(specs.length).toBe(1);
    expect(specs[0]!.command).toBe('scip-python');
  });

  it('returns specs for java (shared with kotlin/scala)', () => {
    const javaSpecs = getSpecsForLanguage('java');
    const kotlinSpecs = getSpecsForLanguage('kotlin');
    expect(javaSpecs.length).toBeGreaterThanOrEqual(1);
    expect(kotlinSpecs.length).toBeGreaterThanOrEqual(1);
    // They should share the same spec (scip-java)
    expect(javaSpecs[0]!.command).toBe(kotlinSpecs[0]!.command);
  });

  it('returns empty for unsupported language', () => {
    const specs = getSpecsForLanguage('brainfuck');
    expect(specs).toEqual([]);
  });
});

// ─── getSpecForCommand ────────────────────────────────────────────────────────

describe('getSpecForCommand', () => {
  it('finds spec by command name', () => {
    const spec = getSpecForCommand('scip-typescript');
    expect(spec).toBeDefined();
    expect(spec!.command).toBe('scip-typescript');
  });

  it('returns undefined for unknown command', () => {
    expect(getSpecForCommand('not-a-real-command')).toBeUndefined();
  });
});

// ─── buildInstallSpecs ────────────────────────────────────────────────────────

describe('buildInstallSpecs', () => {
  it('returns an array of install specs', () => {
    const specs = buildInstallSpecs();
    expect(Array.isArray(specs)).toBe(true);
    expect(specs.length).toBeGreaterThan(0);
  });

  it('platform-specific asset names for scip-clang', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'darwin', cpu: 'arm64' }) });
    const clang = specs.find((s) => s.command === 'scip-clang');
    expect(clang).toBeDefined();
    const asset = clang!.assetName?.('v1.0.0');
    expect(asset).toBe('scip-clang-arm64-darwin');
  });

  it('returns null asset for unsupported platform', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'freebsd', cpu: 'arm' }) });
    const clang = specs.find((s) => s.command === 'scip-clang');
    const asset = clang!.assetName?.('v1.0.0');
    expect(asset).toBeNull();
  });
});

// ─── installScipIndexer ───────────────────────────────────────────────────────

describe('installScipIndexer', () => {
  it('installs npm-bundled when found in node_modules', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-typescript',
      languages: ['typescript'],
      method: 'npm-bundled',
    };
    const io = mockIO({
      findNpmBinPath: (cmd) => (cmd === 'scip-typescript' ? '/usr/local/bin/scip-typescript' : null),
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(result.path).toBe('/usr/local/bin/scip-typescript');
  });

  it('returns error for npm-bundled when not found', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-typescript',
      languages: ['typescript'],
      method: 'npm-bundled',
    };
    const io = mockIO({ findNpmBinPath: () => null });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('installs github-binary by downloading', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-clang',
      languages: ['c', 'cpp'],
      method: 'github-binary',
      repo: 'sourcegraph/scip-clang',
      assetName: () => 'scip-clang-x86_64-linux',
    };
    const downloadCalled: string[] = [];
    const io = mockIO({
      downloadFile: async (url) => { downloadCalled.push(url); },
      existsSync: () => true,
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(downloadCalled.length).toBe(1);
    expect(downloadCalled[0]).toContain('scip-clang-x86_64-linux');
  });

  it('returns manual instruction for manual method', async () => {
    const spec: ScipInstallSpec = {
      command: 'rust-analyzer',
      languages: ['rust'],
      method: 'manual',
      manualInstructions: 'Install via rustup',
    };

    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Manual install required');
    expect(result.error).toContain('Install via rustup');
  });

  it('returns error for unknown method', async () => {
    const spec = {
      command: 'test',
      languages: ['test'],
      method: 'unknown-method' as 'manual',
    };

    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
  });

  it('handles github-binary with no releases', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-clang',
      languages: ['c'],
      method: 'github-binary',
      repo: 'sourcegraph/scip-clang',
      assetName: () => 'asset',
    };
    const io = mockIO({ getLatestGitHubReleaseTag: async () => null });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No releases found');
  });

  it('handles github-binary with null asset name', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-clang',
      languages: ['c'],
      method: 'github-binary',
      repo: 'sourcegraph/scip-clang',
      assetName: () => null,
    };

    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No binary available');
  });

  it('installs via dotnet tool', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-dotnet',
      languages: ['csharp'],
      method: 'dotnet-tool',
      packageName: 'scip-dotnet',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'dotnet',
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
  });

  it('returns error when dotnet not available', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-dotnet',
      languages: ['csharp'],
      method: 'dotnet-tool',
      packageName: 'scip-dotnet',
    };

    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('dotnet not found');
  });

  it('installs via coursier', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-java',
      languages: ['java'],
      method: 'coursier',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'cs',
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
  });

  it('installs via pip', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-python',
      languages: ['python'],
      method: 'pip',
      packageName: 'scip-python',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'pip3',
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
  });

  it('installs via gem', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-ruby',
      languages: ['ruby'],
      method: 'gem',
      packageName: 'scip-ruby',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'gem',
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
  });
});

// ─── installAllMissing ────────────────────────────────────────────────────────

describe('installAllMissing', () => {
  it('skips commands that are already available', async () => {
    const io = mockIO({
      isCommandAvailable: () => true,
    });

    const results = await installAllMissing({ io, quiet: true });
    for (const r of results) {
      expect(r.installed).toBe(true);
    }
  });

  it('filters by language when specified', async () => {
    const installed: string[] = [];
    const io = mockIO({
      isCommandAvailable: () => false,
      findNpmBinPath: (cmd) => {
        installed.push(cmd);
        return `/bin/${cmd}`;
      },
    });

    const results = await installAllMissing({ languages: ['typescript'], io, quiet: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(installed).toContain('scip-typescript');
  });

  it('deduplicates commands', async () => {
    const installAttempts: string[] = [];
    const io = mockIO({
      isCommandAvailable: (cmd) => {
        installAttempts.push(cmd);
        return true;
      },
    });

    await installAllMissing({ io, quiet: true });
    // scip-java handles java/scala/kotlin but should only be checked once
    const javaCheckCount = installAttempts.filter((c) => c === 'scip-java').length;
    expect(javaCheckCount).toBe(1);
  });
});
