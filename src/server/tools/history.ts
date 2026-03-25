/**
 * @module lore-server/tools/history
 *
 * MCP tool: query commit history by file, commit SHA, author, or recency.
 */

import type { Database } from '../../db/read-only.js';
import {
  getCommitBySha,
  listRecentCommits,
  listCommitsByFile,
  listCommitsByAuthor,
  listCommitsByRef,
  hasCommitEmbeddings,
  listCommitsBySemanticQuery,
  type CommitRow,
  type CommitFileRow,
  type CommitRefRow,
} from '../../db/read-only.js';
import type { EmbeddingProvider } from '../../embeddings/embedder.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_history',
  description:
    'Query git commit history indexed in the knowledge base. ' +
    'Supports six modes: "file" (commits that touched a file path), ' +
    '"commit" (look up a commit by full or partial SHA), ' +
    '"author" (commits by a given author name or email), ' +
    '"ref" (commits matching branch/tag refs), and ' +
    '"semantic" (semantic commit-message matching), and ' +
    '"recent" (most recent commits). ' +
    'All modes support an optional `limit` parameter (default 20, max 200).',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['file', 'commit', 'author', 'ref', 'semantic', 'recent'],
        description: 'Query mode.',
      },
      query: {
        type: 'string',
        description:
          'For mode="file": the file path. ' +
          'For mode="commit": full or partial commit SHA. ' +
          'For mode="author": author name or email substring. ' +
          'For mode="ref": branch/tag ref name or substring (e.g. refs/heads/main, main, v1.2.0). ' +
          'For mode="semantic": natural-language commit search query. ' +
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
  mode: 'file' | 'commit' | 'author' | 'ref' | 'semantic' | 'recent';
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

/** Batch-fetch files for multiple commits in a single query, grouped by SHA. */
function batchListCommitFiles(
  db: Database.Database,
  shas: string[],
): Map<string, CommitFileRow[]> {
  if (shas.length === 0) return new Map();
  const placeholders = shas.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM commit_files WHERE commit_sha IN (${placeholders})`)
    .all(...shas) as CommitFileRow[];
  const grouped = new Map<string, CommitFileRow[]>();
  for (const row of rows) {
    let arr = grouped.get(row.commit_sha);
    if (!arr) {
      arr = [];
      grouped.set(row.commit_sha, arr);
    }
    arr.push(row);
  }
  return grouped;
}

/** Batch-fetch refs for multiple commits in a single query, grouped by SHA. */
function batchListCommitRefs(
  db: Database.Database,
  shas: string[],
): Map<string, CommitRefRow[]> {
  if (shas.length === 0) return new Map();
  const placeholders = shas.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT * FROM commit_refs WHERE commit_sha IN (${placeholders}) ORDER BY ref_type ASC, ref_name ASC`,
    )
    .all(...shas) as CommitRefRow[];
  const grouped = new Map<string, CommitRefRow[]>();
  for (const row of rows) {
    let arr = grouped.get(row.commit_sha);
    if (!arr) {
      arr = [];
      grouped.set(row.commit_sha, arr);
    }
    arr.push(row);
  }
  return grouped;
}

/** Enrich commit rows with touched files and refs metadata. */
export function enrichCommitsWithContext(
  db: Database.Database,
  commits: CommitRow[],
  options: CommitEnrichmentOptions = {},
): CommitWithFiles[] {
  const includeFiles = options.includeFiles ?? true;
  const includeRefs = options.includeRefs ?? true;

  const shas = commits.map((c) => c.sha);
  const filesMap = includeFiles ? batchListCommitFiles(db, shas) : undefined;
  const refsMap = includeRefs ? batchListCommitRefs(db, shas) : undefined;

  return commits.map((commit) => ({
    ...commit,
    ...(filesMap ? { files: filesMap.get(commit.sha) ?? [] } : {}),
    ...(refsMap ? { refs: refsMap.get(commit.sha) ?? [] } : {}),
  }));
}

/** Handle a lore_history tool invocation against the open read-only database. */
export async function handler(
  db: Database.Database,
  args: HistoryArgs,
  embedder?: EmbeddingProvider,
): Promise<HistoryResult> {
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

    case 'semantic': {
      const query = args.query?.trim() ?? '';
      if (!query || !embedder || !hasCommitEmbeddings(db)) {
        const rows = listRecentCommits(db, limit);
        return { mode: 'semantic', results: rows, count: rows.length };
      }
      try {
        const [queryVector] = await embedder.embed([query]);
        if (!queryVector || queryVector.length === 0) {
          const rows = listRecentCommits(db, limit);
          return { mode: 'semantic', results: rows, count: rows.length };
        }
        const rows = listCommitsBySemanticQuery(db, queryVector, limit);
        return { mode: 'semantic', results: rows, count: rows.length };
      } catch {
        const rows = listRecentCommits(db, limit);
        return { mode: 'semantic', results: rows, count: rows.length };
      }
    }

    case 'recent': {
      const rows = listRecentCommits(db, limit);
      return { mode: 'recent', results: rows, count: rows.length };
    }
  }
}
