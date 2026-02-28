import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from './db.js';

export type CoverageFormat = 'lcov' | 'cobertura';

interface IngestCoverageReportOptions {
  db: Database.Database;
  rootDir: string;
  reportPath: string;
  format: CoverageFormat;
  commitSha: string;
  sourceMtime?: number;
}

export function ingestCoverageReport(options: IngestCoverageReportOptions): number {
  const source = fs.readFileSync(options.reportPath, 'utf8');
  const lineHitsByFile =
    options.format === 'lcov'
      ? parseLcov(source, options.rootDir)
      : parseCobertura(source, options.rootDir);

  const insertRun = options.db.prepare(
    `INSERT INTO coverage_runs (commit_sha, source_path, format, source_mtime)
     VALUES (?, ?, ?, ?)`,
  );
  const insertFile = options.db.prepare(
    `INSERT INTO coverage_files (run_id, file_path, lines_found, lines_hit)
     VALUES (?, ?, ?, ?)`,
  );
  const insertLine = options.db.prepare(
    `INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count)
     VALUES (?, ?, ?, ?)`,
  );

  const tx = options.db.transaction(() => {
    const runInfo = insertRun.run(
      options.commitSha,
      options.reportPath,
      options.format,
      options.sourceMtime ?? null,
    ) as { lastInsertRowid: number | bigint };
    const runId = Number(runInfo.lastInsertRowid);

    for (const [filePath, lineHits] of lineHitsByFile.entries()) {
      const lineEntries = [...lineHits.entries()];
      const linesFound = lineEntries.length;
      const linesHit = lineEntries.filter(([, hitCount]) => hitCount > 0).length;
      insertFile.run(runId, filePath, linesFound, linesHit);
      for (const [lineNumber, hitCount] of lineEntries) {
        insertLine.run(runId, filePath, lineNumber, hitCount);
      }
    }

    return runId;
  });

  return tx();
}

function parseLcov(source: string, rootDir: string): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  let currentFilePath: string | undefined;

  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine.startsWith('SF:')) {
      currentFilePath = normalizeCoveragePath(rawLine.slice(3).trim(), rootDir);
      if (!result.has(currentFilePath)) {
        result.set(currentFilePath, new Map<number, number>());
      }
      continue;
    }
    if (!rawLine.startsWith('DA:') || !currentFilePath) continue;
    const [lineNumberRaw, hitCountRaw] = rawLine.slice(3).split(',');
    const lineNumber = Number(lineNumberRaw);
    const hitCount = Number(hitCountRaw);
    if (!Number.isInteger(lineNumber) || lineNumber <= 0 || !Number.isFinite(hitCount)) continue;
    const fileHits = result.get(currentFilePath);
    if (!fileHits) continue;
    fileHits.set(lineNumber, (fileHits.get(lineNumber) ?? 0) + Math.max(0, Math.floor(hitCount)));
  }

  return result;
}

function parseCobertura(source: string, rootDir: string): Map<string, Map<number, number>> {
  const result = new Map<string, Map<number, number>>();
  const classPattern = /<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;

  let classMatch: RegExpExecArray | null;
  while ((classMatch = classPattern.exec(source)) !== null) {
    const rawPath = classMatch[1];
    const classBody = classMatch[2];
    if (!rawPath || !classBody) continue;

    const filePath = normalizeCoveragePath(rawPath, rootDir);
    const fileHits = result.get(filePath) ?? new Map<number, number>();
    result.set(filePath, fileHits);

    const linePattern = /<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"[^>]*\/?>/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(classBody)) !== null) {
      const lineNumber = Number(lineMatch[1]);
      const hitCount = Number(lineMatch[2]);
      if (!Number.isInteger(lineNumber) || lineNumber <= 0 || !Number.isFinite(hitCount)) continue;
      fileHits.set(lineNumber, (fileHits.get(lineNumber) ?? 0) + Math.max(0, Math.floor(hitCount)));
    }
  }

  return result;
}

function normalizeCoveragePath(rawPath: string, rootDir: string): string {
  if (path.isAbsolute(rawPath)) return path.normalize(rawPath);
  return path.resolve(rootDir, rawPath);
}
