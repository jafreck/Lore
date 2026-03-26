import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkFiles, detectLanguageForPath, SUPPORTED_WALKER_LANGUAGES } from '../../src/discovery/walker.js';
import { inferDocumentKind } from '../../src/docs/docs.js';
import type { WalkerConfig } from '../../src/discovery/walker.js';
import { DEFAULT_LSP_SERVER_REGISTRY } from '../../src/lsp/registry.js';

describe('WalkerConfig', () => {
  it('should accept an optional branch field', () => {
    const config: WalkerConfig = {
      rootDir: '/some/dir',
      branch: 'main',
    };
    expect(config.branch).toBe('main');
  });

  it('should allow branch to be omitted', () => {
    const config: WalkerConfig = { rootDir: '/some/dir' };
    expect(config.branch).toBeUndefined();
  });
});

describe('walkFiles', () => {
  let tmpDir: string;
  const createdFiles: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lore-walker-test-'));
  });

  afterEach(() => {
    for (const f of createdFiles.splice(0)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    try { rmdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  function writeFile(name: string, content = ''): string {
    const p = join(tmpDir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
    createdFiles.push(p);
    return p;
  }

  it('should return an empty array when directory has no source files', async () => {
    const results = await walkFiles({ rootDir: tmpDir });
    expect(results).toEqual([]);
  });

  it('should return FileEntry objects with path and language', async () => {
    writeFile('foo.ts', 'export const x = 1;');
    const results = await walkFiles({ rootDir: tmpDir });
    expect(results.length).toBe(1);
    expect(results[0]).toHaveProperty('path');
    expect(results[0]).toHaveProperty('language');
    expect(results[0]!.language).toBe('typescript');
  });

  it('should work when branch is specified in config', async () => {
    writeFile('bar.ts', 'export const y = 2;');
    const results = await walkFiles({ rootDir: tmpDir, branch: 'feat/my-branch' });
    expect(results.length).toBe(1);
    expect(results[0]!.language).toBe('typescript');
  });

  it('should work when branch is omitted from config', async () => {
    writeFile('baz.py', 'def hello(): pass');
    const results = await walkFiles({ rootDir: tmpDir });
    expect(results.length).toBe(1);
    expect(results[0]!.language).toBe('python');
  });

  it('should respect extension filter', async () => {
    writeFile('a.ts');
    writeFile('b.py');
    const results = await walkFiles({ rootDir: tmpDir, extensions: ['.ts'] });
    expect(results.length).toBe(1);
    expect(results[0]!.language).toBe('typescript');
  });

  it('should respect excludeGlobs', async () => {
    writeFile('keep.ts');
    mkdirSync(join(tmpDir, 'skip'));
    const skipFile = join(tmpDir, 'skip', 'excluded.ts');
    writeFileSync(skipFile, '');
    createdFiles.push(skipFile);
    const results = await walkFiles({ rootDir: tmpDir, excludeGlobs: ['skip/**'] });
    expect(results.every(r => !r.path.includes('skip'))).toBe(true);
  });

  it('should detect multiple languages in the same directory', async () => {
    writeFile('index.ts');
    writeFile('main.py');
    writeFile('lib.rs');
    const results = await walkFiles({ rootDir: tmpDir });
    const langs = results.map(r => r.language).sort();
    expect(langs).toContain('typescript');
    expect(langs).toContain('python');
    expect(langs).toContain('rust');
  });

  it('should default to scanning all files when includeGlobs is empty', async () => {
    writeFile('alpha.ts');
    const results = await walkFiles({ rootDir: tmpDir, includeGlobs: [] });
    expect(results.length).toBe(1);
    expect(results[0]!.language).toBe('typescript');
  });

  it('should allow docs include/exclude globs without affecting source walking', async () => {
    writeFile('src/index.ts', 'export const ok = true;');
    writeFile('docs/guide.md', '# Guide');

    const sourceFiles = await walkFiles({ rootDir: tmpDir });

    expect(sourceFiles.some(file => file.path.endsWith('src/index.ts'))).toBe(true);
  });
});

describe('detectLanguageForPath', () => {
  it('should detect language by extension', () => {
    expect(detectLanguageForPath('/tmp/file.ts')).toBe('typescript');
    expect(detectLanguageForPath('/tmp/file.py')).toBe('python');
  });

  it('should return undefined for unknown extensions', () => {
    expect(detectLanguageForPath('/tmp/file.unknown')).toBeUndefined();
  });

  it('should respect explicit extension filters', () => {
    expect(detectLanguageForPath('/tmp/file.ts', { extensions: ['.py'] })).toBeUndefined();
    expect(detectLanguageForPath('/tmp/file.ts', { extensions: ['.ts'] })).toBe('typescript');
  });

  it('should normalize extension casing before lookup', () => {
    expect(detectLanguageForPath('/tmp/file.TS')).toBe('typescript');
  });
});

describe('language coverage synchronization', () => {
  it('keeps walker language support aligned with LSP registry defaults', () => {
    expect(Object.keys(DEFAULT_LSP_SERVER_REGISTRY).sort()).toEqual([...SUPPORTED_WALKER_LANGUAGES].sort());
  });
});
