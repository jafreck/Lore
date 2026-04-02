import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectProjectLanguages,
  createLoreScipTsconfig,
  loadScipIndexes,
  findDotnetProject,
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
    const settings = baseSettings({ indexDir: '.scip' });
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

  it('replaces {project} placeholder for csharp when .sln exists', async () => {
    const indexData = new Uint8Array([5, 6, 7]);
    const execCalls: { cmd: string; args: string[] }[] = [];
    const dir = makeTempDir();
    dirs.push(dir);
    // Create a subdirectory with a .sln file
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'App.sln'), '');
    // Create a .cs file so csharp is detected
    fs.writeFileSync(path.join(srcDir, 'Program.cs'), '');

    const io = mockIO({
      existsSync: (p) => {
        if (p.endsWith('.lore-scip-csharp.scip')) return true;
        return false;
      },
      readFileSync: () => indexData,
      execFile: async (cmd, args) => { execCalls.push({ cmd, args: args as string[] }); },
    });
    // Point scip-dotnet command to /bin/echo so it resolves as "available"
    const settings = baseSettings({
      indexers: { csharp: { command: '/bin/echo', args: ['index', '{project}', '--output', '{output}'] } },
    });
    const result = await loadScipIndexes(settings, dir, new Set(['csharp']), io);
    expect(result).toHaveLength(1);
    // Verify the {project} placeholder was replaced with the discovered .sln path
    const call = execCalls[0];
    expect(call).toBeDefined();
    expect(call.args.some(a => a.includes('App.sln'))).toBe(true);
    expect(call.args.every(a => !a.includes('{project}'))).toBe(true);
  });

  it('skips csharp when {project} placeholder present but no .sln/.csproj found', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    // Create a .cs file so csharp is detected but no .sln or .csproj
    fs.writeFileSync(path.join(dir, 'Program.cs'), '');

    const io = mockIO({
      execFile: async () => { throw new Error('should not be called'); },
    });
    const settings = baseSettings({
      indexers: { csharp: { command: '/bin/echo', args: ['index', '{project}', '--output', '{output}'] } },
    });
    const result = await loadScipIndexes(settings, dir, new Set(['csharp']), io);
    expect(result).toEqual([]);
  });

  it('recovers index.scip when indexer exits with non-zero code', async () => {
    const indexData = new Uint8Array([42, 43, 44]);
    const dir = makeTempDir();
    dirs.push(dir);
    // Create a .rb file so ruby is detected
    fs.writeFileSync(path.join(dir, 'app.rb'), '');

    const io = mockIO({
      existsSync: (p) => {
        if (p.endsWith('index.scip')) return true;
        return false;
      },
      readFileSync: () => indexData,
      execFile: async () => { throw new Error('Command failed with exit code 100'); },
    });
    // Point scip-ruby to /bin/echo so it resolves as available
    const settings = baseSettings({
      indexers: { ruby: { command: '/bin/echo', args: ['.'] } },
    });
    const result = await loadScipIndexes(settings, dir, new Set(['ruby']), io);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(indexData);
  });

  it('returns empty when indexer fails and no index.scip written', async () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'app.rb'), '');

    const io = mockIO({
      existsSync: () => false,
      execFile: async () => { throw new Error('indexer crashed'); },
    });
    const settings = baseSettings({
      indexers: { ruby: { command: '/bin/echo', args: ['.'] } },
    });
    const result = await loadScipIndexes(settings, dir, new Set(['ruby']), io);
    expect(result).toEqual([]);
  });
});

// ─── findDotnetProject ──────────────────────────────────────────────────────

describe('findDotnetProject', () => {
  it('finds .sln at root', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'MyApp.sln'), '');
    const result = findDotnetProject(dir);
    expect(result).toBe(path.join(dir, 'MyApp.sln'));
  });

  it('finds .sln one level deep', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'App.sln'), '');
    const result = findDotnetProject(dir);
    expect(result).toBe(path.join(dir, 'src', 'App.sln'));
  });

  it('prefers .sln over .csproj', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'App.csproj'), '');
    fs.writeFileSync(path.join(dir, 'App.sln'), '');
    const result = findDotnetProject(dir);
    expect(result).toBe(path.join(dir, 'App.sln'));
  });

  it('falls back to .csproj at root when no .sln found', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'MyLib.csproj'), '');
    const result = findDotnetProject(dir);
    expect(result).toBe(path.join(dir, 'MyLib.csproj'));
  });

  it('returns null when no .sln or .csproj found', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '');
    expect(findDotnetProject(dir)).toBeNull();
  });

  it('returns null for non-existent directory', () => {
    expect(findDotnetProject('/tmp/no-such-dir-xyz')).toBeNull();
  });
});

// ─── detectProjectLanguages (csharp extensions) ─────────────────────────────

describe('detectProjectLanguages (csharp)', () => {
  it('detects csharp from .sln in subdirectory', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'App.sln'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('csharp')).toBe(true);
  });

  it('detects csharp from .csproj in subdirectory', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'MyLib.csproj'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('csharp')).toBe(true);
  });

  it('detects csharp from .sln at root level', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'App.sln'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('csharp')).toBe(true);
  });

  it('detects csharp from .cs file extension', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'Program.cs'), '');
    const langs = detectProjectLanguages(dir);
    expect(langs.has('csharp')).toBe(true);
  });
});
