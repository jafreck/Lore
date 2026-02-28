/**
 * @module indexer/git-history
 *
 * Ingests git commit history into the `commits` and `commit_files` tables
 * using simple-git to read commit metadata and per-file diff stats.
 */

import { simpleGit } from 'simple-git';
import type { Database } from './db.js';

export interface GitHistoryOptions {
  depth?: number;
  all?: boolean;
}

const DEFAULT_ALL = true;

/**
 * Reads commit history from the git repository at `repoRoot` and upserts each
 * commit and its associated file changes into the `commits` and
 * `commit_files` tables. By default, Lore traverses all refs (`--all`) with
 * no depth limit; `options.depth` can be used to cap the number of ingested
 * commits.
 *
 * The function is idempotent: rows are inserted with INSERT OR IGNORE so
 * re-running it on the same repository will not produce duplicates.
 */
export async function ingestGitHistory(
  db: Database.Database,
  repoRoot: string,
  options?: GitHistoryOptions,
): Promise<void> {
  const all = options?.all ?? DEFAULT_ALL;
  const depth =
    typeof options?.depth === 'number' && Number.isFinite(options.depth) && options.depth > 0
      ? Math.floor(options.depth)
      : undefined;
  const git = simpleGit(repoRoot);

  const logArgs = [
    'log',
    '--numstat',
    '--format=COMMIT_SEP%n%H%n%an%n%ae%n%at%n%P%n%s',
  ];

  if (all) {
    logArgs.push('--all');
  }

  if (depth !== undefined) {
    logArgs.push(`--max-count=${depth}`);
  }

  // Fetch log with numstat for diff stats.
  // --numstat outputs insertion/deletion counts per file after each commit header.
  const logResult = await git.raw(logArgs);

  // Capture heads/tags that currently point to commits so branch/tag metadata
  // is also available in the KB.
  let refsRaw = '';
  try {
    refsRaw = await git.raw(['show-ref', '--heads', '--tags']);
  } catch {
    refsRaw = '';
  }

  const insertCommit = db.prepare(
    `INSERT OR IGNORE INTO commits (sha, author, author_email, timestamp, message, parents)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertCommitFile = db.prepare(
    `INSERT OR IGNORE INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertCommitRef = db.prepare(
    `INSERT OR IGNORE INTO commit_refs (commit_sha, ref_name, ref_type)
     SELECT ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM commits WHERE sha = ?)`,
  );

  // Parse the raw git log output into commit blocks.
  // Each block starts with "COMMIT_SEP" followed by commit metadata lines,
  // then an empty line, then numstat lines (insertions<TAB>deletions<TAB>path).
  const blocks = logResult.split('COMMIT_SEP\n').filter((b: string) => b.trim().length > 0);

  db.transaction(() => {
    for (const block of blocks) {
      const lines = block.split('\n');

      const sha = lines[0]?.trim();
      const author = lines[1]?.trim();
      const authorEmail = lines[2]?.trim();
      const timestampStr = lines[3]?.trim();
      const parentsStr = lines[4]?.trim() ?? '';
      const message = lines[5]?.trim() ?? '';

      if (!sha || !author || !authorEmail || !timestampStr) continue;

      const timestamp = parseInt(timestampStr, 10);
      const parents = JSON.stringify(
        parentsStr.length > 0 ? parentsStr.split(' ') : [],
      );

      insertCommit.run(sha, author, authorEmail, timestamp, message, parents);

      // Numstat lines start after the blank line (index 6 onward)
      for (let i = 7; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        // numstat format: <insertions>\t<deletions>\t<path>
        // Binary files show "-" for both insertions and deletions.
        const parts = line.split('\t');
        if (parts.length < 3) continue;

        const [insStr, delStr, ...pathParts] = parts;
        const filePath = pathParts.join('\t'); // handle tab-in-path edge case

        const insertions = insStr === '-' ? null : parseInt(insStr!, 10);
        const deletions = delStr === '-' ? null : parseInt(delStr!, 10);

        // Determine change type based on diff stats presence.
        // Rename detection (e.g. "old => new") is noted as a renamed file.
        let changeType = 'modified';
        if (filePath.includes('{') && filePath.includes('=>')) {
          changeType = 'renamed';
        } else if (insertions !== null && deletions === 0 && insertions > 0) {
          changeType = 'added';
        } else if (deletions !== null && insertions === 0 && deletions > 0) {
          changeType = 'deleted';
        }

        insertCommitFile.run(sha, filePath, changeType, insertions, deletions);
      }
    }

    const refLines = refsRaw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of refLines) {
      const [sha, refName] = line.split(' ');
      if (!sha || !refName) continue;

      let refType = 'other';
      if (refName.startsWith('refs/heads/')) {
        refType = 'branch';
      } else if (refName.startsWith('refs/tags/')) {
        refType = 'tag';
      }

      insertCommitRef.run(sha, refName, refType, sha);
    }
  })();
}
