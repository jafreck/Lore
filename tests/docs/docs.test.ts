import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmdirSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  DEFAULT_DOC_EXTENSIONS,
  DEFAULT_DOC_INCLUDE_GLOBS,
  discoverDocumentationFiles,
  inferDocumentChunks,
  inferDocumentKind,
  inferDocumentSections,
  inferDocumentTitle,
} from '../../src/docs/docs.js';

describe('discoverDocumentationFiles', () => {
  let tmpDir: string;
  const createdFiles: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'lore-docs-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const filePath of createdFiles.splice(0)) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
    try { rmdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  function writeFile(name: string, content = ''): string {
    const filePath = join(tmpDir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
    createdFiles.push(filePath);
    return filePath;
  }

  it('should discover default docs and infer metadata for markdown files', async () => {
    const readmeContent = '# Lore\n\n## Installation\n\nDetails';
    writeFile('README.md', readmeContent);
    writeFile('docs/setup.rst', 'Setup Guide');
    writeFile('adrs/0001-indexing.md', '# ADR 0001');
    writeFile('docs/notes.txt', 'Plain notes');

    const docs = await discoverDocumentationFiles({ rootDir: tmpDir });
    const byName = new Map(docs.map(doc => [doc.path.split('/').pop()!, doc]));
    const readme = byName.get('README.md');

    expect(byName.has('README.md')).toBe(true);
    expect(byName.has('setup.rst')).toBe(true);
    expect(byName.has('0001-indexing.md')).toBe(true);
    expect(byName.has('notes.txt')).toBe(true);
    expect(readme?.kind).toBe('readme');
    expect(readme?.title).toBe('Lore');
    expect(readme?.content).toBe(readmeContent);
    expect(readme?.hash).toBe(createHash('sha256').update(readmeContent).digest('hex'));
    expect(readme?.sections).toEqual([
      { title: 'Lore', depth: 1, headingPath: ['Lore'], line: 1 },
      { title: 'Installation', depth: 2, headingPath: ['Lore', 'Installation'], line: 3 },
    ]);
    expect(readme?.chunks.map(chunk => ({
      sectionIndex: chunk.sectionIndex,
      title: chunk.title,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
    }))).toEqual([
      { sectionIndex: 0, title: 'Lore', lineStart: 1, lineEnd: 2 },
      { sectionIndex: 1, title: 'Installation', lineStart: 3, lineEnd: 5 },
    ]);
    for (const chunk of readme?.chunks ?? []) {
      expect(chunk.hash).toBe(createHash('sha256').update(chunk.content).digest('hex'));
    }
  });

  it('should deduplicate overlapping include globs and honor excludes', async () => {
    writeFile('docs/guide.md', '# Guide');
    writeFile('docs/private/secret.md', '# Secret');

    const docs = await discoverDocumentationFiles({
      rootDir: tmpDir,
      includeGlobs: ['docs/**/*.md', '**/*.md'],
      excludeGlobs: ['**/private/**'],
    });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.path.endsWith('docs/guide.md')).toBe(true);
  });

  it('should allow readme variants even when extension filters exclude them', async () => {
    writeFile('README.custom', '# Custom Readme');
    writeFile('docs/guide.md', '# Guide');

    const docs = await discoverDocumentationFiles({
      rootDir: tmpDir,
      includeGlobs: ['**/*'],
      extensions: ['.txt'],
    });

    expect(docs).toHaveLength(1);
    expect(docs[0]?.path.endsWith('README.custom')).toBe(true);
  });

  it('should throw when a discovered document cannot be read', async () => {
    const unreadableDoc = writeFile('README.md', '# Lore');
    chmodSync(unreadableDoc, 0o000);

    try {
      await expect(discoverDocumentationFiles({
        rootDir: tmpDir,
        includeGlobs: ['README.md'],
      })).rejects.toThrow();
    } finally {
      chmodSync(unreadableDoc, 0o644);
    }
  });
});

describe('inferDocumentKind', () => {
  it('should return reference for unmatched document names', () => {
    expect(inferDocumentKind('/repo/specification.md')).toBe('reference');
  });
});

describe('inferDocumentTitle', () => {
  it('should use the first markdown heading when present', () => {
    const title = inferDocumentTitle('/repo/docs/guide.md', 'Intro\n# Getting Started\n## Install');
    expect(title).toBe('Getting Started');
  });

  it('should derive a title from the filename when no heading exists', () => {
    const title = inferDocumentTitle('/repo/docs/system_overview-file.adoc', 'No markdown heading here');
    expect(title).toBe('System Overview File');
  });
});

describe('inferDocumentSections', () => {
  it('should parse markdown heading depth and hierarchy', () => {
    const sections = inferDocumentSections(
      '/repo/docs/guide.md',
      '# Top\nText\n## Child\n### Grandchild ###\n## Sibling',
    );

    expect(sections).toEqual([
      { title: 'Top', depth: 1, headingPath: ['Top'], line: 1 },
      { title: 'Child', depth: 2, headingPath: ['Top', 'Child'], line: 3 },
      { title: 'Grandchild', depth: 3, headingPath: ['Top', 'Child', 'Grandchild'], line: 4 },
      { title: 'Sibling', depth: 2, headingPath: ['Top', 'Sibling'], line: 5 },
    ]);
  });

  it('should return an empty array for non-markdown files', () => {
    expect(inferDocumentSections('/repo/docs/guide.rst', '# Not markdown headings')).toEqual([]);
  });
});

describe('inferDocumentChunks', () => {
  it('should split markdown documents into heading-based chunks', () => {
    const content = '# Top\nIntro\n## Child\nDetails\n## Sibling\nTail';
    const sections = inferDocumentSections('/repo/docs/guide.md', content);
    const chunks = inferDocumentChunks('/repo/docs/guide.md', content, sections);

    expect(chunks.map(chunk => ({
      sectionIndex: chunk.sectionIndex,
      title: chunk.title,
      depth: chunk.depth,
      headingPath: chunk.headingPath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      content: chunk.content,
    }))).toEqual([
      {
        sectionIndex: 0,
        title: 'Top',
        depth: 1,
        headingPath: ['Top'],
        lineStart: 1,
        lineEnd: 2,
        content: '# Top\nIntro',
      },
      {
        sectionIndex: 1,
        title: 'Child',
        depth: 2,
        headingPath: ['Top', 'Child'],
        lineStart: 3,
        lineEnd: 4,
        content: '## Child\nDetails',
      },
      {
        sectionIndex: 2,
        title: 'Sibling',
        depth: 2,
        headingPath: ['Top', 'Sibling'],
        lineStart: 5,
        lineEnd: 6,
        content: '## Sibling\nTail',
      },
    ]);
    for (const chunk of chunks) {
      expect(chunk.hash).toBe(createHash('sha256').update(chunk.content).digest('hex'));
    }
  });

  it('should return a single fallback chunk for documents without markdown sections', () => {
    const content = '';
    const chunks = inferDocumentChunks('/repo/docs/notes.txt', content, []);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sectionIndex: 0,
      title: 'Notes',
      depth: 0,
      headingPath: [],
      lineStart: 1,
      lineEnd: 1,
      content: '',
    });
    expect(chunks[0]?.hash).toBe(createHash('sha256').update(content).digest('hex'));
  });
});

describe('docs defaults', () => {
  it('should include markdown/rst/adoc/txt extensions and key discovery patterns', () => {
    expect(DEFAULT_DOC_EXTENSIONS).toEqual(['.md', '.rst', '.adoc', '.txt']);
    expect(DEFAULT_DOC_INCLUDE_GLOBS).toContain('**/[Rr][Ee][Aa][Dd][Mm][Ee]{,.*}');
    expect(DEFAULT_DOC_INCLUDE_GLOBS).toContain('**/docs/**/*.{md,rst,adoc,txt}');
    expect(DEFAULT_DOC_INCLUDE_GLOBS).toContain('**/{adr,adrs,ADR,ADRS}/**/*.{md,rst,adoc,txt}');
  });
});
