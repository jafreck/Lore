import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXT_TO_LANG, walkFiles } from '../../src/indexer/walker.js';

// ─── EXT_TO_LANG ──────────────────────────────────────────────────────────────

describe('EXT_TO_LANG', () => {
  it('should be exported as a non-empty object', () => {
    expect(EXT_TO_LANG).toBeDefined();
    expect(typeof EXT_TO_LANG).toBe('object');
    expect(Object.keys(EXT_TO_LANG).length).toBeGreaterThan(0);
  });

  it('should map .ts to typescript', () => {
    expect(EXT_TO_LANG['.ts']).toBe('typescript');
  });

  it('should map .tsx to typescript', () => {
    expect(EXT_TO_LANG['.tsx']).toBe('typescript');
  });

  it('should map .js to javascript', () => {
    expect(EXT_TO_LANG['.js']).toBe('javascript');
  });

  it('should map .jsx to javascript', () => {
    expect(EXT_TO_LANG['.jsx']).toBe('javascript');
  });

  it('should map .mjs to javascript', () => {
    expect(EXT_TO_LANG['.mjs']).toBe('javascript');
  });

  it('should map .cjs to javascript', () => {
    expect(EXT_TO_LANG['.cjs']).toBe('javascript');
  });

  it('should map .py to python', () => {
    expect(EXT_TO_LANG['.py']).toBe('python');
  });

  it('should map .rs to rust', () => {
    expect(EXT_TO_LANG['.rs']).toBe('rust');
  });

  it('should map .go to go', () => {
    expect(EXT_TO_LANG['.go']).toBe('go');
  });

  it('should map .java to java', () => {
    expect(EXT_TO_LANG['.java']).toBe('java');
  });

  it('should map .cs to csharp', () => {
    expect(EXT_TO_LANG['.cs']).toBe('csharp');
  });

  it('should map .rb to ruby', () => {
    expect(EXT_TO_LANG['.rb']).toBe('ruby');
  });

  it('should map .php to php', () => {
    expect(EXT_TO_LANG['.php']).toBe('php');
  });

  it('should map .swift to swift', () => {
    expect(EXT_TO_LANG['.swift']).toBe('swift');
  });

  it('should map .kt to kotlin', () => {
    expect(EXT_TO_LANG['.kt']).toBe('kotlin');
  });

  it('should map .kts to kotlin', () => {
    expect(EXT_TO_LANG['.kts']).toBe('kotlin');
  });

  it('should map .sh to bash', () => {
    expect(EXT_TO_LANG['.sh']).toBe('bash');
  });

  it('should map .c to c', () => {
    expect(EXT_TO_LANG['.c']).toBe('c');
  });

  it('should map .h to c', () => {
    expect(EXT_TO_LANG['.h']).toBe('c');
  });

  it('should map .cpp to cpp', () => {
    expect(EXT_TO_LANG['.cpp']).toBe('cpp');
  });

  it('should not map unknown extensions', () => {
    expect(EXT_TO_LANG['.xyz']).toBeUndefined();
    expect(EXT_TO_LANG['.txt']).toBeUndefined();
  });
});

// ─── walkFiles ────────────────────────────────────────────────────────────────

describe('walkFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lore-walker-test-'));
    writeFileSync(join(tmpDir, 'index.ts'), '');
    writeFileSync(join(tmpDir, 'main.py'), '');
    writeFileSync(join(tmpDir, 'readme.txt'), '');
    mkdirSync(join(tmpDir, 'subdir'));
    writeFileSync(join(tmpDir, 'subdir', 'helper.js'), '');
    writeFileSync(join(tmpDir, 'subdir', 'config.rs'), '');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return known-language files from rootDir', async () => {
    const entries = await walkFiles({ rootDir: tmpDir });
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.endsWith('index.ts'))).toBe(true);
    expect(paths.some((p) => p.endsWith('main.py'))).toBe(true);
    expect(paths.some((p) => p.endsWith('helper.js'))).toBe(true);
    expect(paths.some((p) => p.endsWith('config.rs'))).toBe(true);
  });

  it('should not return files with unknown extensions', async () => {
    const entries = await walkFiles({ rootDir: tmpDir });
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.endsWith('readme.txt'))).toBe(false);
  });

  it('should set the correct language for each file entry', async () => {
    const entries = await walkFiles({ rootDir: tmpDir });
    const tsEntry = entries.find((e) => e.path.endsWith('index.ts'));
    expect(tsEntry?.language).toBe('typescript');
    const pyEntry = entries.find((e) => e.path.endsWith('main.py'));
    expect(pyEntry?.language).toBe('python');
    const rsEntry = entries.find((e) => e.path.endsWith('config.rs'));
    expect(rsEntry?.language).toBe('rust');
  });

  it('should respect includeGlobs to restrict which files are returned', async () => {
    const entries = await walkFiles({ rootDir: tmpDir, includeGlobs: ['**/*.ts'] });
    const paths = entries.map((e) => e.path);
    expect(paths.every((p) => p.endsWith('.ts'))).toBe(true);
    expect(paths.some((p) => p.endsWith('main.py'))).toBe(false);
  });

  it('should respect excludeGlobs to skip matching paths', async () => {
    const entries = await walkFiles({ rootDir: tmpDir, excludeGlobs: ['subdir/**'] });
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.endsWith('helper.js'))).toBe(false);
    expect(paths.some((p) => p.endsWith('config.rs'))).toBe(false);
    expect(paths.some((p) => p.endsWith('index.ts'))).toBe(true);
  });

  it('should respect extensions filter to include only matching extensions', async () => {
    const entries = await walkFiles({ rootDir: tmpDir, extensions: ['.ts', '.py'] });
    const paths = entries.map((e) => e.path);
    expect(paths.every((p) => p.endsWith('.ts') || p.endsWith('.py'))).toBe(true);
    expect(paths.some((p) => p.endsWith('helper.js'))).toBe(false);
    expect(paths.some((p) => p.endsWith('config.rs'))).toBe(false);
  });

  it('should return an empty array when extensions filter matches nothing', async () => {
    const entries = await walkFiles({ rootDir: tmpDir, extensions: ['.zig'] });
    expect(entries).toEqual([]);
  });

  it('should return absolute paths', async () => {
    const entries = await walkFiles({ rootDir: tmpDir });
    for (const entry of entries) {
      expect(entry.path.startsWith('/')).toBe(true);
    }
  });

  it('should return an empty array for an empty directory', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'lore-walker-empty-'));
    try {
      const entries = await walkFiles({ rootDir: emptyDir });
      expect(entries).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
