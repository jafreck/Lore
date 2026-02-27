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
}

const DEFAULT_DEPTH = 500;

/**
 * Reads up to `options.depth` commits (default 500) from the git repository
 * at `repoRoot` and upserts each commit and its associated file changes into
 * the `commits` and `commit_files` tables.
 *
 * The function is idempotent: rows are inserted with INSERT OR IGNORE so
 * re-running it on the same repository will not produce duplicates.
 */
export async function ingestGitHistory(
  db: Database.Database,
  repoRoot: string,
  options?: GitHistoryOptions,
): Promise<void> {
  const depth = options?.depth ?? DEFAULT_DEPTH;
  const git = simpleGit(repoRoot);

  // Fetch log with numstat for diff stats.
  // --numstat outputs insertion/deletion counts per file after each commit header.
  const logResult = await git.raw([
    'log',
    `--max-count=${depth}`,
    '--numstat',
    '--format=COMMIT_SEP%n%H%n%an%n%ae%n%at%n%P%n%s',
  ]);

  const insertCommit = db.prepare(
    `INSERT OR IGNORE INTO commits (sha, author, author_email, timestamp, message, parents)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertCommitFile = db.prepare(
    `INSERT OR IGNORE INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
     VALUES (?, ?, ?, ?, ?)`,
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
  })();
}
