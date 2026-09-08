/**
 * @module scip/compdb
 *
 * Discover, parse, validate, and (when explicitly permitted) generate a
 * `compile_commands.json` for C/C++ projects.
 *
 * Lore automatically detects the build system and, only with explicit build
 * permission, generates the database if one doesn't already exist. Supported
 * build systems:
 *
 * | Build system | Detection                  | Strategy                    |
 * |-------------|----------------------------|-----------------------------|
 * | CMake       | CMakeLists.txt             | cmake -DCMAKE_EXPORT_...    |
 * | Meson       | meson.build                | meson setup                 |
 * | Make        | Makefile / configure       | bear -- make                |
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export type BuildSystem = 'cmake' | 'meson' | 'make' | 'none';

export type CompdbValidationStatus =
  | 'valid'
  | 'partial'
  | 'stale'
  | 'empty'
  | 'malformed'
  | 'unreadable'
  | 'relocated';

export interface CompdbValidation {
  valid: boolean;
  status: CompdbValidationStatus;
  totalEntries: number;
  wellFormedEntries: number;
  malformedEntries: number;
  existingFiles: number;
  missingFiles: number;
  existingDirectories: number;
  missingDirectories: number;
  /** Entries for which both the translation unit and working directory exist. */
  viableEntries: number;
  /** Entries whose source translation unit is rooted in this checkout. */
  entriesWithinRoot: number;
  /** Entries whose source and working directory both satisfy the root policy. */
  entriesWithinApprovedRoots: number;
  /** Well-formed entries rejected by the root policy. */
  entriesOutsideApprovedRoots: number;
  /** Entries that retained one or more unexpanded response-file arguments. */
  responseFileDegradedEntries: number;
  approvedRoots: string[];
  warnings: string[];
  reason?: string;
}

export interface CompilationCommandEntry {
  filePath: string;
  workingDirectory: string;
  arguments: string[];
  includePaths: string[];
  /** Language selected by compiler flags, driver, or translation-unit suffix. */
  language: 'c' | 'cpp' | 'unknown';
  /** Per-entry response-file expansion result and resource use. */
  responseFiles: ResponseFileExpansion;
}

export interface ResponseFileExpansion {
  status: 'complete' | 'degraded';
  /** Response-file operands consumed, including cached replays. */
  filesRead: number;
  /** Response-file content bytes consumed, including cached replays. */
  bytesRead: number;
  expandedTokens: number;
  expandedBytes: number;
  /** Reasons an original `@file` operand was retained instead of expanded. */
  diagnostics: string[];
}

export interface ResponseFileLimits {
  maxBytesPerFile: number;
  maxTotalBytesPerEntry: number;
  maxFilesPerEntry: number;
  maxDepth: number;
  maxExpandedTokensPerEntry: number;
  maxExpandedBytesPerEntry: number;
}

export interface CompilationIncludePaths {
  byFile: Map<string, string[]>;
  entries: Array<{ filePath: string; includePaths: string[] }>;
  /** Precomputed longest-common-directory lookup used for non-TU headers. */
  directoryIndex?: CompilationDirectoryIndexNode;
}

export interface CompilationDirectoryIndexNode {
  children: Map<string, CompilationDirectoryIndexNode>;
  candidateCount: number;
  commonIncludePaths: readonly string[] | null;
}

export interface LoadedCompilationDatabase {
  path: string;
  sha256: string;
  entries: CompilationCommandEntry[];
  includePaths: CompilationIncludePaths;
  validation: CompdbValidation;
}

export interface CompdbLoadResult {
  database: LoadedCompilationDatabase | null;
  validation: CompdbValidation;
}

export interface CompdbCandidateDiagnostic {
  path: string;
  validation: CompdbValidation;
}

export interface CompdbDiscoveryResult {
  database: LoadedCompilationDatabase | null;
  candidates: CompdbCandidateDiagnostic[];
}

export interface CompdbResult {
  path: string | null;
  buildSystem: BuildSystem;
  preExisting: boolean;
  database: LoadedCompilationDatabase | null;
  candidateDiagnostics: CompdbCandidateDiagnostic[];
  generationAttempted: boolean;
  /** Actionable reason no scip-clang-usable path could be returned. */
  failure?: string;
}

export interface EnsureCompilationDatabaseOptions {
  /** Permit running repository configuration/build commands. Defaults to false. */
  allowBuildExecution?: boolean;
  /** Abort build-system subprocesses when the enclosing index run is cancelled. */
  signal?: AbortSignal;
  /** Host-approved out-of-tree build roots containing generated translation units. */
  approvedExternalRoots?: readonly string[];
  /** Resource limits applied independently to every compilation entry. */
  responseFileLimits?: Partial<ResponseFileLimits>;
}

export interface CompdbPathPolicy {
  /** Host-approved out-of-tree build roots containing generated translation units. */
  approvedExternalRoots?: readonly string[];
  /** Resource limits applied independently to every compilation entry. */
  responseFileLimits?: Partial<ResponseFileLimits>;
}

/** Injectable I/O seam for testing. */
export interface CompdbIO {
  existsSync: (p: string) => boolean;
  /** Read UTF-8 text, rejecting content larger than `maxBytes` when supplied. */
  readFileSync: (p: string, maxBytes?: number) => string;
  mkdirSync: (p: string, opts?: { recursive: boolean }) => void;
  execFileAsync: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
}

export type CompdbReadIO = Pick<CompdbIO, 'existsSync' | 'readFileSync'>;

export const MAX_COMPDB_BYTES = 128 * 1024 * 1024;
export const DEFAULT_RESPONSE_FILE_LIMITS: Readonly<ResponseFileLimits> = Object.freeze({
  maxBytesPerFile: 1024 * 1024,
  maxTotalBytesPerEntry: 8 * 1024 * 1024,
  maxFilesPerEntry: 32,
  maxDepth: 4,
  maxExpandedTokensPerEntry: 100_000,
  maxExpandedBytesPerEntry: 8 * 1024 * 1024,
});
/** @deprecated Use `DEFAULT_RESPONSE_FILE_LIMITS.maxBytesPerFile`. */
export const MAX_RESPONSE_FILE_BYTES = DEFAULT_RESPONSE_FILE_LIMITS.maxBytesPerFile;
const MAX_DIAGNOSTIC_WARNINGS = 50;

// ─── Default I/O ──────────────────────────────────────────────────────────────

export function createDefaultCompdbIO(): CompdbIO {
  return {
    existsSync,
    readFileSync: readUtf8FileBounded,
    mkdirSync: (p, o) => mkdirSync(p, o),
    execFileAsync: (cmd, args, opts) => execFileAsync(cmd, args, {
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    } as Record<string, unknown>),
  };
}

function readUtf8FileBounded(filePath: string, maxBytes = MAX_COMPDB_BYTES): string {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) {
      throw new Error(`${basename(filePath)} exceeds the ${maxBytes}-byte read limit`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error(`${basename(filePath)} exceeds the ${maxBytes}-byte read limit`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

// ─── Shared discovery and parsing ─────────────────────────────────────────────

export function compilationDatabaseCandidates(rootDir: string): string[] {
  const root = resolve(rootDir);
  return [
    join(root, 'compile_commands.json'),
    join(root, 'build', 'compile_commands.json'),
    join(root, 'builddir', 'compile_commands.json'),
    join(root, '.lore-compdb', 'compile_commands.json'),
  ];
}

interface TokenizationResult {
  tokens: string[];
  warnings: string[];
}

/** Tokenize a compiler command without invoking a shell or expanding variables. */
export function tokenizeCompilerCommand(command: string): string[] {
  return tokenizeCommandLine(command).tokens;
}

function tokenizeCommandLine(command: string): TokenizationResult {
  const tokens: string[] = [];
  const warnings: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: 'single' | 'double' | null = null;

  const finishToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];

    if (quote === 'single') {
      if (char === "'") quote = null;
      else token += char;
      continue;
    }

    if (quote === 'double') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && (next === '"' || next === '\\')) {
        token += next;
        i++;
      } else {
        token += char;
      }
      continue;
    }

    if (/\s/u.test(char)) {
      finishToken();
    } else if (char === "'") {
      quote = 'single';
      tokenStarted = true;
    } else if (char === '"') {
      quote = 'double';
      tokenStarted = true;
    } else if (char === '\\' && next === '\n') {
      i++;
    } else if (char === '\\' && next !== undefined && (/\s/u.test(next) || next === '"' || next === "'" || next === '\\')) {
      token += next;
      tokenStarted = true;
      i++;
    } else {
      token += char;
      tokenStarted = true;
    }
  }

  if (quote) warnings.push(`unterminated ${quote}-quoted argument`);
  finishToken();
  return { tokens, warnings };
}

interface ResponseExpansionState {
  io: CompdbReadIO;
  warnings: string[];
  filesRead: number;
  bytesRead: number;
  stack: Set<string>;
  cache: Map<string, { tokens: string[]; bytes: number }>;
  limits: ResponseFileLimits;
  diagnostics: string[];
  expandedTokens: number;
  expandedBytes: number;
}

class ResponseExpansionLimitError extends Error {}

function expandResponseFiles(
  args: readonly string[],
  workingDirectory: string,
  state: ResponseExpansionState,
  depth = 0,
): string[] {
  const expanded: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('@@')) {
      appendExpandedArgument(expanded, arg.slice(1), state, depth > 0);
      continue;
    }
    if (!arg.startsWith('@') || arg.length === 1) {
      appendExpandedArgument(expanded, arg, state, depth > 0);
      continue;
    }
    if (depth >= state.limits.maxDepth) {
      retainUnexpandedResponseArg(
        expanded,
        arg,
        state,
        `response file nesting exceeds the per-entry depth limit ${state.limits.maxDepth}`,
        depth > 0,
      );
      continue;
    }
    const responsePath = isAbsolute(arg.slice(1))
      ? resolve(arg.slice(1))
      : resolve(workingDirectory, arg.slice(1));
    if (state.stack.has(responsePath)) {
      retainUnexpandedResponseArg(
        expanded,
        arg,
        state,
        `cyclic response file reference: ${responsePath}`,
        depth > 0,
      );
      continue;
    }

    const expandedTokenCheckpoint = state.expandedTokens;
    const expandedByteCheckpoint = state.expandedBytes;
    try {
      if (state.filesRead >= state.limits.maxFilesPerEntry) {
        retainUnexpandedResponseArg(
          expanded,
          arg,
          state,
          `response file count exceeds the per-entry limit ${state.limits.maxFilesPerEntry}`,
          depth > 0,
        );
        continue;
      }

      let cached = state.cache.get(responsePath);
      if (cached) {
        if (state.bytesRead + cached.bytes > state.limits.maxTotalBytesPerEntry) {
          retainUnexpandedResponseArg(
            expanded,
            arg,
            state,
            `response files exceed the ${state.limits.maxTotalBytesPerEntry}-byte per-entry aggregate limit`,
            depth > 0,
          );
          continue;
        }
        state.filesRead++;
        state.bytesRead += cached.bytes;
      } else {
        const remainingBytes = state.limits.maxTotalBytesPerEntry - state.bytesRead;
        if (remainingBytes <= 0) {
          retainUnexpandedResponseArg(
            expanded,
            arg,
            state,
            `response files exceed the ${state.limits.maxTotalBytesPerEntry}-byte per-entry aggregate limit`,
            depth > 0,
          );
          continue;
        }
        const readLimit = Math.min(state.limits.maxBytesPerFile, remainingBytes);
        state.filesRead++;
        const content = readBoundedText(state.io, responsePath, readLimit);
        state.bytesRead += Buffer.byteLength(content, 'utf8');
        const tokenized = tokenizeCommandLine(content);
        for (const warning of tokenized.warnings) {
          pushWarning(state.warnings, `${responsePath}: ${warning}`);
        }
        cached = {
          tokens: tokenized.tokens,
          bytes: Buffer.byteLength(content, 'utf8'),
        };
        state.cache.set(responsePath, cached);
      }
      state.stack.add(responsePath);
      try {
        for (const token of expandResponseFiles(
          cached.tokens,
          workingDirectory,
          state,
          depth + 1,
        )) {
          expanded.push(token);
        }
      } finally {
        state.stack.delete(responsePath);
      }
    } catch (error) {
      state.expandedTokens = expandedTokenCheckpoint;
      state.expandedBytes = expandedByteCheckpoint;
      retainUnexpandedResponseArg(
        expanded,
        arg,
        state,
        error instanceof ResponseExpansionLimitError
          ? error.message
          : `could not read response file ${responsePath}: ${error instanceof Error ? error.message : String(error)}`,
        depth > 0,
      );
    }
  }
  return expanded;
}

function retainUnexpandedResponseArg(
  expanded: string[],
  arg: string,
  state: ResponseExpansionState,
  reason: string,
  fromResponseFile: boolean,
): void {
  // Keeping the original operand is deliberate: callers can see that compiler
  // flags remain opaque instead of receiving a silently truncated argv.
  appendExpandedArgument(expanded, arg, state, fromResponseFile);
  if (state.diagnostics.length < MAX_DIAGNOSTIC_WARNINGS) state.diagnostics.push(reason);
  pushWarning(state.warnings, `${reason}; retained ${arg} unexpanded and include flags may be incomplete`);
}

function appendExpandedArgument(
  expanded: string[],
  argument: string,
  state: ResponseExpansionState,
  fromResponseFile: boolean,
): void {
  if (fromResponseFile) {
    const bytes = Buffer.byteLength(argument, 'utf8');
    if (state.expandedTokens >= state.limits.maxExpandedTokensPerEntry) {
      throw new ResponseExpansionLimitError(
        `response-file expansion exceeds the per-entry token limit ${state.limits.maxExpandedTokensPerEntry}`,
      );
    }
    if (state.expandedBytes + bytes > state.limits.maxExpandedBytesPerEntry) {
      throw new ResponseExpansionLimitError(
        `response-file expansion exceeds the ${state.limits.maxExpandedBytesPerEntry}-byte per-entry expanded-output limit`,
      );
    }
    state.expandedTokens++;
    state.expandedBytes += bytes;
  }
  expanded.push(argument);
}

function extractIncludePaths(
  args: readonly string[],
  workingDirectory: string,
  warnings: string[],
): string[] {
  const includePaths: string[] = [];
  const add = (value: string | undefined, flag: string): void => {
    if (value === undefined || value.length === 0) {
      pushWarning(warnings, `${flag} has no include-path operand`);
      return;
    }
    const unprefixed = value.startsWith('=') ? value.slice(1) : value;
    if (!unprefixed) {
      pushWarning(warnings, `${flag} has no include-path operand`);
      return;
    }
    const absolute = isAbsolute(unprefixed)
      ? resolve(unprefixed)
      : resolve(workingDirectory, unprefixed);
    if (!includePaths.includes(absolute)) includePaths.push(absolute);
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-I' || arg === '-iquote' || arg === '-isystem' || /^\/I$/iu.test(arg)) {
      add(args[i + 1], arg);
      if (args[i + 1] !== undefined) i++;
    } else if (arg.startsWith('-iquote') && arg.length > '-iquote'.length) {
      add(arg.slice('-iquote'.length), '-iquote');
    } else if (arg.startsWith('-isystem') && arg.length > '-isystem'.length) {
      add(arg.slice('-isystem'.length), '-isystem');
    } else if (arg.startsWith('-I') && arg.length > 2) {
      add(arg.slice(2), '-I');
    } else {
      const msvc = /^\/I(.+)$/iu.exec(arg);
      if (msvc) add(msvc[1], '/I');
    }
  }
  return includePaths;
}

function parseCompilationEntry(
  value: unknown,
  index: number,
  compdbPath: string,
  io: CompdbReadIO,
  warnings: string[],
  responseFileLimits: ResponseFileLimits,
): CompilationCommandEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    pushWarning(warnings, `entry ${index} is not an object`);
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.file !== 'string' || raw.file.trim().length === 0) {
    pushWarning(warnings, `entry ${index} has no file path`);
    return null;
  }
  if (raw.directory !== undefined && typeof raw.directory !== 'string') {
    pushWarning(warnings, `entry ${index} has a non-string directory`);
    return null;
  }

  const compdbDirectory = dirname(compdbPath);
  const directoryValue = typeof raw.directory === 'string' && raw.directory.trim().length > 0
    ? raw.directory
    : compdbDirectory;
  const workingDirectory = isAbsolute(directoryValue)
    ? resolve(directoryValue)
    : resolve(compdbDirectory, directoryValue);
  const filePath = isAbsolute(raw.file) ? resolve(raw.file) : resolve(workingDirectory, raw.file);

  let args: string[] | null = null;
  if (raw.arguments !== undefined) {
    if (Array.isArray(raw.arguments) && raw.arguments.length > 0 && raw.arguments.every(arg => typeof arg === 'string')) {
      args = [...raw.arguments] as string[];
    } else {
      pushWarning(warnings, `entry ${index} has invalid arguments; trying command`);
    }
  }
  if (!args && typeof raw.command === 'string' && raw.command.trim().length > 0) {
    const tokenized = tokenizeCommandLine(raw.command);
    args = tokenized.tokens;
    for (const warning of tokenized.warnings) {
      pushWarning(warnings, `entry ${index}: ${warning}`);
    }
  }
  if (!args || args.length === 0) {
    pushWarning(warnings, `entry ${index} has neither usable arguments nor command`);
    return null;
  }

  const responseState: ResponseExpansionState = {
    io,
    warnings,
    filesRead: 0,
    bytesRead: 0,
    stack: new Set(),
    cache: new Map(),
    limits: responseFileLimits,
    diagnostics: [],
    expandedTokens: 0,
    expandedBytes: 0,
  };
  const expandedArgs = expandResponseFiles(args, workingDirectory, responseState);
  return {
    filePath,
    workingDirectory,
    arguments: expandedArgs,
    includePaths: extractIncludePaths(expandedArgs, workingDirectory, warnings),
    language: inferCompilationLanguage(filePath, expandedArgs),
    responseFiles: {
      status: responseState.diagnostics.length > 0 ? 'degraded' : 'complete',
      filesRead: responseState.filesRead,
      bytesRead: responseState.bytesRead,
      expandedTokens: responseState.expandedTokens,
      expandedBytes: responseState.expandedBytes,
      diagnostics: responseState.diagnostics,
    },
  };
}

/** Infer the language mode selected for one compilation-database entry. */
export function inferCompilationLanguage(
  filePath: string,
  args: readonly string[],
): 'c' | 'cpp' | 'unknown' {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const explicit = argument === '-x' ? args[index + 1]
      : argument.startsWith('-x') && argument.length > 2 ? argument.slice(2)
        : argument.startsWith('--language=') ? argument.slice('--language='.length)
          : undefined;
    if (explicit) {
      const normalized = explicit.toLowerCase();
      if (normalized === 'c' || normalized === 'c-header') return 'c';
      if (normalized === 'c++' || normalized === 'c++-header'
        || normalized === 'objective-c++') return 'cpp';
    }
    if (/^\/TC(?:$|[^/])/iu.test(argument)) return 'c';
    if (/^\/TP(?:$|[^/])/iu.test(argument)) return 'cpp';
  }

  const compiler = basename(args[0] ?? '').toLowerCase();
  if (compiler.includes('++') || compiler === 'cl.exe' && args.some((arg) => /^\/TP/u.test(arg))) {
    return 'cpp';
  }

  const extension = filePath.slice(filePath.lastIndexOf('.'));
  if (extension === '.C') return 'cpp';
  switch (extension.toLowerCase()) {
    case '.c': return 'c';
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.c++': return 'cpp';
    default: return 'unknown';
  }
}

function readBoundedText(io: CompdbReadIO, filePath: string, maxBytes: number): string {
  const value = io.readFileSync(filePath, maxBytes);
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength > maxBytes) {
    throw new Error(`${basename(filePath)} exceeds the ${maxBytes}-byte read limit`);
  }
  return value;
}

function resolveResponseFileLimits(
  overrides: Partial<ResponseFileLimits> | undefined,
): ResponseFileLimits {
  const limits: ResponseFileLimits = {
    ...DEFAULT_RESPONSE_FILE_LIMITS,
    ...overrides,
  };
  for (const key of [
    'maxBytesPerFile',
    'maxTotalBytesPerEntry',
    'maxFilesPerEntry',
    'maxExpandedTokensPerEntry',
    'maxExpandedBytesPerEntry',
  ] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      throw new Error(`responseFileLimits.${key} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0) {
    throw new Error('responseFileLimits.maxDepth must be a non-negative safe integer');
  }
  return limits;
}

function pushWarning(warnings: string[], warning: string): void {
  if (warnings.length < MAX_DIAGNOSTIC_WARNINGS) warnings.push(warning);
}

function invalidValidation(
  status: Extract<CompdbValidationStatus, 'empty' | 'malformed' | 'unreadable'>,
  reason: string,
  totalEntries = 0,
  malformedEntries = 0,
  warnings: string[] = [],
): CompdbValidation {
  return {
    valid: false,
    status,
    totalEntries,
    wellFormedEntries: 0,
    malformedEntries,
    existingFiles: 0,
    missingFiles: 0,
    existingDirectories: 0,
    missingDirectories: 0,
    viableEntries: 0,
    entriesWithinRoot: 0,
    entriesWithinApprovedRoots: 0,
    entriesOutsideApprovedRoots: 0,
    responseFileDegradedEntries: 0,
    approvedRoots: [],
    warnings,
    reason,
  };
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const rel = relative(rootDir, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function isWithinAnyRoot(roots: readonly string[], candidate: string): boolean {
  const canonicalCandidate = canonicalForPolicy(candidate);
  return roots.some((root) => isWithinRoot(root, canonicalCandidate));
}

function canonicalForPolicy(candidate: string): string {
  try { return realpathSync(candidate); } catch { return resolve(candidate); }
}

function buildIncludePathIndex(entries: readonly CompilationCommandEntry[]): CompilationIncludePaths {
  const byFile = new Map<string, string[]>();
  for (const entry of entries) {
    const paths = byFile.get(entry.filePath) ?? [];
    for (const includePath of entry.includePaths) {
      if (!paths.includes(includePath)) paths.push(includePath);
    }
    byFile.set(entry.filePath, paths);
  }
  const mergedEntries = [...byFile].map(([filePath, includePaths]) => ({ filePath, includePaths }));
  const directoryIndex = createCompilationDirectoryNode();
  for (const entry of mergedEntries) {
    addCompilationDirectory(
      directoryIndex,
      portablePathComponents(dirname(entry.filePath)),
      entry.includePaths,
    );
  }
  return { byFile, entries: mergedEntries, directoryIndex };
}

export function emptyCompilationIncludePaths(): CompilationIncludePaths {
  return {
    byFile: new Map(),
    entries: [],
    directoryIndex: createCompilationDirectoryNode(),
  };
}

/**
 * Find include paths for a translation unit or the uniquely equivalent
 * nearest compilation directory. Loaded databases use a trie lookup bounded
 * by source path depth; the linear branch supports older injected fixtures.
 */
export function compilationIncludePathsForFile(
  compilationPaths: CompilationIncludePaths,
  fromFile: string,
): readonly string[] | null {
  const exact = compilationPaths.byFile.get(fromFile);
  if (exact !== undefined) return exact;

  if (compilationPaths.directoryIndex) {
    let node = compilationPaths.directoryIndex;
    for (const segment of portablePathComponents(dirname(fromFile))) {
      const child = node.children.get(segment);
      if (!child) break;
      node = child;
    }
    return node.commonIncludePaths;
  }

  const sourceSegments = portablePathComponents(dirname(fromFile));
  let best: readonly string[] | null = null;
  let bestScore = -1;
  let ambiguous = false;
  for (const entry of compilationPaths.entries) {
    const score = commonPathPrefixLength(
      sourceSegments,
      portablePathComponents(dirname(entry.filePath)),
    );
    if (score > bestScore) {
      best = entry.includePaths;
      bestScore = score;
      ambiguous = false;
    } else if (score === bestScore && best && !samePathList(best, entry.includePaths)) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

function createCompilationDirectoryNode(): CompilationDirectoryIndexNode {
  return {
    children: new Map(),
    candidateCount: 0,
    commonIncludePaths: null,
  };
}

function addCompilationDirectory(
  root: CompilationDirectoryIndexNode,
  segments: readonly string[],
  includePaths: readonly string[],
): void {
  let node = root;
  recordCompilationDirectory(node, includePaths);
  for (const segment of segments) {
    let child = node.children.get(segment);
    if (!child) {
      child = createCompilationDirectoryNode();
      node.children.set(segment, child);
    }
    node = child;
    recordCompilationDirectory(node, includePaths);
  }
}

function recordCompilationDirectory(
  node: CompilationDirectoryIndexNode,
  includePaths: readonly string[],
): void {
  if (node.candidateCount === 0) {
    node.commonIncludePaths = includePaths;
  } else if (node.commonIncludePaths && !samePathList(node.commonIncludePaths, includePaths)) {
    node.commonIncludePaths = null;
  }
  node.candidateCount++;
}

function portablePathComponents(filePath: string): string[] {
  return filePath.replace(/\\/gu, '/').split('/').filter(component => component && component !== '.');
}

function commonPathPrefixLength(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let score = 0;
  while (score < limit && left[score] === right[score]) score++;
  return score;
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Parse one compilation database and return both data and structured validity diagnostics. */
export function loadCompilationDatabase(
  compdbPath: string,
  io: CompdbReadIO = createDefaultCompdbIO(),
  rootDir = dirname(resolve(compdbPath)),
  policy: CompdbPathPolicy = {},
): CompdbLoadResult {
  const absolutePath = resolve(compdbPath);
  let rawText: string;
  try {
    rawText = readBoundedText(io, absolutePath, MAX_COMPDB_BYTES);
  } catch (error) {
    const reason = `could not read compilation database (${error instanceof Error ? error.message : String(error)})`;
    return { database: null, validation: invalidValidation('unreadable', reason) };
  }

  let rawEntries: unknown;
  try {
    rawEntries = JSON.parse(rawText) as unknown;
  } catch (error) {
    const reason = `invalid JSON (${error instanceof Error ? error.message : String(error)})`;
    return { database: null, validation: invalidValidation('malformed', reason) };
  }
  if (!Array.isArray(rawEntries)) {
    return {
      database: null,
      validation: invalidValidation('malformed', 'compilation database root must be an array'),
    };
  }
  if (rawEntries.length === 0) {
    return { database: null, validation: invalidValidation('empty', 'database has no entries') };
  }

  const warnings: string[] = [];
  const responseFileLimits = resolveResponseFileLimits(policy.responseFileLimits);
  const entries: CompilationCommandEntry[] = [];
  for (let index = 0; index < rawEntries.length; index++) {
    const entry = parseCompilationEntry(
      rawEntries[index],
      index,
      absolutePath,
      io,
      warnings,
      responseFileLimits,
    );
    if (entry) entries.push(entry);
  }

  const malformedEntries = rawEntries.length - entries.length;
  if (entries.length === 0) {
    return {
      database: null,
      validation: invalidValidation(
        'malformed',
        'database has no well-formed compilation entries',
        rawEntries.length,
        malformedEntries,
        warnings,
      ),
    };
  }

  const absoluteRoot = canonicalForPolicy(rootDir);
  const approvedRoots = [...new Set([
    absoluteRoot,
    ...(policy.approvedExternalRoots ?? []).map(canonicalForPolicy),
  ])];
  const existingFiles = entries.filter(entry => io.existsSync(entry.filePath)).length;
  const existingDirectories = entries.filter(entry => io.existsSync(entry.workingDirectory)).length;
  const viableEntries = entries.filter(entry =>
    io.existsSync(entry.filePath) && io.existsSync(entry.workingDirectory)).length;
  const entriesWithinRoot = entries.filter(entry =>
    isWithinRoot(absoluteRoot, canonicalForPolicy(entry.filePath))).length;
  const entriesWithinApprovedRoots = entries.filter(entry =>
    isWithinAnyRoot(approvedRoots, entry.filePath)
      && isWithinAnyRoot(approvedRoots, entry.workingDirectory),
  ).length;
  const entriesOutsideApprovedRoots = entries.length - entriesWithinApprovedRoots;
  const responseFileDegradedEntries = entries.filter(
    (entry) => entry.responseFiles.status === 'degraded',
  ).length;
  const missingFiles = entries.length - existingFiles;
  const missingDirectories = entries.length - existingDirectories;

  if (entriesOutsideApprovedRoots > 0) {
    const reason = `database appears wholly relocated or outside the approved roots: ${entriesOutsideApprovedRoots}/${entries.length} well-formed entries select a source file or working directory outside ${approvedRoots.join(', ')}`;
    const validation: CompdbValidation = {
      valid: false,
      status: 'relocated',
      totalEntries: rawEntries.length,
      wellFormedEntries: entries.length,
      malformedEntries,
      existingFiles,
      missingFiles,
      existingDirectories,
      missingDirectories,
      viableEntries,
      entriesWithinRoot,
      entriesWithinApprovedRoots,
      entriesOutsideApprovedRoots,
      responseFileDegradedEntries,
      approvedRoots,
      warnings,
      reason,
    };
    return { database: null, validation };
  }

  if (malformedEntries > 0) {
    pushWarning(warnings, `${malformedEntries}/${rawEntries.length} malformed entries were ignored`);
  }
  if (missingFiles > 0) {
    pushWarning(warnings, `${missingFiles}/${entries.length} source files are missing and may be generated during a build`);
  }
  if (missingDirectories > 0) {
    pushWarning(warnings, `${missingDirectories}/${entries.length} working directories are missing`);
  }

  const completelyStale = viableEntries === 0;
  const status: CompdbValidationStatus =
    completelyStale
      ? 'stale'
      : malformedEntries > 0 || missingFiles > 0 || missingDirectories > 0 || warnings.length > 0
      ? 'partial'
      : 'valid';
  const reason = completelyStale
    ? `database has zero viable source and working-directory pairs (${entries.length} well-formed entries); it is diagnostic-only and cannot be passed to scip-clang`
    : undefined;
  const validation: CompdbValidation = {
    valid: !completelyStale,
    status,
    totalEntries: rawEntries.length,
    wellFormedEntries: entries.length,
    malformedEntries,
    existingFiles,
    missingFiles,
    existingDirectories,
    missingDirectories,
    viableEntries,
    entriesWithinRoot,
    entriesWithinApprovedRoots,
    entriesOutsideApprovedRoots,
    responseFileDegradedEntries,
    approvedRoots,
    warnings,
    ...(reason && { reason }),
  };
  return {
    database: {
      path: absolutePath,
      sha256: createHash('sha256').update(rawText).digest('hex'),
      entries,
      includePaths: buildIncludePathIndex(entries),
      validation,
    },
    validation,
  };
}

/** Discover and load the first usable compilation database in candidate order. */
export function discoverCompilationDatabase(
  rootDir: string,
  io: CompdbReadIO = createDefaultCompdbIO(),
  policy: CompdbPathPolicy = {},
): CompdbDiscoveryResult {
  const candidates: CompdbCandidateDiagnostic[] = [];
  let viablePartialDatabase: LoadedCompilationDatabase | null = null;
  let diagnosticDatabase: LoadedCompilationDatabase | null = null;
  for (const candidate of compilationDatabaseCandidates(rootDir)) {
    if (!io.existsSync(candidate)) continue;
    const loaded = loadCompilationDatabase(candidate, io, rootDir, policy);
    candidates.push({ path: candidate, validation: loaded.validation });
    if (loaded.database?.validation.status === 'valid') {
      return { database: loaded.database, candidates };
    }
    if (loaded.database && isCompilationDatabaseUsableForScip(loaded.database)) {
      viablePartialDatabase ??= loaded.database;
    } else {
      diagnosticDatabase ??= loaded.database;
    }
  }
  return { database: viablePartialDatabase ?? diagnosticDatabase, candidates };
}

/** Compatibility wrapper returning only the selected compilation database path. */
export function findExistingCompdb(
  rootDir: string,
  io: CompdbReadIO = createDefaultCompdbIO(),
  policy: CompdbPathPolicy = {},
): string | null {
  const discovery = discoverCompilationDatabase(rootDir, io, policy);
  for (const candidate of discovery.candidates) {
    if (candidate.path === discovery.database?.path) continue;
    getLogger().indexing('compdb: ignoring unusable compilation database', {
      path: candidate.path,
      ...candidate.validation,
    });
  }
  return discovery.database && isCompilationDatabaseUsableForScip(discovery.database)
    ? discovery.database.path
    : null;
}

/** True only when scip-clang can consume at least one live compilation pair. */
export function isCompilationDatabaseUsableForScip(
  database: LoadedCompilationDatabase | null | undefined,
): boolean {
  return Boolean(database?.validation.valid && database.validation.viableEntries > 0);
}

export function validateCompilationDatabase(
  compdbPath: string,
  io: CompdbReadIO,
  rootDir = dirname(resolve(compdbPath)),
  policy: CompdbPathPolicy = {},
): CompdbValidation {
  return loadCompilationDatabase(compdbPath, io, rootDir, policy).validation;
}

export function detectBuildSystem(rootDir: string, io: Pick<CompdbIO, 'existsSync'> = { existsSync }): BuildSystem {
  if (io.existsSync(join(rootDir, 'CMakeLists.txt'))) return 'cmake';
  if (io.existsSync(join(rootDir, 'meson.build'))) return 'meson';
  if (io.existsSync(join(rootDir, 'Makefile')) || io.existsSync(join(rootDir, 'configure'))) return 'make';
  return 'none';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function ensureCompilationDatabase(
  rootDir: string,
  timeoutMs: number = 300_000,
  io: CompdbIO = createDefaultCompdbIO(),
  options: EnsureCompilationDatabaseOptions = {},
): Promise<CompdbResult> {
  options.signal?.throwIfAborted();
  const log = getLogger();
  const absRoot = resolve(rootDir);

  const pathPolicy: CompdbPathPolicy = {
    approvedExternalRoots: options.approvedExternalRoots,
    responseFileLimits: options.responseFileLimits,
  };
  const discovery = discoverCompilationDatabase(absRoot, io, pathPolicy);
  for (const candidate of discovery.candidates) {
    if (candidate.path === discovery.database?.path) continue;
    log.indexing('compdb: ignoring unusable compilation database', {
      path: candidate.path,
      ...candidate.validation,
    });
  }
  if (discovery.database && isCompilationDatabaseUsableForScip(discovery.database)) {
    log.indexing('compdb: found existing compilation database', {
      path: discovery.database.path,
      sha256: discovery.database.sha256,
      ...discovery.database.validation,
    });
    return {
      path: discovery.database.path,
      buildSystem: detectBuildSystem(absRoot, io),
      preExisting: true,
      database: discovery.database,
      candidateDiagnostics: discovery.candidates,
      generationAttempted: false,
    };
  }
  if (discovery.database) {
    log.indexing('compdb: existing database is diagnostic-only and will not be passed to scip-clang', {
      path: discovery.database.path,
      ...discovery.database.validation,
    });
  }

  const buildSystem = detectBuildSystem(absRoot, io);
  if (buildSystem === 'none') {
    log.indexing('compdb: no supported build system detected');
    return {
      path: null,
      buildSystem: 'none',
      preExisting: false,
      database: discovery.database,
      candidateDiagnostics: discovery.candidates,
      generationAttempted: false,
      failure: discovery.database?.validation.reason
        ?? 'no supported build system was detected for compilation database generation',
    };
  }

  if (options.allowBuildExecution !== true) {
    log.indexing('compdb: generation skipped because repository build execution is disabled', {
      buildSystem,
      allowBuildExecution: false,
    });
    return {
      path: null,
      buildSystem,
      preExisting: false,
      database: discovery.database,
      candidateDiagnostics: discovery.candidates,
      generationAttempted: false,
      failure: discovery.database?.validation.reason
        ?? 'compilation database generation is disabled by host policy',
    };
  }

  log.indexing(`compdb: detected ${buildSystem} build system, generating compile_commands.json...`);

  let generationFailure: string | undefined;
  try {
    const path = await generateCompdb(absRoot, buildSystem, timeoutMs, io, {
      allowBuildExecution: true,
      signal: options.signal,
    });
    if (path) {
      const loaded = loadCompilationDatabase(path, io, absRoot, pathPolicy);
      const candidateDiagnostics = [
        ...discovery.candidates,
        { path, validation: loaded.validation },
      ];
      if (loaded.database && isCompilationDatabaseUsableForScip(loaded.database)) {
        log.indexing('compdb: generated compilation database', {
          path,
          sha256: loaded.database.sha256,
          ...loaded.validation,
        });
        return {
          path,
          buildSystem,
          preExisting: false,
          database: loaded.database,
          candidateDiagnostics,
          generationAttempted: true,
        };
      }
      log.indexing('compdb: generated unusable compilation database', {
        path,
        ...loaded.validation,
      });
      return {
        path: null,
        buildSystem,
        preExisting: false,
        database: loaded.database ?? discovery.database,
        candidateDiagnostics,
        generationAttempted: true,
        failure: loaded.validation.reason ?? 'generated compilation database is unusable by scip-clang',
      };
    }
    log.indexing('compdb: build system configuration produced no compile_commands.json');
    generationFailure = 'build system configuration produced no compile_commands.json';
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr;
    log.indexing(`compdb: generation failed: ${msg}${stderr ? '\n' + stderr : ''}`);
    generationFailure = `compilation database generation failed: ${msg}`
      + (stderr ? `; ${stderr.trim().slice(-500)}` : '');
  }

  return {
    path: null,
    buildSystem,
    preExisting: false,
    database: discovery.database,
    candidateDiagnostics: discovery.candidates,
    generationAttempted: true,
    failure: generationFailure
      ?? discovery.database?.validation.reason
      ?? 'no usable compilation database was available',
  };
}

// ─── Generation ───────────────────────────────────────────────────────────────

export async function generateCompdb(
  rootDir: string,
  buildSystem: BuildSystem,
  timeoutMs: number,
  io: CompdbIO = createDefaultCompdbIO(),
  options: EnsureCompilationDatabaseOptions = {},
): Promise<string | null> {
  if (options.allowBuildExecution !== true) return null;
  options.signal?.throwIfAborted();
  switch (buildSystem) {
    case 'cmake': return generateCmakeCompdb(rootDir, timeoutMs, io, options.signal);
    case 'meson': return generateMesonCompdb(rootDir, timeoutMs, io, options.signal);
    case 'make':  return generateBearCompdb(rootDir, timeoutMs, io, options.signal);
    default:      return null;
  }
}

async function generateCmakeCompdb(
  rootDir: string,
  timeoutMs: number,
  io: CompdbIO,
  signal?: AbortSignal,
): Promise<string | null> {
  const buildDir = join(rootDir, '.lore-compdb');
  io.mkdirSync(buildDir, { recursive: true });
  await io.execFileAsync('cmake', ['-S', rootDir, '-B', buildDir, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'], {
    cwd: rootDir,
    timeout: timeoutMs,
    signal,
  });
  const result = join(buildDir, 'compile_commands.json');
  return io.existsSync(result) ? result : null;
}

async function generateMesonCompdb(
  rootDir: string,
  timeoutMs: number,
  io: CompdbIO,
  signal?: AbortSignal,
): Promise<string | null> {
  const log = getLogger();
  const buildDir = join(rootDir, '.lore-compdb');

  if (io.existsSync(join(buildDir, 'meson-private'))) {
    const result = join(buildDir, 'compile_commands.json');
    if (io.existsSync(result)) return result;
  }

  log.indexing(`compdb: running meson setup ${buildDir} (timeout: ${timeoutMs}ms)`);
  const { stderr } = await io.execFileAsync('meson', ['setup', buildDir], {
    cwd: rootDir,
    timeout: timeoutMs,
    signal,
  });
  if (stderr) log.indexing(`compdb: meson stderr: ${stderr.slice(-200)}`);

  const result = join(buildDir, 'compile_commands.json');
  const found = io.existsSync(result);
  log.indexing(`compdb: meson complete, compile_commands.json exists: ${found}`);
  return found ? result : null;
}

async function generateBearCompdb(
  rootDir: string,
  timeoutMs: number,
  io: CompdbIO,
  signal?: AbortSignal,
): Promise<string | null> {
  const log = getLogger();

  try {
    await io.execFileAsync('bear', ['--version'], { timeout: 5000, signal });
  } catch {
    log.indexing('compdb: bear not found — cannot generate compile_commands.json for Make projects. Install via: brew install bear / apt install bear');
    return null;
  }

  if (io.existsSync(join(rootDir, 'configure')) && !io.existsSync(join(rootDir, 'config.status'))) {
    try {
      await io.execFileAsync('./configure', [], { cwd: rootDir, timeout: timeoutMs, signal });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.indexing(`compdb: ./configure failed: ${msg}`);
    }
  }

  const buildDir = join(rootDir, '.lore-compdb');
  io.mkdirSync(buildDir, { recursive: true });
  const output = join(buildDir, 'compile_commands.json');
  // Respect the repository/user's MAKEFLAGS instead of imposing a fixed job count.
  await io.execFileAsync('bear', ['--output', output, '--', 'make'], {
    cwd: rootDir,
    timeout: timeoutMs,
    signal,
  });

  return io.existsSync(output) ? output : null;
}
