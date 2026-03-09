/**
 * @module indexer/stages/coverage
 *
 * Pipeline stage: auto-ingest coverage reports from well-known paths.
 *
 * This stage checks for coverage reports at standard locations
 * (coverage/lcov.info, coverage/cobertura-coverage.xml, etc.) and ingests
 * them if present and newer than the last ingestion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import {
  setLoreMeta,
  getLoreMeta,
  LORE_META_COVERAGE_LAST_SOURCE_PATH,
  LORE_META_COVERAGE_LAST_SOURCE_MTIME,
} from '../db.js';
import { ingestCoverageReport, type CoverageFormat } from '../coverage.js';
import { execFileSync } from 'node:child_process';

/** Well-known coverage report paths and their formats. */
const COVERAGE_CANDIDATES: Array<{ relative: string; format: CoverageFormat }> = [
  { relative: 'coverage/lcov.info', format: 'lcov' },
  { relative: 'coverage/cobertura-coverage.xml', format: 'cobertura' },
  { relative: 'coverage.xml', format: 'cobertura' },
];

/**
 * Auto-detect and ingest coverage reports from standard locations.
 */
export class CoverageStage implements PipelineStage {
  readonly name = 'coverage';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const { db, walkerConfig } = context;
    const rootDir = walkerConfig.rootDir;

    for (const candidate of COVERAGE_CANDIDATES) {
      const reportPath = path.join(rootDir, candidate.relative);
      if (!fs.existsSync(reportPath)) continue;

      const sourceMtime = Math.floor(fs.statSync(reportPath).mtimeMs / 1000);

      // Skip if already ingested at this mtime.
      const lastPath = getLoreMeta(db, LORE_META_COVERAGE_LAST_SOURCE_PATH);
      const lastMtime = getLoreMeta(db, LORE_META_COVERAGE_LAST_SOURCE_MTIME);
      if (lastPath === reportPath && lastMtime === String(sourceMtime)) continue;

      const commitSha = readGitHead(rootDir) ?? 'HEAD';

      context.log.indexing('coverage ingestion', { reportPath, format: candidate.format });
      ingestCoverageReport({
        db,
        rootDir,
        reportPath,
        format: candidate.format,
        commitSha,
        sourceMtime,
      });
      setLoreMeta(db, LORE_META_COVERAGE_LAST_SOURCE_PATH, reportPath);
      setLoreMeta(db, LORE_META_COVERAGE_LAST_SOURCE_MTIME, String(sourceMtime));

      // Only ingest the first matching report.
      break;
    }
  }
}

function readGitHead(rootDir: string): string | undefined {
  try {
    return execFileSync(
      'git',
      ['-C', rootDir, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim() || undefined;
  } catch {
    return undefined;
  }
}
