/**
 * @module indexer/walker
 *
 * Walks a directory tree using fast-glob and maps each file to a detected
 * programming language based on its extension.
 */

import fg from 'fast-glob';
import { extname } from 'node:path';
import { discoverDocumentationFiles, type DocumentationFile } from './docs.js';

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

  /**
   * Glob patterns (relative to `rootDir`) for documentation files to include.
   * When omitted, docs discovery uses default README/docs/ADR/design patterns.
   */
  docsIncludeGlobs?: string[];

  /**
   * Glob patterns (relative to `rootDir`) for documentation paths to exclude.
   */
  docsExcludeGlobs?: string[];

  /**
   * Explicit documentation extensions to accept (with leading dot).
   * Defaults to markdown/reStructuredText/AsciiDoc/text when omitted.
   */
  docsExtensions?: string[];
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
  '.dart': 'dart',
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
const DEFAULT_EXCLUDES = [
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
    ignore,
    dot: false,
  });

  const results: FileEntry[] = [];

  for (const filePath of paths) {
    const ext = extname(filePath).toLowerCase();

    // Skip if caller supplied an explicit extension filter.
    if (extensions && !extensions.includes(ext)) continue;

    const language = EXT_TO_LANG[ext];
    if (!language) continue;

    results.push({ path: filePath, language });
  }

  return results;
}

/**
 * Walks `config.rootDir` and returns documentation files discovered using
 * docs-focused defaults (README/docs/ADR/design patterns) and kind inference.
 */
export async function walkDocumentationFiles(config: WalkerConfig): Promise<DocumentationFile[]> {
  return discoverDocumentationFiles({
    rootDir: config.rootDir,
    includeGlobs: config.docsIncludeGlobs,
    excludeGlobs: config.docsExcludeGlobs,
    extensions: config.docsExtensions,
  });
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
