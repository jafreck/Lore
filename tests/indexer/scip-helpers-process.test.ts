import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectProjectLanguages,
  createLoreScipTsconfig,
  loadScipIndexes,
  type ScipIndexLoadDiagnostics,
  type ScipProcessIO,
} from '../../src/indexer/stages/scip-helpers/process.js';
import type { EffectiveScipSettings } from '../../src/scip/config.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-test-process-'));
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true }); } catch { /* ok */ }
  }
  dirs.length = 0;
});

describe('detectProjectLanguages', () => {
  it('detects typescript from package.json', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('typescript')).toBe(true);
  });

  it('uses the supplied effective registry language set', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'module.hs'), 'main = pure ()');
    const langs = detectProjectLanguages(dir, new Set(['haskell']));
    expect(langs).toEqual(new Set(['haskell']));
  });

  it('detects typescript from tsconfig.json', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('typescript')).toBe(true);
  });

  it('detects python from pyproject.toml', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('python')).toBe(true);
  });

  it('detects python from requirements.txt', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'requirements.txt'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('python')).toBe(true);
  });

  it('detects python from setup.py', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'setup.py'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('python')).toBe(true);
  });

  it('detects java from pom.xml', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pom.xml'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('java')).toBe(true);
  });

  it('detects java from build.gradle', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'build.gradle'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('java')).toBe(true);
  });

  it('detects java from build.gradle.kts', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'build.gradle.kts'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('java')).toBe(true);
  });

  it('detects rust from Cargo.toml', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('rust')).toBe(true);
  });

  it('detects go from go.mod', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'go.mod'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('go')).toBe(true);
  });

  it('detects c from Makefile', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'Makefile'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('c')).toBe(true);
  });

  it('detects c from CMakeLists.txt', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('c')).toBe(true);
  });

  it('detects cpp from CMakeLists.txt', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('cpp')).toBe(true);
  });

  it('detects ruby from Gemfile', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'Gemfile'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('ruby')).toBe(true);
  });

  it('detects php from composer.json', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('php')).toBe(true);
  });

  it('detects dart from pubspec.yaml', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'pubspec.yaml'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('dart')).toBe(true);
  });

  it('detects language from file extensions in root dir', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'main.py'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('python')).toBe(true);
  });

  it('classifies uppercase .C source files as C++', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'legacy.C'), 'int main() { return 0; }');
    const languages = detectProjectLanguages(dir);
    expect(languages.has('cpp')).toBe(true);
    expect(languages.has('c')).toBe(false);
  });

  it('detects language from extensions in subdirectory (one level deep)', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const subDir = path.join(dir, 'src');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'main.rs'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('rust')).toBe(true);
  });

  it('detects multiple languages', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('typescript')).toBe(true);
    expect(langs.has('rust')).toBe(true);
  });

  it('returns empty set for empty directory', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const langs = detectProjectLanguages(dir);
    expect(langs.size).toBe(0);
  });

  it('skips node_modules and dot-directories', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const nmDir = path.join(dir, 'node_modules');
    fs.mkdirSync(nmDir);
    fs.writeFileSync(path.join(nmDir, 'something.py'), '');
    const dotDir = path.join(dir, '.hidden');
    fs.mkdirSync(dotDir);
    fs.writeFileSync(path.join(dotDir, 'file.rs'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('python')).toBe(false);
    expect(langs.has('rust')).toBe(false);
  });

  it('handles non-existent directory gracefully', () => {
    const langs = detectProjectLanguages('/tmp/non-existent-dir-12345');
    expect(langs.size).toBe(0);
  });
});

describe('createLoreScipTsconfig', () => {
  it('returns null if no tsconfig.json exists', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    expect(createLoreScipTsconfig(dir)).toBeNull();
  });

  it('creates a temp tsconfig from existing tsconfig.json', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, outDir: './dist', rootDir: './src' },
      exclude: ['node_modules', 'dist'],
    }));

    const result = createLoreScipTsconfig(dir);
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);

    const content = JSON.parse(fs.readFileSync(result!, 'utf8'));
    // Should strip build-only fields
    expect(content.compilerOptions.outDir).toBeUndefined();
    expect(content.compilerOptions.rootDir).toBeUndefined();
    // Should keep type-checking fields
    expect(content.compilerOptions.strict).toBe(true);
    // Should have include globs
    expect(content.include).toBeDefined();
    expect(content.include.length).toBe(2);

    // Cleanup
    try { fs.unlinkSync(result!); } catch { /* ok */ }
  });

  it('handles invalid JSON in tsconfig gracefully', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), 'not valid json');
    expect(createLoreScipTsconfig(dir)).toBeNull();
  });

  it('handles tsconfig with no compilerOptions', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ exclude: ['dist'] }));
    const result = createLoreScipTsconfig(dir);
    expect(result).not.toBeNull();
    const content = JSON.parse(fs.readFileSync(result!, 'utf8'));
    expect(content.compilerOptions).toBeDefined();
    try { fs.unlinkSync(result!); } catch { /* ok */ }
  });

  it('strips all build-only fields', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        outDir: './dist',
        rootDir: './src',
        declaration: true,
        declarationMap: true,
        declarationDir: './types',
        sourceMap: true,
        inlineSourceMap: false,
        inlineSources: false,
        composite: true,
        tsBuildInfoFile: '.tsbuildinfo',
        emitDeclarationOnly: true,
      },
    }));

    const result = createLoreScipTsconfig(dir);
    expect(result).not.toBeNull();
    const content = JSON.parse(fs.readFileSync(result!, 'utf8'));
    expect(content.compilerOptions.outDir).toBeUndefined();
    expect(content.compilerOptions.rootDir).toBeUndefined();
    expect(content.compilerOptions.declaration).toBeUndefined();
    expect(content.compilerOptions.declarationMap).toBeUndefined();
    expect(content.compilerOptions.sourceMap).toBeUndefined();
    expect(content.compilerOptions.composite).toBeUndefined();
    expect(content.compilerOptions.tsBuildInfoFile).toBeUndefined();
    expect(content.compilerOptions.emitDeclarationOnly).toBeUndefined();
    // Should keep strict
    expect(content.compilerOptions.strict).toBe(true);
    try { fs.unlinkSync(result!); } catch { /* ok */ }
  });

  it('preserves paths and baseUrl options', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, paths: { "@/*": ["src/*"] }, baseUrl: "." },
    }));
    const result = createLoreScipTsconfig(dir);
    expect(result).not.toBeNull();
    const content = JSON.parse(fs.readFileSync(result!, 'utf8'));
    expect(content.compilerOptions.strict).toBe(true);
    expect(content.compilerOptions.paths).toEqual({ "@/*": ["src/*"] });
    expect(content.compilerOptions.baseUrl).toBe(".");
    try { fs.unlinkSync(result!); } catch { /* ok */ }
  });

  it('uses absolute paths in include globs', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    const result = createLoreScipTsconfig(dir);
    expect(result).not.toBeNull();
    const content = JSON.parse(fs.readFileSync(result!, 'utf8'));
    for (const inc of content.include) {
      expect(path.isAbsolute(inc)).toBe(true);
    }
    try { fs.unlinkSync(result!); } catch { /* ok */ }
  });

  it('uses absolute paths in exclude globs', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      exclude: ['node_modules', 'dist'],
    }));
    const result = createLoreScipTsconfig(dir);
    expect(result).not.toBeNull();
    const content = JSON.parse(fs.readFileSync(result!, 'utf8'));
    for (const exc of content.exclude) {
      expect(path.isAbsolute(exc)).toBe(true);
    }
    try { fs.unlinkSync(result!); } catch { /* ok */ }
  });
});

// ─── loadScipIndexes ────────────────────────────────────────────────────────

function mockIO(overrides: Partial<ScipProcessIO> = {}): ScipProcessIO {
  return {
    existsSync: () => false,
    readFileSync: () => new Uint8Array(),
    unlinkSync: () => {},
    execFile: async () => {},
    installScipIndexer: async () => ({ installed: false }),
    ensureCompilationDatabase: async () => ({ path: null }),
    ...overrides,
  };
}

function baseSettings(overrides: Partial<EffectiveScipSettings> = {}): EffectiveScipSettings {
  return {
    enabled: true,
    timeoutMs: 30_000,
    allowIndexerExecution: true,
    allowBuildExecution: false,
    allowAutoInstall: false,
    allowedCwdRoots: [],
    indexers: {},
    indexDir: null,
    ...overrides,
  };
}

describe('loadScipIndexes', () => {
  it('loads pre-computed index.scip from indexDir', async () => {
    const indexData = new Uint8Array([1, 2, 3, 4]);
    const io = mockIO({
      existsSync: (p) => p.endsWith('index.scip'),
      readFileSync: () => indexData,
    });
    const settings = baseSettings({
      indexDir: '.scip',
      allowIndexerExecution: false,
      allowBuildExecution: false,
      allowAutoInstall: false,
    });
    const result = await loadScipIndexes(settings, '/fake/root', null, io);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(indexData);
  });

  it('loads per-language index files when staleLanguages provided', async () => {
    const tsData = new Uint8Array([10, 20]);
    const io = mockIO({
      existsSync: (p) => p.endsWith('typescript.scip'),
      readFileSync: () => tsData,
    });
    const settings = baseSettings({ indexDir: '.scip' });
    const result = await loadScipIndexes(settings, '/fake/root', new Set(['typescript']), io);
    expect(result).toEqual([tsData]);
  });

  it('falls through to indexer when indexDir has no files', async () => {
    const io = mockIO({
      existsSync: () => false,
    });
    const settings = baseSettings({ indexDir: '.scip' });
    const result = await loadScipIndexes(settings, '/fake/root', null, io);
    expect(result).toEqual([]);
  });

  it('returns empty when no pre-computed and no available indexers', async () => {
    const io = mockIO();
    const settings = baseSettings();
    const result = await loadScipIndexes(settings, '/fake/root', null, io);
    expect(result).toEqual([]);
  });

  it('returns empty when no indexDir and no indexers configured', async () => {
    const io = mockIO();
    const settings = baseSettings({ indexDir: null, indexers: {} });
    const result = await loadScipIndexes(settings, '/fake/root', new Set(['python']), io);
    expect(result).toEqual([]);
  });

  it('loads multiple pre-computed language indexes', async () => {
    const tsData = new Uint8Array([1]);
    const pyData = new Uint8Array([2]);
    const io = mockIO({
      existsSync: (p) => p.endsWith('typescript.scip') || p.endsWith('python.scip'),
      readFileSync: (p) => p.endsWith('typescript.scip') ? tsData : pyData,
    });
    const settings = baseSettings({ indexDir: '.scip' });
    const result = await loadScipIndexes(settings, '/fake/root', null, io);
    expect(result).toHaveLength(2);
  });

  it.each([false, true])('forwards allowBuildExecution=%s to compdb setup', async allowBuildExecution => {
    let receivedPermission: boolean | undefined;
    const io = mockIO({
      ensureCompilationDatabase: async (_rootDir, _timeoutMs, allowed) => {
        receivedPermission = allowed;
        return { path: null };
      },
    });
    const settings = baseSettings({
      allowBuildExecution,
      indexers: {
        c: {
          command: process.execPath,
          args: ['--compdb-path={compdb}', '--index-output-path={output}'],
        },
      },
    });

    await loadScipIndexes(settings, os.tmpdir(), new Set(['c']), io);
    expect(receivedPermission).toBe(allowBuildExecution);
  });

  it('honors an explicit C/C++ timeout exactly', async () => {
    let compdbTimeout: number | undefined;
    let indexerTimeout: number | undefined;
    const settings = baseSettings({
      timeoutMs: 1_234,
      indexers: {
        cpp: {
          command: process.execPath,
          args: ['--compdb-path={compdb}', '--index-output-path={output}'],
        },
      },
    });
    await loadScipIndexes(settings, os.tmpdir(), new Set(['cpp']), mockIO({
      ensureCompilationDatabase: async (_root, timeout) => {
        compdbTimeout = timeout;
        return { path: '/tmp/compile_commands.json' };
      },
      execFile: async (_command, _args, options) => { indexerTimeout = options.timeout; },
    }));
    expect(compdbTimeout).toBe(1_234);
    expect(indexerTimeout).toBe(1_234);
  });

  it('uses the larger C/C++ timeout only when the configured value is the default', async () => {
    let indexerTimeout: number | undefined;
    const settings = baseSettings({
      timeoutMs: 120_000,
      timeoutMsExplicit: false,
      indexers: {
        c: {
          command: process.execPath,
          args: ['--compdb-path={compdb}', '--index-output-path={output}'],
        },
      },
    });
    await loadScipIndexes(settings, os.tmpdir(), new Set(['c']), mockIO({
      ensureCompilationDatabase: async () => ({ path: '/tmp/compile_commands.json' }),
      execFile: async (_command, _args, options) => { indexerTimeout = options.timeout; },
    }));
    expect(indexerTimeout).toBe(600_000);
  });

  it('forwards cancellation to C/C++ compilation database setup', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const io = mockIO({
      ensureCompilationDatabase: async (_rootDir, _timeoutMs, _allowed, signal) => {
        receivedSignal = signal;
        return { path: null };
      },
    });
    const settings = baseSettings({
      indexers: {
        c: {
          command: process.execPath,
          args: ['--compdb-path={compdb}', '--index-output-path={output}'],
        },
      },
    });

    await loadScipIndexes(
      settings,
      os.tmpdir(),
      new Set(['c']),
      io,
      undefined,
      controller.signal,
    );
    expect(receivedSignal).toBe(controller.signal);
  });

  it('records unavailable indexers without claiming they were attempted', async () => {
    const diagnostics: ScipIndexLoadDiagnostics = {};
    const settings = baseSettings({
      indexers: { python: { command: '/definitely/missing/scip-python', args: [] } },
    });
    await loadScipIndexes(settings, '/fake/root', new Set(['python']), mockIO(), diagnostics);
    expect(diagnostics.detectedLanguages).toEqual(['python']);
    expect(diagnostics.indexers).toContainEqual(expect.objectContaining({
      indexer: '/definitely/missing/scip-python',
      languages: ['python'],
      status: 'unavailable',
      attempted: false,
    }));
  });

  it('records an attempted indexer that exits without an artifact as failed', async () => {
    const diagnostics: ScipIndexLoadDiagnostics = {};
    const settings = baseSettings({
      indexers: { typescript: { command: process.execPath, args: ['--output={output}'] } },
    });
    await loadScipIndexes(
      settings,
      os.tmpdir(),
      new Set(['typescript']),
      mockIO({ execFile: async () => {} }),
      diagnostics,
    );
    expect(diagnostics.indexers).toContainEqual(expect.objectContaining({
      indexer: process.execPath,
      status: 'failed',
      attempted: true,
      message: 'indexer exited without producing a SCIP index',
    }));
  });

  it('records the size and hash of a successful generated SCIP artifact', async () => {
    const root = makeTempDir();
    dirs.push(root);
    const diagnostics: ScipIndexLoadDiagnostics = {};
    const artifact = new Uint8Array([1, 2, 3]);
    const settings = baseSettings({
      indexers: { typescript: { command: process.execPath, args: ['--output={output}'] } },
    });
    let outputDirectory: string | undefined;
    const result = await loadScipIndexes(
      settings,
      root,
      new Set(['typescript']),
      mockIO({
        execFile: async (_command, args) => {
          const output = args.find(argument => argument.startsWith('--output='))
            ?.slice('--output='.length);
          expect(output).toBeDefined();
          outputDirectory = path.dirname(output!);
          expect(fs.statSync(outputDirectory).mode & 0o777).toBe(0o700);
          expect(path.relative(root, outputDirectory).startsWith('..')).toBe(true);
          fs.writeFileSync(output!, artifact, { flag: 'wx', mode: 0o600 });
        },
      }),
      diagnostics,
    );
    expect(result).toEqual([artifact]);
    expect(diagnostics.indexers).toContainEqual(expect.objectContaining({
      status: 'succeeded',
      attempted: true,
      outputBytes: 3,
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      bufferIndex: 0,
    }));
    expect(outputDirectory).toBeDefined();
    expect(fs.existsSync(outputDirectory!)).toBe(false);
  });

  it('rejects a generated-output symlink without consuming or deleting its target', async () => {
    const root = makeTempDir();
    dirs.push(root);
    const victim = path.join(root, 'victim.scip');
    fs.writeFileSync(victim, 'do not consume');
    const diagnostics: ScipIndexLoadDiagnostics = {};

    const result = await loadScipIndexes(
      baseSettings({
        indexers: {
          typescript: { command: process.execPath, args: ['--output={output}'] },
        },
      }),
      root,
      new Set(['typescript']),
      mockIO({
        execFile: async (_command, args) => {
          const output = args.find(argument => argument.startsWith('--output='))
            ?.slice('--output='.length);
          fs.symlinkSync(victim, output!);
        },
      }),
      diagnostics,
    );

    expect(result).toEqual([]);
    expect(fs.readFileSync(victim, 'utf8')).toBe('do not consume');
    expect(diagnostics.indexers).toContainEqual(expect.objectContaining({
      status: 'failed',
      message: expect.stringContaining('not a private regular file'),
    }));
  });

  it('does not consume or delete an index.scip checkout fallback', async () => {
    const root = makeTempDir();
    dirs.push(root);
    const checkoutOutput = path.join(root, 'index.scip');
    fs.writeFileSync(checkoutOutput, 'pre-existing checkout file');

    const result = await loadScipIndexes(
      baseSettings({
        indexers: {
          typescript: { command: process.execPath, args: ['--output={output}'] },
        },
      }),
      root,
      new Set(['typescript']),
      mockIO({ execFile: async () => {} }),
    );

    expect(result).toEqual([]);
    expect(fs.readFileSync(checkoutOutput, 'utf8')).toBe('pre-existing checkout file');
  });

  it('does not execute or auto-install when host subprocess permission is absent', async () => {
    let installs = 0;
    let executions = 0;
    const settings = baseSettings({
      allowIndexerExecution: false,
      allowAutoInstall: true,
      indexers: {
        typescript: { command: '/missing/malicious-indexer', args: [] },
      },
    });
    const diagnostics: ScipIndexLoadDiagnostics = {};
    await loadScipIndexes(
      settings,
      os.tmpdir(),
      new Set(['typescript']),
      mockIO({
        installScipIndexer: async () => {
          installs++;
          return { installed: true };
        },
        execFile: async () => { executions++; },
      }),
      diagnostics,
    );
    expect(installs).toBe(0);
    expect(executions).toBe(0);
    expect(diagnostics.indexers).toContainEqual(expect.objectContaining({
      status: 'skipped',
      attempted: false,
      message: expect.stringContaining('host policy'),
    }));
  });

  it('groups only identical command, args, and cwd invocations', async () => {
    const root = makeTempDir();
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'one'));
    fs.mkdirSync(path.join(root, 'two'));
    const invocations: Array<{ args: string[]; cwd: string }> = [];
    const settings = baseSettings({
      indexers: {
        typescript: { command: process.execPath, args: ['one', '--output={output}'], cwd: 'one' },
        javascript: { command: process.execPath, args: ['one', '--output={output}'], cwd: 'one' },
        python: { command: process.execPath, args: ['two', '--output={output}'], cwd: 'one' },
        go: { command: process.execPath, args: ['one', '--output={output}'], cwd: 'two' },
      },
    });
    await loadScipIndexes(
      settings,
      root,
      new Set(['typescript', 'javascript', 'python', 'go']),
      mockIO({
        execFile: async (_command, args, options) => {
          invocations.push({ args, cwd: options.cwd });
        },
      }),
    );
    expect(invocations).toHaveLength(3);
    expect(invocations.map((entry) => entry.args[0])).toEqual(['one', 'two', 'one']);
    expect(invocations.every((entry) => entry.args[1]?.startsWith('--output='))).toBe(true);
    expect(invocations.map((entry) => entry.cwd)).toEqual([
      fs.realpathSync(path.join(root, 'one')),
      fs.realpathSync(path.join(root, 'one')),
      fs.realpathSync(path.join(root, 'two')),
    ]);
  });

  it('detects and runs a language present only in the effective custom registry', async () => {
    const root = makeTempDir();
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'module.hs'), 'main = pure ()');
    let executions = 0;
    const diagnostics: ScipIndexLoadDiagnostics = {};
    await loadScipIndexes(
      baseSettings({
        indexers: {
          haskell: { command: process.execPath, args: ['--output={output}'] },
        },
      }),
      root,
      null,
      mockIO({ execFile: async () => { executions++; } }),
      diagnostics,
    );
    expect(diagnostics.detectedLanguages).toEqual(['haskell']);
    expect(executions).toBe(1);
  });

  it('does not invoke an indexer whose cwd escapes approved roots', async () => {
    const root = makeTempDir();
    dirs.push(root);
    let executions = 0;
    const diagnostics: ScipIndexLoadDiagnostics = {};
    await loadScipIndexes(
      baseSettings({
        indexers: {
          typescript: { command: process.execPath, args: ['--output={output}'], cwd: '..' },
        },
      }),
      root,
      new Set(['typescript']),
      mockIO({ execFile: async () => { executions++; } }),
      diagnostics,
    );
    expect(executions).toBe(0);
    expect(diagnostics.indexers).toContainEqual(expect.objectContaining({
      status: 'failed',
      message: expect.stringContaining('outside the approved roots'),
    }));
  });
});
