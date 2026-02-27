import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkFiles } from '../../src/indexer/walker.js';
import type { WalkerConfig } from '../../src/indexer/walker.js';

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
});
