import type { Database } from '../db/schema.js';

export type TestMappingConfidence = 'import' | 'coverage' | 'heuristic' | 'per_test_coverage';

export const TEST_MAPPING_CONFIDENCES: readonly TestMappingConfidence[] = [
  'import',
  'coverage',
  'heuristic',
  'per_test_coverage',
];

const TEST_DIRECTORY_SEGMENTS = new Set(['tests', '__tests__', 'spec']);

export function isTestFilePath(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedLowerPath = normalizedPath.toLowerCase();
  const fileName = normalizedPath.split('/').pop() ?? '';
  const fileNameLower = fileName.toLowerCase();
  const pathSegments = normalizedLowerPath.split('/');

  if (pathSegments.some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  if (fileNameLower.includes('.test.') || fileNameLower.includes('.spec.')) {
    return true;
  }
  if (fileNameLower.startsWith('test_')) {
    return true;
  }
  return fileNameLower.includes('_test.');
}

export function refreshTestMappings(db: Database.Database, branch: string): void {
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM test_mappings
       WHERE test_file_id IN (SELECT id FROM files WHERE branch = ?)
          OR source_file_id IN (SELECT id FROM files WHERE branch = ?)`,
    ).run(branch, branch);

    const rows = db
      .prepare(
        `SELECT DISTINCT fi.file_id AS test_file_id, fi.resolved_id AS source_file_id, test_files.path AS test_file_path
         FROM file_imports fi
         JOIN files test_files ON test_files.id = fi.file_id
         JOIN files source_files ON source_files.id = fi.resolved_id
         WHERE test_files.branch = ?
           AND source_files.branch = ?
           AND fi.resolved_id IS NOT NULL`,
      )
      .all(branch, branch) as Array<{
      test_file_id: number;
      source_file_id: number;
      test_file_path: string;
    }>;

    const insert = db.prepare(
      `INSERT OR REPLACE INTO test_mappings (test_file_id, source_file_id, confidence)
       VALUES (?, ?, 'import')`,
    );
    for (const row of rows) {
      if (!isTestFilePath(row.test_file_path)) continue;
      insert.run(row.test_file_id, row.source_file_id);
    }
  });

  tx();
}
