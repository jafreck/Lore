/**
 * @module lore-server/tools/blame
 *
 * MCP tool: line-level git blame, line-range history, and ownership metadata.
 */

import { execFileSync } from 'node:child_process';
import { dirname, relative } from 'node:path';
import type { Database } from '../../db/read-only.js';
import {
  getCommitBySha,
  getFileByPath,
  listFilesByPathPrefix,
  resolveSymbolRangeByName,
  type SymbolRangeMatch,
} from '../../db/read-only.js';
import { enrichCommitsWithContext, type CommitWithFiles } from './history.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_blame',
  description:
    'Return git blame metadata for a file line/range, full line-range history, ' +
    'or ownership aggregates. Supports symbol-based range targeting.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute file path as stored in the knowledge-base index.',
      },
      line: {
        type: 'number',
        description: 'Single line number to blame (1-based).',
      },
      start_line: {
        type: 'number',
        description: 'Range start line (1-based, inclusive).',
      },
      end_line: {
        type: 'number',
        description: 'Range end line (1-based, inclusive). Defaults to start_line.',
      },
      ref: {
        type: 'string',
        description: 'Git ref to blame against (default: HEAD).',
      },
      branch: {
        type: 'string',
        description: 'Optional indexed branch to disambiguate file lookup.',
      },
      mode: {
        type: 'string',
        enum: ['blame', 'history', 'ownership'],
        description: 'Query mode (default: "blame").',
      },
      symbol: {
        type: 'string',
        description: 'Optional symbol name to resolve to an indexed file + line range.',
      },
      scope: {
        type: 'string',
        enum: ['file', 'directory'],
        description: 'Ownership mode scope. If omitted, inferred from `path`.',
      },
    },
    required: [],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export type BlameMode = 'blame' | 'history' | 'ownership';

export interface BlameArgs {
  path?: string;
  line?: number;
  start_line?: number;
  end_line?: number;
  ref?: string;
  branch?: string;
  mode?: BlameMode;
  symbol?: string;
  scope?: 'file' | 'directory';
}

export interface BlameLine {
  line: number;
  commit_sha: string;
  author: string;
  author_email: string;
  timestamp: number;
  summary: string;
  text: string;
}

export interface BlameRiskSignals {
  recency: {
    latest_timestamp: number | null;
    days_since_latest: number | null;
    level: 'low' | 'medium' | 'high' | 'unknown';
  };
  author_dispersion: {
    distinct_authors: number;
    sample_size: number;
    ratio: number;
    level: 'low' | 'medium' | 'high' | 'unknown';
  };
  churn: {
    total_churn: number;
    commit_count: number;
    average_churn_per_commit: number;
    level: 'low' | 'medium' | 'high' | 'unknown';
  };
  overall: 'low' | 'medium' | 'high' | 'unknown';
}

export interface ResolvedBlameSymbol {
  name: string;
  kind: string;
  path: string;
  branch: string;
  start_line: number;
  end_line: number;
}

export interface BlameResult {
  path: string;
  ref: string;
  start_line: number;
  end_line: number;
  lines: BlameLine[];
  commits?: CommitWithFiles[];
  risk?: BlameRiskSignals;
  resolved_symbol?: ResolvedBlameSymbol;
}

export interface BlameHistoryEntry {
  commit_sha: string;
  author: string;
  author_email: string;
  timestamp: number;
  summary: string;
  patch: string;
  commit_context?: CommitWithFiles;
}

export interface BlameHistoryResult {
  mode: 'history';
  path: string;
  ref: string;
  start_line: number;
  end_line: number;
  count: number;
  history: BlameHistoryEntry[];
  commits: CommitWithFiles[];
  risk: BlameRiskSignals;
  resolved_symbol?: ResolvedBlameSymbol;
}

export interface OwnershipAuthor {
  author: string;
  author_email: string;
  lines: number;
  share: number;
  commit_count: number;
}

export interface BlameOwnershipResult {
  mode: 'ownership';
  scope: 'file' | 'directory';
  path: string;
  ref: string;
  files_analyzed: number;
  start_line?: number;
  end_line?: number;
  total_lines: number;
  ownership: OwnershipAuthor[];
  commits: CommitWithFiles[];
  risk: BlameRiskSignals;
  resolved_symbol?: ResolvedBlameSymbol;
}

interface BlameMeta {
  author?: string;
  author_email?: string;
  timestamp?: number;
  summary?: string;
}

interface ResolvedFileTarget {
  path: string;
  branch?: string;
  ref: string;
  start_line?: number;
  end_line?: number;
  symbol?: SymbolRangeMatch;
}

interface GitPath {
  repoRoot: string;
  relPath: string;
}

function resolveRange(args: BlameArgs): { start: number; end: number } | undefined {
  if (args.line != null) {
    const line = Math.max(1, Math.floor(args.line));
    return { start: line, end: line };
  }

  if (args.start_line != null || args.end_line != null) {
    const start = Math.max(1, Math.floor(args.start_line ?? args.end_line ?? 1));
    const end = Math.max(start, Math.floor(args.end_line ?? start));
    return { start, end };
  }

  return undefined;
}

function ensureRange(args: BlameArgs, symbol?: SymbolRangeMatch): { start: number; end: number } {
  const range = resolveRange(args);
  if (range) return range;
  if (symbol) return { start: symbol.start_line, end: symbol.end_line };
  throw new Error('Provide either `line`, `start_line`/`end_line`, or `symbol`.');
}

function normalizeRef(ref?: string): string {
  const trimmed = ref?.trim();
  return trimmed ? trimmed : 'HEAD';
}

function toResolvedSymbol(symbol: SymbolRangeMatch | undefined): ResolvedBlameSymbol | undefined {
  if (!symbol) return undefined;
  return {
    name: symbol.symbol_name,
    kind: symbol.symbol_kind,
    path: symbol.file_path,
    branch: symbol.branch,
    start_line: symbol.start_line,
    end_line: symbol.end_line,
  };
}

function resolveFileTarget(
  db: Database.Database,
  args: BlameArgs,
  options: { requireRange: boolean },
): ResolvedFileTarget {
  const pathFromArgs = args.path?.trim();
  const branchFromArgs = args.branch?.trim();
  const symbolName = args.symbol?.trim();

  let symbolMatch: SymbolRangeMatch | undefined;
  if (symbolName) {
    const symbolResolution = resolveSymbolRangeByName(db, symbolName, {
      path: pathFromArgs,
      branch: branchFromArgs,
    });

    if (symbolResolution.outcome === 'missing') {
      throw new Error(`Symbol not found in index: ${symbolName}`);
    }
    if (symbolResolution.outcome === 'ambiguous') {
      const preview = symbolResolution.candidates
        .slice(0, 5)
        .map((candidate) => `${candidate.file_path}:${candidate.start_line}-${candidate.end_line}@${candidate.branch}`)
        .join(', ');
      throw new Error(`Symbol is ambiguous: ${symbolName}. Candidates: ${preview}`);
    }
    symbolMatch = symbolResolution.match;
  }

  const resolvedPath = pathFromArgs ?? symbolMatch?.file_path;
  if (!resolvedPath) {
    throw new Error('`path` is required when `symbol` is not provided.');
  }

  const resolvedBranch = branchFromArgs ?? symbolMatch?.branch;
  const fileRow = getFileByPath(db, resolvedPath, resolvedBranch);
  if (!fileRow) {
    throw new Error(`File not found in index: ${resolvedPath}`);
  }

  const resolvedRange = options.requireRange
    ? ensureRange(args, symbolMatch)
    : resolveRange(args) ?? (symbolMatch ? { start: symbolMatch.start_line, end: symbolMatch.end_line } : undefined);

  return {
    path: resolvedPath,
    branch: resolvedBranch,
    ref: normalizeRef(args.ref),
    start_line: resolvedRange?.start,
    end_line: resolvedRange?.end,
    symbol: symbolMatch,
  };
}

export const gitRootCache = new Map<string, string>();

function resolveGitPath(filePath: string): GitPath {
  const dir = dirname(filePath);
  const cached = gitRootCache.get(dir);
  let repoRoot: string;
  if (cached !== undefined) {
    repoRoot = cached;
  } else {
    try {
      repoRoot = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim();
      gitRootCache.set(dir, repoRoot);
    } catch {
      throw new Error(`Unable to resolve git repository root for path: ${filePath}`);
    }
  }

  const relPath = relative(repoRoot, filePath);
  if (relPath.startsWith('..')) {
    throw new Error(`Path is outside git repository root: ${filePath}`);
  }
  return { repoRoot, relPath };
}

function parseBlamePorcelain(output: string): BlameLine[] {
  const lines = output.split('\n');
  const results: BlameLine[] = [];

  const metaBySha = new Map<string, BlameMeta>();

  let currentSha = '';
  let currentFinalLine = 0;
  let remainingSourceLines = 0;

  for (const rawLine of lines) {
    const headerMatch = rawLine.match(/^([^\s]+)\s+\d+\s+(\d+)\s+(\d+)$/);
    if (headerMatch) {
      currentSha = headerMatch[1] ?? '';
      currentFinalLine = parseInt(headerMatch[2] ?? '0', 10);
      remainingSourceLines = parseInt(headerMatch[3] ?? '0', 10);
      if (!metaBySha.has(currentSha)) metaBySha.set(currentSha, {});
      continue;
    }

    if (!currentSha) continue;

    const meta = metaBySha.get(currentSha) ?? {};

    if (rawLine.startsWith('author ')) {
      meta.author = rawLine.slice('author '.length);
      metaBySha.set(currentSha, meta);
      continue;
    }

    if (rawLine.startsWith('author-mail ')) {
      meta.author_email = rawLine.slice('author-mail '.length).replace(/^<|>$/g, '');
      metaBySha.set(currentSha, meta);
      continue;
    }

    if (rawLine.startsWith('author-time ')) {
      const ts = parseInt(rawLine.slice('author-time '.length), 10);
      if (Number.isFinite(ts)) meta.timestamp = ts;
      metaBySha.set(currentSha, meta);
      continue;
    }

    if (rawLine.startsWith('summary ')) {
      meta.summary = rawLine.slice('summary '.length);
      metaBySha.set(currentSha, meta);
      continue;
    }

    if (rawLine.startsWith('\t') && remainingSourceLines > 0) {
      results.push({
        line: currentFinalLine,
        commit_sha: currentSha,
        author: meta.author ?? 'unknown',
        author_email: meta.author_email ?? '',
        timestamp: meta.timestamp ?? 0,
        summary: meta.summary ?? '',
        text: rawLine.slice(1),
      });
      currentFinalLine += 1;
      remainingSourceLines -= 1;
    }
  }

  return results;
}

function runBlamePorcelain(
  repoRoot: string,
  relPath: string,
  ref: string,
  start?: number,
  end?: number,
): BlameLine[] {
  const blameArgs = ['-C', repoRoot, 'blame', '--line-porcelain'];
  if (start != null && end != null) {
    blameArgs.push('-L', `${start},${end}`);
  }
  blameArgs.push(ref, '--', relPath);

  let output = '';
  try {
    output = execFileSync('git', blameArgs, { encoding: 'utf8' });
  } catch {
    if (start != null && end != null) {
      throw new Error(`git blame failed for ${relPath}:${start}-${end} at ref ${ref}.`);
    }
    throw new Error(`git blame failed for ${relPath} at ref ${ref}.`);
  }

  return parseBlamePorcelain(output);
}

function parseHistoryOutput(output: string): BlameHistoryEntry[] {
  const entries: BlameHistoryEntry[] = [];
  const lines = output.split('\n');
  let current: BlameHistoryEntry | undefined;
  let patchLines: string[] = [];

  for (const rawLine of lines) {
    const parts = rawLine.split('\u001f');
    const looksLikeHeader =
      parts.length === 5 &&
      /^[0-9a-f]{7,40}$/i.test(parts[0] ?? '') &&
      Number.isFinite(Number(parts[3]));

    if (looksLikeHeader) {
      if (current) {
        current.patch = patchLines.join('\n').trim();
        entries.push(current);
      }
      current = {
        commit_sha: parts[0] ?? '',
        author: parts[1] ?? '',
        author_email: parts[2] ?? '',
        timestamp: Number(parts[3] ?? 0),
        summary: parts[4] ?? '',
        patch: '',
      };
      patchLines = [];
      continue;
    }

    if (current) {
      patchLines.push(rawLine);
    }
  }

  if (current) {
    current.patch = patchLines.join('\n').trim();
    entries.push(current);
  }

  return entries;
}

function runHistoryLog(
  repoRoot: string,
  relPath: string,
  ref: string,
  start: number,
  end: number,
): BlameHistoryEntry[] {
  let output = '';
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        repoRoot,
        'log',
        '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s',
        '-L',
        `${start},${end}:${relPath}`,
        ref,
      ],
      { encoding: 'utf8' },
    );
  } catch {
    throw new Error(`git log -L failed for ${relPath}:${start}-${end} at ref ${ref}.`);
  }

  return parseHistoryOutput(output);
}

function buildCommitContextMap(
  db: Database.Database,
  shas: string[],
): Map<string, CommitWithFiles> {
  const uniqueShas = Array.from(new Set(shas));
  if (uniqueShas.length === 0) return new Map();

  const commitRows = uniqueShas
    .map((sha) => getCommitBySha(db, sha))
    .filter((row): row is NonNullable<typeof row> => row != null);

  if (commitRows.length === 0) return new Map();

  const enriched = enrichCommitsWithContext(db, commitRows);
  return new Map(enriched.map((commit) => [commit.sha, commit]));
}

function expandRenamePathVariants(path: string): string[] {
  if (!path.includes('=>')) return [path];

  const braceMatch = path.match(/^(.*)\{([^{}]+)\s=>\s([^{}]+)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, oldSegment, newSegment, suffix] = braceMatch;
    if (prefix != null && oldSegment != null && newSegment != null && suffix != null) {
      return [`${prefix}${oldSegment}${suffix}`, `${prefix}${newSegment}${suffix}`];
    }
  }

  const split = path.split(/\s=>\s/, 2);
  if (split.length === 2 && split[0] && split[1]) {
    return [split[0].trim(), split[1].trim()];
  }

  return [path];
}

function normalizePathForMatch(path: string): string {
  const unixLike = path.replaceAll('\\', '/');
  const strippedLeading = unixLike.replace(/^\/+/, '');
  const strippedTrailing = strippedLeading.replace(/\/+$/, '');
  return strippedTrailing;
}

function pathMatchesScope(filePath: string, scopePath: string, directoryScope: boolean): boolean {
  const scope = normalizePathForMatch(scopePath);
  if (!scope) return false;
  for (const variant of expandRenamePathVariants(filePath)) {
    const file = normalizePathForMatch(variant);
    if (!file) continue;
    if (directoryScope) {
      if (
        file === scope ||
        file.startsWith(`${scope}/`) ||
        file.includes(`/${scope}/`) ||
        file.endsWith(`/${scope}`)
      ) {
        return true;
      }
      continue;
    }
    if (file === scope || file.endsWith(`/${scope}`) || scope.endsWith(`/${file}`)) return true;
  }
  return false;
}

function computeChurnForScope(
  commits: CommitWithFiles[],
  scopePath: string,
  directoryScope: boolean,
): { totalChurn: number; commitCount: number } {
  let totalChurn = 0;
  let commitCount = 0;
  for (const commit of commits) {
    const files = commit.files ?? [];
    let matched = false;
    let commitChurn = 0;
    for (const file of files) {
      if (!pathMatchesScope(file.file_path, scopePath, directoryScope)) continue;
      matched = true;
      const insertions = Math.max(0, file.insertions ?? 0);
      const deletions = Math.max(0, file.deletions ?? 0);
      commitChurn += insertions + deletions;
    }
    if (matched) {
      commitCount += 1;
      totalChurn += commitChurn;
    }
  }
  return { totalChurn, commitCount };
}

function computeRiskSignals(
  timestamps: number[],
  authors: string[],
  churn: { totalChurn: number; commitCount: number },
): BlameRiskSignals {
  const latestTs = timestamps.length > 0 ? Math.max(...timestamps) : null;
  const now = Math.floor(Date.now() / 1000);
  const recencyDays = latestTs == null ? null : Math.max(0, Math.floor((now - latestTs) / 86_400));
  const recencyLevel: BlameRiskSignals['recency']['level'] =
    recencyDays == null ? 'unknown' : recencyDays <= 14 ? 'high' : recencyDays <= 60 ? 'medium' : 'low';

  const distinctAuthors = new Set(authors.filter((author) => author.trim().length > 0)).size;
  const sampleSize = authors.length;
  const ratio = sampleSize > 0 ? distinctAuthors / sampleSize : 0;
  const authorLevel: BlameRiskSignals['author_dispersion']['level'] =
    sampleSize === 0
      ? 'unknown'
      : distinctAuthors >= 5 || ratio >= 0.6
        ? 'high'
        : distinctAuthors >= 3 || ratio >= 0.35
          ? 'medium'
          : 'low';

  const averageChurn = churn.commitCount > 0 ? churn.totalChurn / churn.commitCount : 0;
  const churnLevel: BlameRiskSignals['churn']['level'] =
    churn.commitCount === 0
      ? 'unknown'
      : churn.totalChurn >= 500 || averageChurn >= 120
        ? 'high'
        : churn.totalChurn >= 150 || averageChurn >= 40
          ? 'medium'
          : 'low';

  const rank: Record<BlameRiskSignals['overall'], number> = {
    unknown: 0,
    low: 1,
    medium: 2,
    high: 3,
  };
  const overall =
    rank[recencyLevel] >= rank[authorLevel] && rank[recencyLevel] >= rank[churnLevel]
      ? recencyLevel
      : rank[authorLevel] >= rank[churnLevel]
        ? authorLevel
        : churnLevel;

  return {
    recency: {
      latest_timestamp: latestTs,
      days_since_latest: recencyDays,
      level: recencyLevel,
    },
    author_dispersion: {
      distinct_authors: distinctAuthors,
      sample_size: sampleSize,
      ratio,
      level: authorLevel,
    },
    churn: {
      total_churn: churn.totalChurn,
      commit_count: churn.commitCount,
      average_churn_per_commit: averageChurn,
      level: churnLevel,
    },
    overall,
  };
}

function sortedCommits(commitMap: Map<string, CommitWithFiles>): CommitWithFiles[] {
  return Array.from(commitMap.values()).sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    return a.sha.localeCompare(b.sha);
  });
}

function handleBlameMode(db: Database.Database, args: BlameArgs): BlameResult {
  const target = resolveFileTarget(db, args, { requireRange: true });
  const { start_line, end_line } = target;
  if (start_line == null || end_line == null) {
    throw new Error('Failed to resolve blame line range.');
  }

  const { repoRoot, relPath } = resolveGitPath(target.path);
  const parsed = runBlamePorcelain(repoRoot, relPath, target.ref, start_line, end_line);
  const commitMap = buildCommitContextMap(
    db,
    parsed.map((line) => line.commit_sha),
  );
  const commits = sortedCommits(commitMap);
  const churn = computeChurnForScope(commits, target.path, false);
  const risk = computeRiskSignals(
    parsed.map((line) => line.timestamp).filter((ts) => ts > 0),
    parsed.map((line) => `${line.author}|${line.author_email}`),
    churn,
  );

  return {
    path: target.path,
    ref: target.ref,
    start_line,
    end_line,
    lines: parsed,
    commits,
    risk,
    resolved_symbol: toResolvedSymbol(target.symbol),
  };
}

function handleHistoryMode(db: Database.Database, args: BlameArgs): BlameHistoryResult {
  const target = resolveFileTarget(db, args, { requireRange: true });
  const { start_line, end_line } = target;
  if (start_line == null || end_line == null) {
    throw new Error('Failed to resolve history line range.');
  }

  const { repoRoot, relPath } = resolveGitPath(target.path);
  const history = runHistoryLog(repoRoot, relPath, target.ref, start_line, end_line);
  const commitMap = buildCommitContextMap(
    db,
    history.map((entry) => entry.commit_sha),
  );
  const commits = sortedCommits(commitMap);
  const churn = computeChurnForScope(commits, target.path, false);
  const risk = computeRiskSignals(
    history.map((entry) => entry.timestamp).filter((ts) => ts > 0),
    history.map((entry) => `${entry.author}|${entry.author_email}`),
    churn,
  );
  const enrichedHistory = history.map((entry) => ({
    ...entry,
    commit_context: commitMap.get(entry.commit_sha),
  }));

  return {
    mode: 'history',
    path: target.path,
    ref: target.ref,
    start_line,
    end_line,
    count: enrichedHistory.length,
    history: enrichedHistory,
    commits,
    risk,
    resolved_symbol: toResolvedSymbol(target.symbol),
  };
}

function handleOwnershipMode(
  db: Database.Database,
  args: BlameArgs,
): BlameOwnershipResult {
  const branch = args.branch?.trim();
  const scopeFromArgs = args.scope;
  const explicitRange = resolveRange(args);
  const hasSymbol = (args.symbol?.trim() ?? '').length > 0;

  let scope: 'file' | 'directory' = 'file';
  let targetPath = '';
  let ref = normalizeRef(args.ref);
  let startLine: number | undefined;
  let endLine: number | undefined;
  let resolvedSymbol: ResolvedBlameSymbol | undefined;
  let files: string[] = [];

  if (hasSymbol || explicitRange) {
    const target = resolveFileTarget(db, args, { requireRange: false });
    scope = 'file';
    targetPath = target.path;
    ref = target.ref;
    startLine = target.start_line;
    endLine = target.end_line;
    resolvedSymbol = toResolvedSymbol(target.symbol);
    files = [target.path];
  } else {
    const path = args.path?.trim();
    if (!path) {
      throw new Error('`path` is required for ownership mode.');
    }
    const fileRow = getFileByPath(db, path, branch);
    if (fileRow && scopeFromArgs !== 'directory') {
      scope = 'file';
      targetPath = path;
      files = [path];
    } else {
      scope = 'directory';
      if (scopeFromArgs === 'file') {
        throw new Error(`File not found in index: ${path}`);
      }
      const directoryFiles = listFilesByPathPrefix(db, path, branch, 10_000).map((file) => file.path);
      if (directoryFiles.length === 0) {
        throw new Error(`No indexed files found for directory scope: ${path}`);
      }
      targetPath = path;
      files = directoryFiles;
    }
  }

  if (scope === 'directory' && (startLine != null || endLine != null)) {
    throw new Error('Line ranges are only supported for file ownership scope.');
  }

  const ownershipMap = new Map<string, { author: string; author_email: string; lines: number; commits: Set<string> }>();
  const allTimestamps: number[] = [];
  const allAuthors: string[] = [];
  const commitShas = new Set<string>();

  for (const filePath of files) {
    const { repoRoot, relPath } = resolveGitPath(filePath);
    const lines = runBlamePorcelain(repoRoot, relPath, ref, startLine, endLine);
    for (const line of lines) {
      const key = `${line.author}\u0000${line.author_email}`;
      const current = ownershipMap.get(key) ?? {
        author: line.author,
        author_email: line.author_email,
        lines: 0,
        commits: new Set<string>(),
      };
      current.lines += 1;
      current.commits.add(line.commit_sha);
      ownershipMap.set(key, current);
      commitShas.add(line.commit_sha);
      allAuthors.push(`${line.author}|${line.author_email}`);
      if (line.timestamp > 0) {
        allTimestamps.push(line.timestamp);
      }
    }
  }

  const commitMap = buildCommitContextMap(db, Array.from(commitShas));
  const commits = sortedCommits(commitMap);
  const churn = computeChurnForScope(commits, targetPath, scope === 'directory');
  const risk = computeRiskSignals(allTimestamps, allAuthors, churn);

  const totalLines = Array.from(ownershipMap.values()).reduce((sum, entry) => sum + entry.lines, 0);
  const ownership = Array.from(ownershipMap.values())
    .map((entry) => ({
      author: entry.author,
      author_email: entry.author_email,
      lines: entry.lines,
      share: totalLines > 0 ? entry.lines / totalLines : 0,
      commit_count: entry.commits.size,
    }))
    .sort((a, b) => {
      if (b.lines !== a.lines) return b.lines - a.lines;
      return a.author.localeCompare(b.author);
    });

  return {
    mode: 'ownership',
    scope,
    path: targetPath,
    ref,
    files_analyzed: files.length,
    start_line: startLine,
    end_line: endLine,
    total_lines: totalLines,
    ownership,
    commits,
    risk,
    resolved_symbol: resolvedSymbol,
  };
}

/** Execute lore_blame mode routing against the indexed repository metadata. */
export function handler(
  db: Database.Database,
  args: BlameArgs,
): BlameResult | BlameHistoryResult | BlameOwnershipResult {
  const mode = args.mode ?? 'blame';
  if (mode === 'history') {
    return handleHistoryMode(db, args);
  }
  if (mode === 'ownership') {
    return handleOwnershipMode(db, args);
  }
  return handleBlameMode(db, args);
}
