import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { walkFiles, walkDocumentationFiles, detectLanguageForPath, SUPPORTED_WALKER_LANGUAGES } from '../../src/indexer/walker.js';
import { inferDocumentKind } from '../../src/indexer/docs.js';
import type { WalkerConfig } from '../../src/indexer/walker.js';
import { DEFAULT_LSP_SERVER_REGISTRY } from '../../src/indexer/lsp/registry.js';

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

  it('should discover documentation defaults across markdown/rst/adoc/txt', async () => {
    writeFile('README.md', '# Project Root');
    writeFile('docs/setup.rst', 'setup');
    writeFile('docs/architecture.adoc', '= System Architecture');
    writeFile('docs/notes.txt', 'plain text docs');
    writeFile('adrs/0001-use-sqlite.md', '# ADR 0001');
    writeFile('architecture.md', '# Architecture');

    const docs = await walkDocumentationFiles({ rootDir: tmpDir });
    const byName = new Map(docs.map(doc => [doc.path.split('/').pop()!, doc]));

    expect(byName.has('README.md')).toBe(true);
    expect(byName.has('setup.rst')).toBe(true);
    expect(byName.has('architecture.adoc')).toBe(true);
    expect(byName.has('notes.txt')).toBe(true);
    expect(byName.has('0001-use-sqlite.md')).toBe(true);
    expect(byName.get('README.md')?.kind).toBe('readme');
    expect(byName.get('0001-use-sqlite.md')?.kind).toBe('adr');
    expect(byName.get('architecture.md')?.kind).toBe('architecture');
  });

  it('should allow docs include/exclude globs without affecting source walking', async () => {
    writeFile('src/index.ts', 'export const ok = true;');
    writeFile('docs/guide.md', '# Guide');
    writeFile('handbook/custom.rst', 'custom docs');
    writeFile('handbook/skip/ignored.rst', 'skip me');

    const docs = await walkDocumentationFiles({
      rootDir: tmpDir,
      docsIncludeGlobs: ['handbook/**/*.rst'],
      docsExcludeGlobs: ['**/skip/**'],
    });
    const sourceFiles = await walkFiles({ rootDir: tmpDir });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.path.endsWith('handbook/custom.rst')).toBe(true);
    expect(sourceFiles.some(file => file.path.endsWith('src/index.ts'))).toBe(true);
  });

  it('should pass docs extension filters through to documentation discovery', async () => {
    writeFile('docs/guide.md', '# Guide');
    writeFile('docs/howto.rst', 'How-to');

    const docs = await walkDocumentationFiles({
      rootDir: tmpDir,
      docsExtensions: ['.rst'],
    });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.path.endsWith('docs/howto.rst')).toBe(true);
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

describe('inferDocumentKind', () => {
  it('should classify common documentation kinds from path patterns', () => {
    expect(inferDocumentKind('/repo/README.md')).toBe('readme');
    expect(inferDocumentKind('/repo/docs/adrs/0002-better-indexing.md')).toBe('adr');
    expect(inferDocumentKind('/repo/architecture-overview.md')).toBe('architecture');
    expect(inferDocumentKind('/repo/design-decisions.adoc')).toBe('design');
    expect(inferDocumentKind('/repo/docs/getting-guide.rst')).toBe('guide');
    expect(inferDocumentKind('/repo/CHANGELOG.md')).toBe('changelog');
    expect(inferDocumentKind('/repo/notes.txt')).toBe('text');
  });
});

describe('language coverage synchronization', () => {
  it('keeps walker language support aligned with LSP registry defaults', () => {
    expect(Object.keys(DEFAULT_LSP_SERVER_REGISTRY).sort()).toEqual([...SUPPORTED_WALKER_LANGUAGES].sort());
  });
});
