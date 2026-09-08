/**
 * @module indexer/stages/import-resolution
 *
 * Pipeline stage: resolve raw import strings to file IDs (internal) or
 * external package names. Populates `file_imports.resolved_id` and
 * `external_deps` rows.
 */

import {
  throwIfPipelineCancelled,
  type PipelineContext,
  type PipelineStage,
} from '../pipeline.js';
import { ImportResolver } from '../../resolution/resolver.js';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  compilationIncludePathsForFile,
  discoverCompilationDatabase,
  type CompilationIncludePaths,
} from '../../scip/compdb.js';

const SOURCE_BATCH_SIZE = 128;
const IMPORT_BATCH_SIZE = 512;
const PATH_SCOPE_BATCH_SIZE = 128;

/** Extract literal C/C++ include directives. Macro-computed includes are skipped. */
export function extractCIncludes(source: string): string[] {
  const includes: string[] = [];
  const seen = new Set<string>();
  // Backslash-newline splicing precedes comment removal in C translation.
  const visibleSource = maskCComments(source.replace(/\\\r?\n/gu, ''));
  const directive = /^[\t ]*#[\t ]*include[\t ]*(?:"([^"\r\n]+)"|<([^>\r\n]+)>)[\t ]*$/gmu;
  for (let match = directive.exec(visibleSource); match; match = directive.exec(visibleSource)) {
    const quoted = match[1];
    const angled = match[2];
    if (quoted === undefined && angled === undefined) continue;
    const rawImport = angled !== undefined ? `<${angled}>` : quoted!;
    if (seen.has(rawImport)) continue;
    seen.add(rawImport);
    includes.push(rawImport);
  }
  return includes;
}

/** Replace C/C++ comments with whitespace while preserving strings and lines. */
function maskCComments(source: string): string {
  let result = '';
  let state: 'code' | 'block-comment' | 'line-comment' | 'string' | 'character' = 'code';
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    const next = source[index + 1];
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        result += '  ';
        index++;
        state = 'code';
      } else {
        result += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }
    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        result += character;
        state = 'code';
      } else {
        result += ' ';
      }
      continue;
    }
    if (state === 'string' || state === 'character') {
      result += character;
      if (character === '\n' || character === '\r') {
        state = 'code';
        escaped = false;
      } else if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (
        (state === 'string' && character === '"')
        || (state === 'character' && character === "'")
      ) {
        state = 'code';
      }
      continue;
    }

    if (character === '/' && next === '*') {
      result += '  ';
      index++;
      state = 'block-comment';
    } else if (character === '/' && next === '/') {
      result += '  ';
      index++;
      state = 'line-comment';
    } else {
      result += character;
      if (character === '"') state = 'string';
      else if (character === "'") state = 'character';
    }
  }
  return result;
}

interface IndexedPath {
  id: number;
  path: string;
  directorySegments: string[];
}

interface SuffixNode {
  children: Map<string, SuffixNode>;
  candidates: CandidateBucket;
}

interface CandidateBucket {
  ids: number[];
  directoryIndex?: CandidateDirectoryNode;
}

interface CandidateDirectoryNode {
  children: Map<string, CandidateDirectoryNode>;
  candidateCount: number;
  soleCandidateId: number | null;
}

export interface IncludeFallbackMatch {
  id: number;
  path: string;
  resolutionMethod:
    | 'include_basename_unique'
    | 'include_basename_nearest'
    | 'include_suffix_unique'
    | 'include_suffix_nearest';
}

/**
 * Reversed path-component trie used by C/C++ include fallback. Building it is
 * linear in indexed path components; each lookup visits only include-name
 * components plus the matching candidates, instead of scanning every file.
 */
export class IncludePathIndex {
  private readonly candidates = new Map<number, IndexedPath>();
  private readonly basenames = new Map<string, CandidateBucket>();
  private readonly suffixRoot: SuffixNode = {
    children: new Map(),
    candidates: { ids: [] },
  };
  private nodes = 1;

  add(id: number, filePath: string): void {
    const components = portableComponents(filePath);
    const name = components.at(-1);
    if (!name || this.candidates.has(id)) return;

    this.candidates.set(id, {
      id,
      path: filePath,
      directorySegments: components.slice(0, -1),
    });
    appendCandidate(this.basenames, name, id);

    let node = this.suffixRoot;
    for (let index = components.length - 1; index >= 0; index--) {
      const component = components[index]!;
      let child = node.children.get(component);
      if (!child) {
        child = { children: new Map(), candidates: { ids: [] } };
        node.children.set(component, child);
        this.nodes++;
      }
      child.candidates.ids.push(id);
      child.candidates.directoryIndex = undefined;
      node = child;
    }
  }

  resolve(fromFile: string, includeName: string): IncludeFallbackMatch | null {
    const components = portableComponents(includeName);
    if (components.length === 0 || components.includes('..')) return null;

    const isSuffix = components.length > 1;
    let bucket: CandidateBucket | undefined;
    if (!isSuffix) {
      bucket = this.basenames.get(components[0]!);
    } else {
      let node: SuffixNode | undefined = this.suffixRoot;
      for (let index = components.length - 1; index >= 0 && node; index--) {
        node = node.children.get(components[index]!);
      }
      bucket = node?.candidates;
    }
    if (!bucket || bucket.ids.length === 0) return null;

    const selected = this.selectUniquelyBest(fromFile, bucket);
    if (!selected) return null;
    const unique = bucket.ids.length === 1;
    return {
      id: selected.id,
      path: selected.path,
      resolutionMethod: isSuffix
        ? (unique ? 'include_suffix_unique' : 'include_suffix_nearest')
        : (unique ? 'include_basename_unique' : 'include_basename_nearest'),
    };
  }

  get stats(): { candidates: number; basenames: number; suffixNodes: number } {
    return {
      candidates: this.candidates.size,
      basenames: this.basenames.size,
      suffixNodes: this.nodes,
    };
  }

  private selectUniquelyBest(fromFile: string, bucket: CandidateBucket): IndexedPath | null {
    if (bucket.ids.length === 1) return this.candidates.get(bucket.ids[0]!) ?? null;

    if (!bucket.directoryIndex) {
      const root = createCandidateDirectoryNode();
      for (const id of bucket.ids) {
        const candidate = this.candidates.get(id);
        if (candidate) addDirectoryCandidate(root, candidate.directorySegments, id);
      }
      bucket.directoryIndex = root;
    }

    let node = bucket.directoryIndex;
    for (const segment of portableComponents(dirname(fromFile))) {
      const child = node.children.get(segment);
      if (!child) break;
      node = child;
    }
    return node.candidateCount === 1 && node.soleCandidateId !== null
      ? (this.candidates.get(node.soleCandidateId) ?? null)
      : null;
  }
}

function appendCandidate(index: Map<string, CandidateBucket>, key: string, id: number): void {
  const existing = index.get(key);
  if (existing) {
    existing.ids.push(id);
    existing.directoryIndex = undefined;
  }
  else index.set(key, { ids: [id] });
}

function createCandidateDirectoryNode(): CandidateDirectoryNode {
  return {
    children: new Map(),
    candidateCount: 0,
    soleCandidateId: null,
  };
}

function addDirectoryCandidate(
  root: CandidateDirectoryNode,
  segments: readonly string[],
  id: number,
): void {
  let node = root;
  recordDirectoryCandidate(node, id);
  for (const segment of segments) {
    let child = node.children.get(segment);
    if (!child) {
      child = createCandidateDirectoryNode();
      node.children.set(segment, child);
    }
    node = child;
    recordDirectoryCandidate(node, id);
  }
}

function recordDirectoryCandidate(node: CandidateDirectoryNode, id: number): void {
  node.candidateCount++;
  node.soleCandidateId = node.candidateCount === 1 ? id : null;
}

function portableComponents(filePath: string): string[] {
  return filePath.replace(/\\/gu, '/').split('/').filter(component => component && component !== '.');
}

// ─── Stage ────────────────────────────────────────────────────────────────────

/**
 * Resolves raw imports in `file_imports` to internal file IDs (`resolved_id`)
 * or external package names (`external_deps`).
 */
export class ImportResolutionStage implements PipelineStage {
  readonly name = 'import-resolution';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const { db, branch, walkerConfig } = context;
    const rootDir = walkerConfig.rootDir;
    const resolver = new ImportResolver();

    const scopePlaceholders = Array.from({ length: PATH_SCOPE_BATCH_SIZE }, () => '?').join(', ');
    const idPlaceholders = Array.from({ length: SOURCE_BATCH_SIZE }, () => '?').join(', ');
    const selectBaselineSources = db.prepare(
      `SELECT id, path, source
       FROM effective_files
       WHERE branch = ? AND language IN ('c', 'cpp') AND id > ?
       ORDER BY id
       LIMIT ?`,
    );
    const selectOverlaySources = db.prepare(
      `SELECT id, path, source
       FROM effective_files
       WHERE branch = ? AND language IN ('c', 'cpp')
         AND layer = 'overlay' AND path IN (${scopePlaceholders})
       ORDER BY id`,
    );
    const selectExistingImports = db.prepare(
      `SELECT file_id, raw_import
       FROM effective_file_imports
       WHERE file_id IN (${idPlaceholders})`,
    );
    const insertImport = db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, layer, generation) VALUES (?, ?, ?, ?)',
    );
    const insertIncludes = db.transaction((sourceFiles: readonly CSourceRow[]) => {
      const ids = sourceFiles.map(file => file.id);
      const paddedIds = padParameters(ids, SOURCE_BATCH_SIZE, -1);
      const existingImports = new Set(
        (selectExistingImports.all(...paddedIds) as ExistingImportRow[])
          .map(row => `${row.file_id}\0${row.raw_import}`),
      );
      let inserted = 0;
      for (const file of sourceFiles) {
        for (const rawImport of extractCIncludes(file.source)) {
          const key = `${file.id}\0${rawImport}`;
          if (existingImports.has(key)) continue;
          insertImport.run(file.id, rawImport, context.layer, context.generation);
          existingImports.add(key);
          inserted++;
        }
      }
      return inserted;
    });

    // scip-clang does not emit SCIP Import-role occurrences. Populate literal
    // include directives from stored source snapshots before resolution. Blob
    // reads are bounded and overlay runs query only files in the current run.
    let includesExtracted = 0;
    if (context.layer === 'overlay') {
      const overlayPaths = scopedPaths(context);
      for (let offset = 0; offset < overlayPaths.length; offset += PATH_SCOPE_BATCH_SIZE) {
        throwIfPipelineCancelled(context);
        const pathBatch = overlayPaths.slice(offset, offset + PATH_SCOPE_BATCH_SIZE);
        const parameters = padParameters(pathBatch, PATH_SCOPE_BATCH_SIZE, null);
        const sourceFiles = selectOverlaySources.all(branch, ...parameters) as CSourceRow[];
        if (sourceFiles.length > 0) includesExtracted += insertIncludes(sourceFiles);
      }
    } else {
      let afterId = 0;
      for (;;) {
        throwIfPipelineCancelled(context);
        const sourceFiles = selectBaselineSources.all(
          branch,
          afterId,
          SOURCE_BATCH_SIZE,
        ) as CSourceRow[];
        if (sourceFiles.length === 0) break;
        includesExtracted += insertIncludes(sourceFiles);
        afterId = sourceFiles.at(-1)!.id;
        if (sourceFiles.length < SOURCE_BATCH_SIZE) break;
      }
    }

    // Build exact and suffix indexes in one streaming pass. Only path metadata
    // is retained; source blobs never enter these maps.
    const fileIdByPath = new Map<string, number>();
    const includePathIndex = new IncludePathIndex();
    const selectIndexedPaths = db.prepare(
      'SELECT id, path, language FROM effective_files WHERE branch = ? ORDER BY id',
    );
    let indexedPathCount = 0;
    for (const file of selectIndexedPaths.iterate(branch) as IterableIterator<IndexedFileRow>) {
      fileIdByPath.set(file.path, file.id);
      if (file.language === 'c' || file.language === 'cpp') {
        includePathIndex.add(file.id, file.path);
      }
      if ((++indexedPathCount & 1023) === 0) throwIfPipelineCancelled(context);
    }

    let compdbLogged = false;
    const compilationPathsBySource = new Map<string, readonly string[] | null>();
    const canonicalPathCache = new Map<string, string | null>();
    const getCompilationIncludePaths = (): CompilationIncludePaths | null => {
      const discovery = context.compilationDatabase
        ?? (context.compilationDatabase = discoverCompilationDatabase(rootDir, undefined, {
          approvedExternalRoots: context.approvedExternalBuildRoots
            ?? context.scip?.allowedCwdRoots
            ?? [],
          responseFileLimits: context.responseFileLimits,
        }));
      if (!compdbLogged) {
        for (const candidate of discovery.candidates) {
          if (candidate.path === discovery.database?.path) continue;
          context.log.indexing('compdb: import resolution ignored unusable candidate', {
            path: candidate.path,
            ...candidate.validation,
          });
        }
        compdbLogged = true;
      }
      return discovery.database?.includePaths ?? null;
    };

    const updateResolved = db.prepare(
      'UPDATE file_imports SET resolved_id = ?, resolution_method = ? WHERE id = ?',
    );
    const markExternal = db.prepare(
      "UPDATE file_imports SET resolved_id = NULL, resolution_method = 'external_dependency' WHERE id = ?",
    );
    const insertExternalDep = db.prepare(
      `INSERT OR IGNORE INTO external_deps
         (file_id, package, layer, generation)
       VALUES (?, ?, ?, ?)`,
    );
    let internalResolved = 0;
    let externalResolved = 0;
    let heuristicResolved = 0;
    const processImports = db.transaction((rows: readonly UnresolvedImportRow[]) => {
      for (const row of rows) {
        const resolved = resolver.resolve(
          { source: row.raw_import, importedNames: [] },
          row.path,
          rootDir,
          row.language,
        );

        if (resolved.resolvedPath) {
          let targetId = fileIdByPath.get(resolved.resolvedPath);
          if (targetId === undefined) {
            const canonical = canonicalPath(resolved.resolvedPath, canonicalPathCache);
            if (canonical) targetId = fileIdByPath.get(canonical);
          }
          if (targetId !== undefined) {
            updateResolved.run(targetId, 'filesystem_exact', row.id);
            internalResolved++;
            continue;
          }
        } else if (row.language === 'c' || row.language === 'cpp') {
          // Build-system include paths are not represented in the source text.
          const includeName = row.raw_import.replace(/^<|>$/g, '').replace(/\\/g, '/');
          const compilationIncludePaths = getCompilationIncludePaths();
          const compileResolved = compilationIncludePaths && resolveFromCompilationIncludes(
            row.path,
            includeName,
            compilationIncludePaths,
            fileIdByPath,
            compilationPathsBySource,
            canonicalPathCache,
          );
          if (compileResolved) {
            updateResolved.run(compileResolved.id, 'compilation_database', row.id);
            internalResolved++;
            continue;
          }

          const fallback = includePathIndex.resolve(row.path, includeName);
          if (fallback) {
            updateResolved.run(fallback.id, fallback.resolutionMethod, row.id);
            heuristicResolved++;
            continue;
          }

          if (resolved.isExternal && resolved.externalName) {
            insertExternalDep.run(
              row.file_id,
              resolved.externalName,
              context.layer,
              context.generation,
            );
            markExternal.run(row.id);
            externalResolved++;
          }
        } else if (resolved.isExternal && resolved.externalName) {
          insertExternalDep.run(
            row.file_id,
            resolved.externalName,
            context.layer,
            context.generation,
          );
          markExternal.run(row.id);
          externalResolved++;
        }
      }
    });

    const unresolvedSelect = `SELECT fi.id, fi.file_id, fi.raw_import, f.path, f.language
       FROM effective_file_imports fi
       JOIN effective_files f ON f.id = fi.file_id
      WHERE fi.resolved_id IS NULL
        AND fi.resolution_method IN ('unresolved', 'overlay_stale')
        AND f.branch = ?`;
    const selectBaselineImports = db.prepare(
      `${unresolvedSelect} AND fi.id > ? ORDER BY fi.id LIMIT ?`,
    );
    const selectOverlayImports = db.prepare(
      `${unresolvedSelect} AND fi.id > ? ORDER BY fi.id LIMIT ?`,
    );
    let totalUnresolved = 0;
    if (context.layer === 'overlay') {
      let afterId = 0;
      for (;;) {
        throwIfPipelineCancelled(context);
        const rows = selectOverlayImports.all(
          branch,
          afterId,
          IMPORT_BATCH_SIZE,
        ) as UnresolvedImportRow[];
        if (rows.length === 0) break;
        processImports(rows);
        totalUnresolved += rows.length;
        afterId = rows.at(-1)!.id;
        if (rows.length < IMPORT_BATCH_SIZE) break;
      }
    } else {
      let afterId = 0;
      for (;;) {
        throwIfPipelineCancelled(context);
        const rows = selectBaselineImports.all(
          branch,
          afterId,
          IMPORT_BATCH_SIZE,
        ) as UnresolvedImportRow[];
        if (rows.length === 0) break;
        processImports(rows);
        totalUnresolved += rows.length;
        afterId = rows.at(-1)!.id;
        if (rows.length < IMPORT_BATCH_SIZE) break;
      }
    }

    context.log.indexing('imports resolved', {
      totalUnresolved,
      includesExtracted,
      indexedPaths: fileIdByPath.size,
      includeIndex: includePathIndex.stats,
      internalResolved,
      externalResolved,
      heuristicResolved,
    });
  }
}

interface CSourceRow {
  id: number;
  path: string;
  source: string;
}

interface ExistingImportRow {
  file_id: number;
  raw_import: string;
}

interface IndexedFileRow {
  id: number;
  path: string;
  language: string;
}

interface UnresolvedImportRow {
  id: number;
  file_id: number;
  raw_import: string;
  path: string;
  language: string;
}

function scopedPaths(context: PipelineContext): string[] {
  return [...new Set(context.files.map(file => file.path))].sort();
}

function padParameters<T>(values: readonly T[], size: number, padding: T): T[] {
  if (values.length >= size) return [...values];
  return [...values, ...Array.from({ length: size - values.length }, () => padding)];
}

function resolveFromCompilationIncludes(
  fromFile: string,
  includeName: string,
  compilationPaths: CompilationIncludePaths,
  fileIdByPath: Map<string, number>,
  pathsBySource: Map<string, readonly string[] | null>,
  canonicalPathCache: Map<string, string | null>,
): { id: number; path: string } | null {
  let includePaths = pathsBySource.get(fromFile);
  if (includePaths === undefined) {
    includePaths = compilationIncludePathsForFile(compilationPaths, fromFile);
    pathsBySource.set(fromFile, includePaths);
  }
  if (!includePaths) return null;

  for (const includePath of includePaths) {
    const candidate = resolve(includePath, includeName);
    const directId = fileIdByPath.get(candidate);
    if (directId !== undefined) return { id: directId, path: candidate };
    const canonical = canonicalPath(candidate, canonicalPathCache);
    const canonicalId = canonical ? fileIdByPath.get(canonical) : undefined;
    if (canonical && canonicalId !== undefined) return { id: canonicalId, path: canonical };
  }
  return null;
}

function canonicalPath(
  filePath: string,
  cache: Map<string, string | null>,
): string | null {
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;
  try {
    const canonical = realpathSync(filePath);
    cache.set(filePath, canonical);
    return canonical;
  } catch {
    cache.set(filePath, null);
    return null;
  }
}
export const IMPORT_RESOLUTION_BATCH_LIMITS = Object.freeze({
  sourceRows: SOURCE_BATCH_SIZE,
  unresolvedImports: IMPORT_BATCH_SIZE,
  overlayPaths: PATH_SCOPE_BATCH_SIZE,
});

export type ImportResolutionBatchLimits = typeof IMPORT_RESOLUTION_BATCH_LIMITS;
