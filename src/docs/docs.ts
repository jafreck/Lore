import fg from 'fast-glob';
import { basename, extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type DocumentKind =
  | 'readme'
  | 'adr'
  | 'architecture'
  | 'design'
  | 'guide'
  | 'changelog'
  | 'reference'
  | 'text';

export interface DocumentSection {
  title: string;
  depth: number;
  headingPath: string[];
  line: number;
}

export interface DocumentationFile {
  path: string;
  kind: DocumentKind;
  title: string;
  content: string;
  hash: string;
  sections: DocumentSection[];
  chunks: DocumentChunk[];
}

export interface DocumentChunk {
  sectionIndex: number;
  title: string;
  depth: number;
  headingPath: string[];
  lineStart: number;
  lineEnd: number;
  content: string;
  hash: string;
}

export interface DocsDiscoveryConfig {
  rootDir: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  extensions?: string[];
}

const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__pycache__/**',
  '**/target/**',
];

export const DEFAULT_DOC_EXTENSIONS = ['.md', '.rst', '.adoc', '.txt'];

export const DEFAULT_DOC_INCLUDE_GLOBS = [
  '**/[Rr][Ee][Aa][Dd][Mm][Ee]{,.*}',
  '**/docs/**/*.{md,rst,adoc,txt}',
  '**/{adr,adrs,ADR,ADRS}/**/*.{md,rst,adoc,txt}',
  '**/{ADR,adr}-*.{md,rst,adoc,txt}',
  '**/[0-9][0-9][0-9][0-9]-*.{md,rst,adoc,txt}',
  '{architecture,ARCHITECTURE,design,DESIGN,overview,OVERVIEW,changelog,CHANGELOG,guide,GUIDE}*.{md,rst,adoc,txt}',
];

const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export async function discoverDocumentationFiles(config: DocsDiscoveryConfig): Promise<DocumentationFile[]> {
  const includePatterns = config.includeGlobs && config.includeGlobs.length > 0
    ? config.includeGlobs
    : DEFAULT_DOC_INCLUDE_GLOBS;
  const ignorePatterns = [...DEFAULT_EXCLUDES, ...(config.excludeGlobs ?? [])];
  const configuredExtensions = config.extensions && config.extensions.length > 0
    ? config.extensions
    : DEFAULT_DOC_EXTENSIONS;
  const allowedExtensions = new Set(configuredExtensions.map(ext => ext.toLowerCase()));

  const candidatePaths = await fg(includePatterns, {
    cwd: config.rootDir,
    absolute: true,
    onlyFiles: true,
    ignore: ignorePatterns,
    dot: false,
    caseSensitiveMatch: false,
  });

  const uniqueSortedPaths = [...new Set(candidatePaths)].sort((a, b) => a.localeCompare(b));
  const docs: DocumentationFile[] = [];

  for (const filePath of uniqueSortedPaths) {
    const ext = extname(filePath).toLowerCase();
    if (!allowedExtensions.has(ext) && !isReadmeVariant(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, 'utf8');
    const sections = inferDocumentSections(filePath, content);
    const chunks = inferDocumentChunks(filePath, content, sections);
    docs.push({
      path: filePath,
      kind: inferDocumentKind(filePath),
      title: inferDocumentTitle(filePath, content),
      content,
      hash: createHash('sha256').update(content).digest('hex'),
      sections,
      chunks,
    });
  }

  return docs;
}

export function inferDocumentKind(filePath: string): DocumentKind {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const filename = basename(normalizedPath, extname(normalizedPath));

  if (filename.startsWith('readme')) return 'readme';
  if (
    normalizedPath.includes('/adr/') ||
    normalizedPath.includes('/adrs/') ||
    filename.startsWith('adr') ||
    /\/\d{4}-/.test(normalizedPath)
  ) {
    return 'adr';
  }
  if (filename.includes('changelog')) return 'changelog';
  if (filename.includes('architecture') || filename === 'arch') return 'architecture';
  if (filename.includes('design') || filename.includes('overview')) return 'design';
  if (
    filename.includes('guide') ||
    filename.includes('tutorial') ||
    filename.includes('how-to') ||
    filename.includes('howto') ||
    filename.includes('contributing') ||
    normalizedPath.includes('/docs/')
  ) {
    return 'guide';
  }
  if (extname(normalizedPath) === '.txt') return 'text';
  return 'reference';
}

export function inferDocumentTitle(filePath: string, content: string): string {
  const markdownHeading = extractFirstMarkdownHeading(content);
  if (markdownHeading) return markdownHeading;

  const filename = basename(filePath, extname(filePath));
  return filename
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

export function inferDocumentSections(filePath: string, content: string): DocumentSection[] {
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.md') return [];

  const sections: DocumentSection[] = [];
  const headingStack: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    const headingMatch = line.match(MARKDOWN_HEADING_RE);
    if (!headingMatch) continue;

    const marker = headingMatch[1];
    const rawTitle = headingMatch[2];
    if (!marker || !rawTitle) continue;
    const depth = marker.length;
    const title = rawTitle.trim();

    // Fill any skipped heading levels with empty strings to avoid undefined holes
    for (let d = headingStack.length; d < depth - 1; d++) {
      headingStack[d] = headingStack[d] ?? '';
    }
    headingStack[depth - 1] = title;
    headingStack.length = depth;

    sections.push({
      title,
      depth,
      headingPath: headingStack.slice(),
      line: index + 1,
    });
  }

  return sections;
}

export function inferDocumentChunks(
  filePath: string,
  content: string,
  sections: DocumentSection[],
): DocumentChunk[] {
  const lines = content.split(/\r?\n/);
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.md' || sections.length === 0) {
    return [{
      sectionIndex: 0,
      title: inferDocumentTitle(filePath, content),
      depth: 0,
      headingPath: [],
      lineStart: 1,
      lineEnd: Math.max(1, lines.length),
      content,
      hash: createHash('sha256').update(content).digest('hex'),
    }];
  }

  const chunks: DocumentChunk[] = [];

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const nextSection = sections[index + 1];
    if (!section) continue;

    const lineStart = section.line;
    const lineEnd = nextSection ? nextSection.line - 1 : lines.length;
    const chunkContent = lines.slice(Math.max(0, lineStart - 1), Math.max(lineStart - 1, lineEnd)).join('\n');

    chunks.push({
      sectionIndex: index,
      title: section.title,
      depth: section.depth,
      headingPath: section.headingPath,
      lineStart,
      lineEnd,
      content: chunkContent,
      hash: createHash('sha256').update(chunkContent).digest('hex'),
    });
  }

  return chunks;
}

function extractFirstMarkdownHeading(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const headingMatch = line.match(MARKDOWN_HEADING_RE);
    if (headingMatch) {
      const rawTitle = headingMatch[2];
      if (rawTitle) {
        return rawTitle.trim();
      }
    }
  }

  return undefined;
}

function isReadmeVariant(filePath: string): boolean {
  const lowerName = basename(filePath).toLowerCase();
  return lowerName === 'readme' || lowerName.startsWith('readme.');
}
