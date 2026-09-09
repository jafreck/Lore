import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import fg from 'fast-glob';
import {
  DEFAULT_EXCLUDES,
  SUPPORTED_WALKER_LANGUAGES,
  detectLanguageForPath,
  sourceExtension,
  walkFilePathsSync,
  type FileEntry,
  type WalkerConfig,
} from '../discovery/walker.js';
import type { LoadedCompilationDatabase } from './compdb.js';

export interface FilteredCompilationDatabaseIdentity {
  sourcePath: string;
  sourceSha256: string;
  sha256: string;
  scopeHash: string;
  entries: number;
  translationUnits: string[];
}

export interface ScipScope {
  languages: readonly string[];
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
}

export interface ResolvedScipScope {
  schemaVersion: 1;
  rootDir: string;
  requested: {
    languages: string[];
    includeGlobs: string[];
    excludeGlobs: string[];
  };
  walker: {
    includeGlobs: string[];
    excludeGlobs: string[];
    extensions: string[] | null;
  };
  effectiveFiles: Array<{ path: string; language: string }>;
  languageCounts: Record<string, number>;
  scopeHash: string;
}

function normalizeGlobs(globs: readonly string[] | undefined, defaults: string[]): string[] {
  const normalized = (globs ?? defaults).map((glob) => {
    if (typeof glob !== 'string' || !glob.trim() || glob.startsWith('!')
      || glob.includes('\\') || isAbsolute(glob) || glob.split('/').includes('..')) {
      throw new Error(`SCIP scope requires nonempty, root-relative globs: ${String(glob)}`);
    }
    return glob.replace(/^(\.\/)+/u, '');
  });
  return [...new Set(normalized)].sort();
}

export function canonicalScopeRequest(scope: ScipScope): ResolvedScipScope['requested'] {
  if (!Array.isArray(scope.languages) || scope.languages.length === 0) {
    throw new Error('SCIP scope requires at least one language');
  }
  const languages = [...new Set(scope.languages)].sort();
  for (const language of languages) {
    if (!SUPPORTED_WALKER_LANGUAGES.includes(language)) {
      throw new Error(`Unknown SCIP scope language: ${String(language)}`);
    }
  }
  return {
    languages,
    includeGlobs: normalizeGlobs(scope.includeGlobs, ['**/*']),
    excludeGlobs: normalizeGlobs(scope.excludeGlobs, []),
  };
}

export function canonicalScopedPath(rootDir: string, filePath: string): string {
  const lexicalPath = resolve(rootDir, filePath);
  const relativePath = relative(rootDir, lexicalPath);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`SCIP scope path escapes repository root: ${filePath}`);
  }
  const canonicalPath = realpathSync(lexicalPath);
  const canonicalRelative = relative(rootDir, canonicalPath);
  if (isAbsolute(canonicalRelative) || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)) {
    throw new Error(`SCIP scope symlink escapes repository root: ${filePath}`);
  }
  return canonicalPath;
}

export function resolveScipScope(
  walkerConfig: WalkerConfig,
  scope: ScipScope,
  walkerFiles: readonly FileEntry[],
): ResolvedScipScope {
  const rootDir = realpathSync(walkerConfig.rootDir);
  const requested = canonicalScopeRequest(scope);
  const matchingPaths = fg.sync(requested.includeGlobs, {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: true,
    ignore: [...DEFAULT_EXCLUDES, ...(walkerConfig.excludeGlobs ?? []), ...requested.excludeGlobs],
    dot: false,
  });
  const matchingPathSet = new Set(matchingPaths);
  const selectedPaths = new Set<string>();
  let walkerPaths: Set<string> | undefined;
  for (const filePath of matchingPaths) {
    const canonicalPath = realpathSync(filePath);
    const language = detectLanguageForPath(canonicalPath, walkerConfig);
    const cFamilyHeader = sourceExtension(canonicalPath) === '.h'
      && requested.languages.some(candidate => candidate === 'c' || candidate === 'cpp');
    if (!language || (!requested.languages.includes(language) && !cFamilyHeader)) continue;
    if (canonicalPath !== rootDir && !canonicalPath.startsWith(rootDir + sep)) {
      walkerPaths ??= new Set(walkFilePathsSync({ ...walkerConfig, rootDir }));
      if (walkerPaths.has(filePath)) canonicalScopedPath(rootDir, filePath);
      continue;
    }
    if (matchingPathSet.has(canonicalPath)) selectedPaths.add(canonicalPath);
  }
  const effectiveFiles = walkerFiles
    .filter((file) => requested.languages.includes(file.language) && selectedPaths.has(file.path))
    .map((file) => ({ path: relative(rootDir, file.path).split(sep).join('/'), language: file.language }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const languageCounts = Object.fromEntries(requested.languages.map((language) => [language, 0]));
  for (const file of effectiveFiles) languageCounts[file.language]!++;
  const walker = {
    includeGlobs: [...new Set(walkerConfig.includeGlobs?.length ? walkerConfig.includeGlobs : ['**/*'])].sort(),
    excludeGlobs: [...new Set(walkerConfig.excludeGlobs ?? [])].sort(),
    extensions: walkerConfig.extensions ? [...new Set(walkerConfig.extensions)].sort() : null,
  };
  const manifest = { schemaVersion: 1 as const, rootDir, requested, walker, effectiveFiles, languageCounts };
  return { ...manifest, scopeHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}

export function filterCompilationDatabase(
  database: LoadedCompilationDatabase,
  scope: ResolvedScipScope,
): { content: string; identity: FilteredCompilationDatabaseIdentity } {
  if (database.validation.status !== 'valid') {
    throw new Error(`Selected compilation database is ${database.validation.status}: ${database.validation.reason ?? database.validation.warnings.join('; ')}`);
  }
  const selectedPaths = new Set(scope.effectiveFiles
    .filter((file) => file.language === 'c' || file.language === 'cpp')
    .map((file) => resolve(scope.rootDir, file.path)));
  const commands = new Map<string, { directory: string; file: string; arguments: string[] }>();
  for (const entry of database.entries) {
    let file: string;
    try {
      file = canonicalScopedPath(scope.rootDir, entry.filePath);
    } catch {
      continue;
    }
    if (!selectedPaths.has(file)) continue;
    if (entry.responseFiles.status !== 'complete') {
      throw new Error(`Selected compilation entry has degraded response files: ${file}`);
    }
    const command = {
      directory: realpathSync(entry.workingDirectory),
      file,
      arguments: entry.arguments,
    };
    commands.set(JSON.stringify(command), command);
  }
  if (commands.size === 0) throw new Error('SCIP scope selects no compilation-database translation units');
  const entries = [...commands.keys()].sort().map((key) => commands.get(key)!);
  const content = `${JSON.stringify(entries, null, 2)}\n`;
  return {
    content,
    identity: {
      sourcePath: realpathSync(database.path),
      sourceSha256: database.sha256,
      sha256: createHash('sha256').update(content).digest('hex'),
      scopeHash: scope.scopeHash,
      entries: entries.length,
      translationUnits: [...new Set(entries.map((entry) =>
        relative(scope.rootDir, entry.file).split(sep).join('/')))].sort(),
    },
  };
}