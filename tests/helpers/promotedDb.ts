import { openDb, type Database } from '../../src/db/schema.js';

const DEFAULT_TEST_BRANCHES = [
  '',
  'main',
  'dev',
  'feature',
  'v1',
  'v2',
  'only',
  'a',
  'b',
  'old',
  'new',
  'branch-a',
  'branch-b',
] as const;

/** Open a test database with explicit generation-zero promotion pointers. */
export function openPromotedTestDb(path: string): Database.Database {
  const db = openDb(path);
  const promote = db.prepare(
    'INSERT OR IGNORE INTO baseline_generations (branch, generation) VALUES (?, 0)',
  );
  db.transaction(() => {
    for (const branch of DEFAULT_TEST_BRANCHES) promote.run(branch);
  })();
  return db;
}
