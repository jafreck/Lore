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

  it('non-quiet mode runs without error', async () => {
    const io = mockIO({
      isCommandAvailable: () => true,
    });

    // Should not throw even when quiet=false
    const results = await installAllMissing({ io, quiet: false });
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── Additional coverage: install methods ──────────────────────────────────────

describe('installScipIndexer edge cases', () => {
  it('handles github-binary with missing repo config', async () => {
    const spec: ScipInstallSpec = {
      command: 'test-missing',
      languages: ['c'],
      method: 'github-binary',
      // no repo or assetName
    };
    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Missing repo');
  });

  it('handles github-tarball with no releases', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-go',
      languages: ['go'],
      method: 'github-tarball',
      repo: 'sourcegraph/scip-go',
      assetName: () => 'asset.tar.gz',
    };
    const io = mockIO({ getLatestGitHubReleaseTag: async () => null });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No releases found');
  });

  it('handles github-tarball with null asset name', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-go',
      languages: ['go'],
      method: 'github-tarball',
      repo: 'sourcegraph/scip-go',
      assetName: () => null,
    };

    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('No binary available');
  });

  it('handles github-tarball with download error', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-go',
      languages: ['go'],
      method: 'github-tarball',
      repo: 'sourcegraph/scip-go',
      assetName: () => 'scip-go.tar.gz',
    };
    const io = mockIO({
      downloadFile: async () => { throw new Error('network error'); },
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('network error');
  });

  it('handles github-tarball with missing repo config', async () => {
    const spec: ScipInstallSpec = {
      command: 'test-tar',
      languages: ['go'],
      method: 'github-tarball',
      // no repo or assetName
    };
    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Missing repo');
  });

  it('handles github-tarball successful install when binary exists after extraction', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-go',
      languages: ['go'],
      method: 'github-tarball',
      repo: 'sourcegraph/scip-go',
      assetName: () => 'scip-go.tar.gz',
    };
    const io = mockIO({
      existsSync: () => true,
      downloadFile: async () => {},
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(true);
    expect(result.path).toContain('scip-go');
  });

  it('handles github-binary with download error', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-clang',
      languages: ['c'],
      method: 'github-binary',
      repo: 'sourcegraph/scip-clang',
      assetName: () => 'scip-clang-linux',
    };
    const io = mockIO({
      downloadFile: async () => { throw new Error('connection refused'); },
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('connection refused');
  });

  it('handles pip when pip not available', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-python',
      languages: ['python'],
      method: 'pip',
      packageName: 'scip-python',
    };
    const io = mockIO({ isCommandAvailable: () => false });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('pip not found');
  });

  it('handles pip with install error', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-python',
      languages: ['python'],
      method: 'pip',
      packageName: 'scip-python',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'pip',
      execFileAsync: async () => { throw new Error('pip install failed'); },
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('pip install failed');
  });

  it('handles pip with missing package name', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-python',
      languages: ['python'],
      method: 'pip',
      // no packageName
    };
    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Missing pip package');
  });

  it('handles gem when gem not available', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-ruby',
      languages: ['ruby'],
      method: 'gem',
      packageName: 'scip-ruby',
    };
    const io = mockIO({ isCommandAvailable: () => false });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('gem not found');
  });

  it('handles gem with install error', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-ruby',
      languages: ['ruby'],
      method: 'gem',
      packageName: 'scip-ruby',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'gem',
      execFileAsync: async () => { throw new Error('gem fail'); },
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('gem fail');
  });

  it('handles gem with missing package name', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-ruby',
      languages: ['ruby'],
      method: 'gem',
      // no packageName
    };
    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Missing gem package');
  });

  it('handles dotnet-tool with install error', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-dotnet',
      languages: ['csharp'],
      method: 'dotnet-tool',
      packageName: 'scip-dotnet',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'dotnet',
      execFileAsync: async () => { throw new Error('dotnet fail'); },
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('dotnet fail');
  });

  it('handles dotnet-tool with missing package name', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-dotnet',
      languages: ['csharp'],
      method: 'dotnet-tool',
      // no packageName
    };
    const result = await installScipIndexer(spec, mockIO());
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Missing dotnet package');
  });

  it('handles coursier when not available', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-java',
      languages: ['java'],
      method: 'coursier',
    };
    const io = mockIO({ isCommandAvailable: () => false });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Coursier not found');
  });

  it('handles coursier with install error', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-java',
      languages: ['java'],
      method: 'coursier',
    };
    const io = mockIO({
      isCommandAvailable: (cmd) => cmd === 'cs',
      execFileAsync: async () => { throw new Error('coursier crash'); },
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('coursier crash');
  });

  it('handles npm-bundled with findNpmBinPath throwing', async () => {
    const spec: ScipInstallSpec = {
      command: 'scip-typescript',
      languages: ['typescript'],
      method: 'npm-bundled',
    };
    const io = mockIO({
      findNpmBinPath: () => { throw new Error('npm lookup error'); },
    });

    const result = await installScipIndexer(spec, io);
    expect(result.installed).toBe(false);
    expect(result.error).toContain('Failed to resolve');
  });
});

// ─── buildInstallSpecs platform-specific ──────────────────────────────────────

describe('buildInstallSpecs platform variants', () => {
  it('scip-go asset name for darwin arm64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'darwin', cpu: 'arm64' }) });
    const goSpec = specs.find((s) => s.command === 'scip-go');
    const asset = goSpec!.assetName?.('v0.5.0');
    expect(asset).toContain('darwin');
    expect(asset).toContain('arm64');
  });

  it('scip-go asset name for linux x64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'linux', cpu: 'x64' }) });
    const goSpec = specs.find((s) => s.command === 'scip-go');
    const asset = goSpec!.assetName?.('v0.5.0');
    expect(asset).toContain('linux');
    expect(asset).toContain('amd64');
  });

  it('scip-go returns null for unsupported platform', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'aix', cpu: 'ppc' }) });
    const goSpec = specs.find((s) => s.command === 'scip-go');
    const asset = goSpec!.assetName?.('v0.5.0');
    expect(asset).toBeNull();
  });

  it('scip-ruby asset name for darwin arm64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'darwin', cpu: 'arm64' }) });
    const rubySpec = specs.find((s) => s.command === 'scip-ruby');
    const asset = rubySpec!.assetName?.('v1.0.0');
    expect(asset).toBe('scip-ruby-arm64-darwin');
  });

  it('scip-ruby asset name for linux x64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'linux', cpu: 'x64' }) });
    const rubySpec = specs.find((s) => s.command === 'scip-ruby');
    const asset = rubySpec!.assetName?.('v1.0.0');
    expect(asset).toBe('scip-ruby-x86_64-linux');
  });

  it('scip-ruby returns null for unsupported platform', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'win32', cpu: 'arm64' }) });
    const rubySpec = specs.find((s) => s.command === 'scip-ruby');
    const asset = rubySpec!.assetName?.('v1.0.0');
    expect(asset).toBeNull();
  });

  it('scip-clang for linux x64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'linux', cpu: 'x64' }) });
    const clang = specs.find((s) => s.command === 'scip-clang');
    const asset = clang!.assetName?.('v1.0.0');
    expect(asset).toBe('scip-clang-x86_64-linux');
  });

  it('scip-go windows x64', () => {
    const specs = buildInstallSpecs({ getPlatformArch: () => ({ os: 'win32', cpu: 'x64' }) });
    const goSpec = specs.find((s) => s.command === 'scip-go');
    const asset = goSpec!.assetName?.('v0.5.0');
    expect(asset).toContain('windows');
    expect(asset).toContain('amd64');
  });
});

// ─── getSpecsForLanguage coverage ──────────────────────────────────────────────

describe('getSpecsForLanguage full coverage', () => {
  it('returns specs for c', () => {
    const specs = getSpecsForLanguage('c');
    expect(specs.length).toBeGreaterThanOrEqual(1);
    expect(specs[0]!.command).toBe('scip-clang');
  });

  it('returns specs for cpp', () => {
    const specs = getSpecsForLanguage('cpp');
    expect(specs.length).toBeGreaterThanOrEqual(1);
    expect(specs[0]!.command).toBe('scip-clang');
  });

  it('returns specs for go', () => {
    const specs = getSpecsForLanguage('go');
    expect(specs.length).toBe(1);
    expect(specs[0]!.command).toBe('scip-go');
  });

  it('returns specs for ruby', () => {
    const specs = getSpecsForLanguage('ruby');
    expect(specs.length).toBe(1);
    expect(specs[0]!.command).toBe('scip-ruby');
  });

  it('returns specs for csharp', () => {
    const specs = getSpecsForLanguage('csharp');
    expect(specs.length).toBe(1);
    expect(specs[0]!.command).toBe('scip-dotnet');
  });

  it('returns specs for rust', () => {
    const specs = getSpecsForLanguage('rust');
    expect(specs.length).toBe(1);
    expect(specs[0]!.command).toBe('rust-analyzer');
  });

  it('returns specs for scala', () => {
    const specs = getSpecsForLanguage('scala');
    expect(specs.length).toBeGreaterThanOrEqual(1);
    expect(specs[0]!.command).toBe('scip-java');
  });

  it('returns specs for php', () => {
    const specs = getSpecsForLanguage('php');
    expect(specs.length).toBe(1);
    expect(specs[0]!.command).toBe('scip-php');
  });

  it('returns specs for dart', () => {
    const specs = getSpecsForLanguage('dart');
    expect(specs.length).toBe(1);
    expect(specs[0]!.command).toBe('scip-dart');
  });
});
