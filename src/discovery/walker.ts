/**
 * @module indexer/walker
 *
 * Walks a directory tree using fast-glob and maps each file to a detected
 * programming language based on its extension.
 */

import fg from 'fast-glob';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import type { LoadedCompilationDatabase } from '../scip/compdb.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration for a `walkFiles` call. */
export interface WalkerConfig {
  /** Absolute path to the directory to scan. */
  rootDir: string;

  /**
   * Glob patterns (relative to `rootDir`) for files to include.
   * Defaults to `['**\/*']` when empty or omitted.
   */
  includeGlobs?: string[];

  /**
   * Glob patterns (relative to `rootDir`) for paths to exclude.
   * Merged with the built-in default exclusion list.
   */
  excludeGlobs?: string[];

  /**
   * Explicit file extensions to accept (with leading dot, e.g. `'.ts'`).
   * When provided, files whose extension is not in this list are skipped.
   * When omitted, all extensions that map to a known language are accepted.
   */
  extensions?: string[];

  /**
   * Git branch name to associate with indexed files.
   * When omitted, indexing resolves the current branch from git.
   */
  branch?: string;



}

/** A single file discovered by `walkFiles`. */
export interface FileEntry {
  /** Absolute path to the file. */
  path: string;

  /** Detected programming language (lower-case identifier). */
  language: string;
}

// ─── Extension → Language mapping ────────────────────────────────────────────

export const EXT_TO_LANG: Record<string, string> = {
  '.c':    'c',
  '.C':    'cpp',
  '.h':    'c',
  '.rs':   'rust',
  '.py':   'python',
  '.cpp':  'cpp',
  '.cc':   'cpp',
  '.cxx':  'cpp',
  '.c++':  'cpp',
  '.hpp':  'cpp',
  '.hh':   'cpp',
  '.hxx':  'cpp',
  '.h++':  'cpp',
  '.ts':   'typescript',
  '.tsx':  'typescript',
  '.js':   'javascript',
  '.jsx':  'javascript',
  '.mjs':  'javascript',
  '.cjs':  'javascript',
  '.go':   'go',
  '.java': 'java',
  '.cs':   'csharp',
  '.rb':   'ruby',
  '.php':  'php',
  '.swift': 'swift',
  '.kt':   'kotlin',
  '.kts':  'kotlin',
  '.scala': 'scala',
  '.sc':   'scala',
  '.lua':  'lua',
  '.sh':   'bash',
  '.bash': 'bash',
  '.zsh':  'bash',
  '.ex':   'elixir',
  '.exs':  'elixir',
  '.zig':  'zig',
  '.ml':   'ocaml',
  '.mli':  'ocaml',
  '.hs':   'haskell',
  '.jl':   'julia',
  '.elm':  'elm',
  '.m':    'objc',
  '.mm':   'objc',
};

/** Sorted list of all distinct extractor languages supported by the walker. */
export const SUPPORTED_WALKER_LANGUAGES: readonly string[] = Object.freeze(
  [...new Set(Object.values(EXT_TO_LANG))].sort(),
);

const C_SOURCE_EXTENSIONS = new Set(['.c']);
const CPP_SOURCE_EXTENSIONS = new Set(['.C', '.cc', '.cpp', '.cxx', '.c++']);

/** Normalize extensions while retaining the POSIX `.C` C++ convention. */
export function sourceExtension(filePath: string): string {
  const extension = extname(filePath);
  return extension === '.C' ? '.C' : extension.toLowerCase();
}

export interface CFamilyLanguageEvidence {
  classifyHeaderLanguage(filePath: string): CFamilyHeaderClassification;
  inferHeaderLanguage(filePath: string, scipLanguage?: 'c' | 'cpp'): 'c' | 'cpp' | undefined;
}

export type CFamilyHeaderClassification =
  | 'c'
  | 'cpp'
  | 'mixed'
  | 'ambiguous'
  | 'unknown';

export interface CFamilyLanguageEvidenceOptions {
  /** Base directory used to resolve relative SCIP/document paths. */
  rootDir?: string;
  compilationDatabase?: Pick<LoadedCompilationDatabase, 'entries'> | null;
  sourceCache?: ReadonlyMap<string, string>;
  readSource?: (filePath: string) => string | undefined;
}

/**
 * Build component- and compilation-database-aware C/C++ header evidence.
 *
 * Direct include reachability from compilation-database translation units is
 * authoritative. Headers reached only from C TUs are C, headers reached only
 * from C++ TUs are C++, and headers reached from both are explicitly `mixed`.
 * For headers without include evidence, the nearest source component is used;
 * equal-distance C/C++ evidence is `ambiguous` rather than being decided by a
 * repository-wide majority ratio.
 */
export function buildCFamilyLanguageEvidence(
  filePaths: Iterable<string>,
  options: CFamilyLanguageEvidenceOptions = {},
): CFamilyLanguageEvidence {
  const evidenceRoot = options.rootDir ?? process.cwd();
  const knownPaths = new Map<string, string>();
  const sourceLanguages = new Map<string, 'c' | 'cpp'>();
  for (const filePath of filePaths) {
    const normalizedPath = normalizeEvidencePath(filePath, evidenceRoot);
    knownPaths.set(normalizedPath, filePath);
    const extension = sourceExtension(filePath);
    const language = C_SOURCE_EXTENSIONS.has(extension)
      ? 'c'
      : CPP_SOURCE_EXTENSIONS.has(extension) ? 'cpp' : null;
    if (language) sourceLanguages.set(normalizedPath, language);
  }

  const compilationEntries = options.compilationDatabase?.entries ?? [];
  for (const entry of compilationEntries) {
    if (entry.language === 'c' || entry.language === 'cpp') {
      sourceLanguages.set(normalizeEvidencePath(entry.filePath, evidenceRoot), entry.language);
    }
  }
  const componentLanguages = buildComponentLanguageIndex(sourceLanguages);

  const directHeaderLanguages = new Map<string, Set<'c' | 'cpp'>>();
  for (const entry of compilationEntries) {
    const language = entry.language === 'c' || entry.language === 'cpp'
      ? entry.language
      : sourceLanguages.get(normalizeEvidencePath(entry.filePath, evidenceRoot));
    if (!language) continue;
    collectIncludedHeaderLanguages(
      entry.filePath,
      language,
      entry.includePaths,
      knownPaths,
      directHeaderLanguages,
      options,
      evidenceRoot,
    );
  }

  const classificationCache = new Map<string, CFamilyHeaderClassification>();
  const classifyHeaderLanguage = (filePath: string): CFamilyHeaderClassification => {
    const normalizedPath = normalizeEvidencePath(filePath, evidenceRoot);
    const cached = classificationCache.get(normalizedPath);
    if (cached) return cached;

    const direct = directHeaderLanguages.get(normalizedPath);
    let classification: CFamilyHeaderClassification;
    if (direct?.size === 1) {
      classification = direct.has('cpp') ? 'cpp' : 'c';
    } else if (direct && direct.size > 1) {
      classification = 'mixed';
    } else {
      const nearest = nearestComponentLanguages(normalizedPath, componentLanguages);
      classification = nearest.size === 0
        ? 'unknown'
        : nearest.size === 1
          ? nearest.has('cpp') ? 'cpp' : 'c'
          : 'ambiguous';
    }
    classificationCache.set(normalizedPath, classification);
    return classification;
  };

  return {
    classifyHeaderLanguage,
    inferHeaderLanguage(filePath, scipLanguage) {
      const classification = classifyHeaderLanguage(filePath);
      return classification === 'c' || classification === 'cpp'
        ? classification
        : scipLanguage;
    },
  };
}

function normalizeEvidencePath(filePath: string, rootDir: string): string {
  return resolve(rootDir, filePath.replace(/\\/gu, '/')).replace(/\\/gu, '/');
}

function nearestComponentLanguages(
  headerPath: string,
  componentLanguages: ReadonlyMap<string, ReadonlySet<'c' | 'cpp'>>,
): Set<'c' | 'cpp'> {
  let directory = dirname(headerPath);
  while (true) {
    const languages = componentLanguages.get(directory);
    if (languages) return new Set(languages);
    const parent = dirname(directory);
    if (parent === directory) return new Set();
    directory = parent;
  }
}

function buildComponentLanguageIndex(
  sourceLanguages: ReadonlyMap<string, 'c' | 'cpp'>,
): Map<string, Set<'c' | 'cpp'>> {
  const index = new Map<string, Set<'c' | 'cpp'>>();
  for (const [sourcePath, language] of sourceLanguages) {
    let directory = dirname(sourcePath);
    while (true) {
      let languages = index.get(directory);
      if (!languages) {
        languages = new Set();
        index.set(directory, languages);
      }
      languages.add(language);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return index;
}

function collectIncludedHeaderLanguages(
  translationUnit: string,
  language: 'c' | 'cpp',
  includePaths: readonly string[],
  knownPaths: ReadonlyMap<string, string>,
  headerLanguages: Map<string, Set<'c' | 'cpp'>>,
  options: CFamilyLanguageEvidenceOptions,
  rootDir: string,
): void {
  const pending = [normalizeEvidencePath(translationUnit, rootDir)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    const source = readEvidenceSource(sourcePath, knownPaths, options);
    if (source === undefined) continue;

    for (const include of parseIncludes(source)) {
      const includedPath = resolveKnownInclude(
        sourcePath,
        include.path,
        include.quoted,
        includePaths,
        knownPaths,
        rootDir,
      );
      if (!includedPath) continue;
      if (extname(includedPath).toLowerCase() === '.h') {
        let languages = headerLanguages.get(includedPath);
        if (!languages) {
          languages = new Set();
          headerLanguages.set(includedPath, languages);
        }
        languages.add(language);
      }
      pending.push(includedPath);
    }
  }
}

function readEvidenceSource(
  normalizedPath: string,
  knownPaths: ReadonlyMap<string, string>,
  options: CFamilyLanguageEvidenceOptions,
): string | undefined {
  const originalPath = knownPaths.get(normalizedPath) ?? normalizedPath;
  const cached = options.sourceCache?.get(normalizedPath)
    ?? options.sourceCache?.get(originalPath);
  if (cached !== undefined) return cached;
  if (options.readSource) return options.readSource(normalizedPath);
  try {
    return readFileSync(normalizedPath, 'utf8');
  } catch {
    return undefined;
  }
}

function parseIncludes(source: string): Array<{ path: string; quoted: boolean }> {
  const includes: Array<{ path: string; quoted: boolean }> = [];
  const pattern = /^\s*#\s*include\s*([<"])([^>"\r\n]+)[>"]/gmu;
  for (const match of source.matchAll(pattern)) {
    const includePath = match[2]?.trim();
    if (includePath) includes.push({ path: includePath, quoted: match[1] === '"' });
  }
  return includes;
}

function resolveKnownInclude(
  fromFile: string,
  includePath: string,
  quoted: boolean,
  includePaths: readonly string[],
  knownPaths: ReadonlyMap<string, string>,
  rootDir: string,
): string | null {
  const roots = quoted ? [dirname(fromFile), ...includePaths] : includePaths;
  for (const root of roots) {
    const candidate = normalizeEvidencePath(resolve(root, includePath), rootDir);
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

// Paths always excluded unless the caller overrides them.
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/builddir/**',
  '**/.lore-compdb/**',
  '**/__pycache__/**',
  '**/target/**',
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Walks `config.rootDir` and returns every source file that can be mapped
 * to a known programming language.
 */
export async function walkFiles(
  config: WalkerConfig,
  cFamilyOptions: CFamilyLanguageEvidenceOptions = {},
): Promise<FileEntry[]> {
  const {
    rootDir,
    includeGlobs = ['**/*'],
    excludeGlobs = [],
    extensions,
  } = config;

  const patterns = includeGlobs.length > 0 ? includeGlobs : ['**/*'];
  const ignore = [...DEFAULT_EXCLUDES, ...excludeGlobs];

  const paths = await fg(patterns, {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: true,
    ignore,
    dot: false,
  });

  const candidates: string[] = [];
  const seen = new Set<string>();
  const canonicalRoot = realpathSync(rootDir);

  for (const filePath of paths) {
    // Resolve symlinks to canonical paths so each physical file is indexed
    // once, regardless of how many symlinks point to it.
    let realPath: string;
    try {
      realPath = realpathSync(filePath);
    } catch (err: unknown) {
      // File may have been deleted between glob discovery and realpath.
      // Skip transient filesystem errors (ENOENT, EACCES, etc.) but
      // re-throw programming errors.
      if (err instanceof Error && 'code' in err) continue;
      throw err;
    }

    // Reject symlinks that escape the repository root.
    if (realPath !== canonicalRoot && !realPath.startsWith(canonicalRoot + sep)) continue;

    if (seen.has(realPath)) continue;
    seen.add(realPath);

    const ext = sourceExtension(realPath);

    // Skip if caller supplied an explicit extension filter.
    if (extensions && !extensions.includes(ext)) continue;

    if (!EXT_TO_LANG[ext]) continue;
    candidates.push(realPath);
  }

  const cFamilyEvidence = buildCFamilyLanguageEvidence(candidates, {
    rootDir,
    ...cFamilyOptions,
  });
  return candidates.flatMap((filePath): FileEntry[] => {
    const language = detectLanguageForPath(filePath, undefined, { cFamilyEvidence });
    return language ? [{ path: filePath, language }] : [];
  });
}


/**
 * Detect the Lore language for a single file path using extension mapping.
 * Returns `undefined` when the extension is unknown or filtered out.
 */
export function detectLanguageForPath(
  filePath: string,
  config?: Pick<WalkerConfig, 'extensions'>,
  hints?: { scipLanguage?: 'c' | 'cpp'; cFamilyEvidence?: CFamilyLanguageEvidence },
): string | undefined {
  const ext = sourceExtension(filePath);
  if (config?.extensions && !config.extensions.includes(ext)) return undefined;
  if (ext === '.h') {
    return hints?.cFamilyEvidence?.inferHeaderLanguage(filePath, hints.scipLanguage)
      ?? hints?.scipLanguage
      ?? 'c';
  }
  return EXT_TO_LANG[ext];
}

/**
 * Tests whether a file should be included for indexing according to the
 * discovery walker's exclude patterns and extension rules.
 *
 * This is a fast synchronous pre-filter used by FileWatcher to skip files
 * that `walkFiles` would never return. It handles:
 *
 * - Default and user-configured directory exclusions (`**\/<name>\/**` patterns)
 * - Extension filtering via `EXT_TO_LANG` and optional explicit `extensions`
 *
 * @param relativePath Forward-slash-separated path relative to rootDir
 * @param config       Walker configuration for exclusion globs and extensions
 */
export function shouldIndexFile(
  relativePath: string,
  config: Pick<WalkerConfig, 'excludeGlobs' | 'extensions'>,
): boolean {
  const allExcludes = [...DEFAULT_EXCLUDES, ...(config.excludeGlobs ?? [])];

  // Extract excluded directory names from `**/<name>/**` patterns.
  const excludedDirs = new Set<string>();
  for (const p of allExcludes) {
    const m = /^\*\*\/([^/*]+)\/\*\*$/.exec(p);
    if (m?.[1]) excludedDirs.add(m[1]);
  }

  // Check if any path segment matches an excluded directory.
  const segments = relativePath.replace(/\\/g, '/').split('/');
  for (const seg of segments) {
    if (excludedDirs.has(seg)) return false;
  }

  // Extension + language check.
  return detectLanguageForPath(relativePath, config) !== undefined;
}

/**
 * Check only directory exclusion rules, without filtering by extension.
 * Used by the watcher to skip changes in excluded dirs (node_modules, .git, etc.)
 * while still forwarding non-source files (e.g. coverage reports) to the pipeline.
 */
export function isExcludedPath(
  relativePath: string,
  config: Pick<WalkerConfig, 'excludeGlobs'>,
): boolean {
  const allExcludes = [...DEFAULT_EXCLUDES, ...(config.excludeGlobs ?? [])];
  const excludedDirs = new Set<string>();
  for (const p of allExcludes) {
    const m = /^\*\*\/([^/*]+)\/\*\*$/.exec(p);
    if (m?.[1]) excludedDirs.add(m[1]);
  }
  const segments = relativePath.replace(/\\/g, '/').split('/');
  for (const seg of segments) {
    if (excludedDirs.has(seg)) return true;
  }
  return false;
}
