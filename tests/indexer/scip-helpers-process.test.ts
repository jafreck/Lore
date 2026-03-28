import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectProjectLanguages,
  createLoreScipTsconfig,
} from '../../src/indexer/stages/scip-helpers/process.js';

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
});
