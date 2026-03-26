/**
 * Tests for SourceIndexStage behavior on SCIP-sourced files during build.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/db/schema.js';
import { SourceIndexStage } from '../../src/indexer/stages/source-index.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import type Database from 'better-sqlite3';

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeContext(db: Database.Database, rootDir: string, overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir },
    branch: 'HEAD',
    lsp: null,
    scip: null,
    embedder: null,
    log: initLogger({ level: LogLevel.SILENT }),
    files: [],
    indexDependencies: false,
    history: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    sourceCache: new Map(),
    layer: 'baseline',
    generation: 1,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('SourceIndexStage — SCIP-sourced build files', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('patches metrics and end lines without reinserting SCIP-owned symbols', async () => {
    const rootDir = makeTmpDir('lore-srcstage-scip-');
    const filePath = join(rootDir, 'branchy.ts');
    writeFileSync(
      filePath,
      `export function branchy(x: number): string {
  if (x > 0) {
    return 'positive';
  }
  return 'zero';
}
`,
      'utf8',
    );

    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO files (path, branch, language, last_hash, layer, generation) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(filePath, 'HEAD', 'typescript', 'scip-hash', 'baseline', 1);
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number }).id;
    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(fileId, 'branchy', 'function', 'function branchy(x: number): string', 0, 0, 'baseline', 1);

    const stage = new SourceIndexStage();
    const ctx = makeContext(db, rootDir, {
      scipSourcedFiles: new Set([filePath]),
      scipCoveredLanguages: new Set(['typescript']),
      scipSourcedLanguages: new Set(['typescript']),
      maxWorkers: 2,
    });

    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const symbolCount = (db.prepare('SELECT COUNT(*) AS count FROM symbols WHERE file_id = ?').get(fileId) as { count: number }).count;
    expect(symbolCount).toBe(1);

    const symbol = db.prepare(
      'SELECT end_line FROM symbols WHERE file_id = ? AND name = ?',
    ).get(fileId, 'branchy') as { end_line: number } | undefined;
    expect(symbol).toBeDefined();
    expect(symbol!.end_line).toBeGreaterThan(0);

    const metrics = db.prepare(
      `SELECT sm.cyclomatic, sm.line_count
       FROM symbol_metrics sm
       JOIN symbols s ON s.id = sm.symbol_id
       WHERE s.file_id = ? AND s.name = ?`,
    ).get(fileId, 'branchy') as { cyclomatic: number; line_count: number } | undefined;
    expect(metrics).toBeDefined();
    expect(metrics!.cyclomatic).toBeGreaterThan(1);
    expect(metrics!.line_count).toBeGreaterThan(0);
  });
});
