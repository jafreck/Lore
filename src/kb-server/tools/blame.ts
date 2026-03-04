/**
 * @module kb-server/tools/blame
 *
 * MCP tool: line-level git blame for indexed files.
 */

import { execFileSync } from 'node:child_process';
import { dirname, relative } from 'node:path';
import type { Database } from '../db.js';
import { getFileByPath } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_blame',
  description:
    'Return git blame metadata for a file and line (or line range). ' +
    'The file path must exist in the indexed knowledge base.',
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
    },
    required: ['path'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface BlameArgs {
  path: string;
  line?: number;
  start_line?: number;
  end_line?: number;
  ref?: string;
  branch?: string;
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

export interface BlameResult {
  path: string;
  ref: string;
  start_line: number;
  end_line: number;
  lines: BlameLine[];
}

interface BlameMeta {
  author?: string;
  author_email?: string;
  timestamp?: number;
  summary?: string;
}

function resolveRange(args: BlameArgs): { start: number; end: number } {
  if (args.line != null) {
    const line = Math.max(1, Math.floor(args.line));
    return { start: line, end: line };
  }

  if (args.start_line != null || args.end_line != null) {
    const start = Math.max(1, Math.floor(args.start_line ?? args.end_line ?? 1));
    const end = Math.max(start, Math.floor(args.end_line ?? start));
    return { start, end };
  }

  throw new Error('Provide either `line` or `start_line`/`end_line`.');
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

/** Resolve repository root and execute `git blame --line-porcelain` for the requested range. */
export function handler(db: Database.Database, args: BlameArgs): BlameResult {
  const fileRow = getFileByPath(db, args.path, args.branch);
  if (!fileRow) {
    throw new Error(`File not found in index: ${args.path}`);
  }

  const { start, end } = resolveRange(args);
  const ref = args.ref?.trim() || 'HEAD';

  let repoRoot = '';
  try {
    repoRoot = execFileSync('git', ['-C', dirname(args.path), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    throw new Error(`Unable to resolve git repository root for path: ${args.path}`);
  }

  const relPath = relative(repoRoot, args.path);
  if (relPath.startsWith('..')) {
    throw new Error(`Path is outside git repository root: ${args.path}`);
  }

  let output = '';
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        repoRoot,
        'blame',
        '--line-porcelain',
        '-L',
        `${start},${end}`,
        ref,
        '--',
        relPath,
      ],
      { encoding: 'utf8' },
    );
  } catch {
    throw new Error(
      `git blame failed for ${args.path}:${start}-${end} at ref ${ref}.`,
    );
  }

  const parsed = parseBlamePorcelain(output);
  return {
    path: args.path,
    ref,
    start_line: start,
    end_line: end,
    lines: parsed,
  };
}
