/**
 * @module indexer/walker
 *
 * Walks a directory tree using fast-glob and maps each file to a detected
 * programming language based on its extension.
 */

import fg from 'fast-glob';
import { realpathSync } from 'node:fs';
import { extname } from 'node:path';

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
  '.h':    'c',
  '.rs':   'rust',
  '.py':   'python',
  '.cpp':  'cpp',
  '.cc':   'cpp',
  '.cxx':  'cpp',
  '.hpp':  'cpp',
  '.hxx':  'cpp',
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

// Paths always excluded unless the caller overrides them.
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__pycache__/**',
  '**/target/**',
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Walks `config.rootDir` and returns every source file that can be mapped
 * to a known programming language.
 */
export async function walkFiles(config: WalkerConfig): Promise<FileEntry[]> {
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

  const results: FileEntry[] = [];
  const seen = new Set<string>();

  for (const filePath of paths) {
    // Resolve symlinks to canonical paths so each physical file is indexed
    // once, regardless of how many symlinks point to it.
    const realPath = realpathSync(filePath);

    if (seen.has(realPath)) continue;
    seen.add(realPath);

    const ext = extname(realPath).toLowerCase();

    // Skip if caller supplied an explicit extension filter.
    if (extensions && !extensions.includes(ext)) continue;

    const language = EXT_TO_LANG[ext];
    if (!language) continue;

    results.push({ path: realPath, language });
  }

  return results;
}


/**
 * Detect the Lore language for a single file path using extension mapping.
 * Returns `undefined` when the extension is unknown or filtered out.
 */
export function detectLanguageForPath(filePath: string, config?: Pick<WalkerConfig, 'extensions'>): string | undefined {
  const ext = extname(filePath).toLowerCase();
  if (config?.extensions && !config.extensions.includes(ext)) return undefined;
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
