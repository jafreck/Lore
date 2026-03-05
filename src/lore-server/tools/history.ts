/**
 * @module lore-server/tools/history
 *
 * MCP tool: query commit history by file, commit SHA, author, or recency.
 */

import type { Database } from '../db.js';
import {
  getCommitBySha,
  listRecentCommits,
  listCommitsByFile,
  listCommitsByAuthor,
  listCommitsByRef,
  listCommitFiles,
  listCommitRefs,
  type CommitRow,
  type CommitFileRow,
  type CommitRefRow,
} from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_history',
  description:
    'Query git commit history indexed in the knowledge base. ' +
    'Supports four modes: "file" (commits that touched a file path), ' +
    '"commit" (look up a commit by full or partial SHA), ' +
    '"author" (commits by a given author name or email), ' +
    '"ref" (commits matching branch/tag refs), and ' +
    '"recent" (most recent commits). ' +
    'All modes support an optional `limit` parameter (default 20, max 200).',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['file', 'commit', 'author', 'ref', 'recent'],
        description: 'Query mode.',
      },
      query: {
        type: 'string',
        description:
          'For mode="file": the file path. ' +
          'For mode="commit": full or partial commit SHA. ' +
          'For mode="author": author name or email substring. ' +
            'For mode="ref": branch/tag ref name or substring (e.g. refs/heads/main, main, v1.2.0). ' +
          'Not required for mode="recent".',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 20, max 200).',
      },
    },
    required: ['mode'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface HistoryArgs {
  mode: 'file' | 'commit' | 'author' | 'ref' | 'recent';
  query?: string;
  limit?: number;
}

export interface CommitWithFiles extends CommitRow {
  files?: CommitFileRow[];
  refs?: CommitRefRow[];
}

export interface CommitEnrichmentOptions {
  includeFiles?: boolean;
  includeRefs?: boolean;
}

export interface HistoryResult {
  mode: string;
  results: CommitWithFiles[];
  count: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
  if (limit == null) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

/** Enrich commit rows with touched files and refs metadata. */
export function enrichCommitsWithContext(
  db: Database.Database,
  commits: CommitRow[],
  options: CommitEnrichmentOptions = {},
): CommitWithFiles[] {
  const includeFiles = options.includeFiles ?? true;
  const includeRefs = options.includeRefs ?? true;

  return commits.map((commit) => ({
    ...commit,
    ...(includeFiles ? { files: listCommitFiles(db, commit.sha) } : {}),
    ...(includeRefs ? { refs: listCommitRefs(db, commit.sha) } : {}),
  }));
}

/** Handle a lore_history tool invocation against the open read-only database. */
export function handler(db: Database.Database, args: HistoryArgs): HistoryResult {
  const limit = clampLimit(args.limit);

  switch (args.mode) {
    case 'file': {
      const filePath = args.query?.trim() ?? '';
      const rows = filePath
        ? listCommitsByFile(db, filePath, limit)
        : listRecentCommits(db, limit);
      return { mode: 'file', results: rows, count: rows.length };
    }

    case 'commit': {
      const sha = args.query?.trim() ?? '';
      if (!sha) {
        return { mode: 'commit', results: [], count: 0 };
      }
      const commit = getCommitBySha(db, sha);
      if (!commit) {
        return { mode: 'commit', results: [], count: 0 };
      }
      const [result] = enrichCommitsWithContext(db, [commit]);
      if (!result) {
        throw new Error('Failed to enrich commit context.');
      }
      return { mode: 'commit', results: [result], count: 1 };
    }

    case 'author': {
      const author = args.query?.trim() ?? '';
      const rows = author
        ? listCommitsByAuthor(db, author, limit)
        : listRecentCommits(db, limit);
      return { mode: 'author', results: rows, count: rows.length };
    }

    case 'ref': {
      const ref = args.query?.trim() ?? '';
      const rows = listCommitsByRef(db, ref, limit);
      return { mode: 'ref', results: rows, count: rows.length };
    }

    case 'recent': {
      const rows = listRecentCommits(db, limit);
      return { mode: 'recent', results: rows, count: rows.length };
    }
  }
}
