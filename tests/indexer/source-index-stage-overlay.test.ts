/**
 * Tests for SourceIndexStage in overlay update mode.
 * Exercises the overlay-specific paths in processUpdate.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/db/schema.js';
import { SourceIndexStage } from '../../src/indexer/stages/source-index.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import type Database from 'better-sqlite3';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lore-srcstage-overlay-'));
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
    changedDocPaths: [],
    sourceCache: new Map(),
    layer: 'overlay',
    generation: 0,
    ...overrides,
  };
}

describe('SourceIndexStage — overlay update mode', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should create overlay file rows for changed files', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'hello.ts');
    writeFileSync(filePath, 'export function hello(): void {}\n');

    db = openDb(':memory:');
    const stage = new SourceIndexStage();
    const ctx = makeContext(db, dir, { changedFiles: [filePath] });

    await stage.execute(ctx, 'update');
    await stage.dispose?.();

    const row = db.prepare("SELECT layer FROM files WHERE path = ? AND layer = 'overlay'").get(filePath) as { layer: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.layer).toBe('overlay');
  });

  it('should mark changed files as dirty', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'hello.ts');
    writeFileSync(filePath, 'export function hello(): void {}\n');

    db = openDb(':memory:');
    const stage = new SourceIndexStage();
    const ctx = makeContext(db, dir, { changedFiles: [filePath] });

    await stage.execute(ctx, 'update');
    await stage.dispose?.();

    const dirty = db.prepare('SELECT * FROM dirty_files WHERE path = ?').get(filePath);
    expect(dirty).toBeDefined();
  });

  it('should populate context.files with changed files', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'hello.ts');
    writeFileSync(filePath, 'export function hello(): void {}\n');

    db = openDb(':memory:');
    const stage = new SourceIndexStage();
    const ctx = makeContext(db, dir, { changedFiles: [filePath] });

    await stage.execute(ctx, 'update');
    await stage.dispose?.();

    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0]!.path).toBe(filePath);
    expect(ctx.files[0]!.language).toBe('typescript');
  });

  it('should handle deleted files in overlay mode by marking dirty', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'hello.ts');
    writeFileSync(filePath, 'export function hello(): void {}\n');

    db = openDb(':memory:');

    // First, index the file normally (baseline)
    const stage1 = new SourceIndexStage();
    const ctx1 = makeContext(db, dir, {
      changedFiles: [filePath],
      layer: 'baseline',
      generation: 1,
    });
    await stage1.execute(ctx1, 'update');
    await stage1.dispose?.();

    // Then create an overlay for it
    const stage2 = new SourceIndexStage();
    const ctx2 = makeContext(db, dir, { changedFiles: [filePath] });
    await stage2.execute(ctx2, 'update');
    await stage2.dispose?.();

    // Now delete the file and run overlay update
    unlinkSync(filePath);
    expect(existsSync(filePath)).toBe(false);

    const stage3 = new SourceIndexStage();
    const ctx3 = makeContext(db, dir, { changedFiles: [filePath] });
    await stage3.execute(ctx3, 'update');
    await stage3.dispose?.();

    // Should be marked dirty (sentinel for deleted files)
    const dirty = db.prepare('SELECT * FROM dirty_files WHERE path = ?').get(filePath);
    expect(dirty).toBeDefined();

    // Baseline row should still exist
    const baseline = db.prepare("SELECT * FROM files WHERE path = ? AND layer = 'baseline'").get(filePath);
    expect(baseline).toBeDefined();
  });

  it('should track stale symbol IDs when replacing overlay rows', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'hello.ts');
    writeFileSync(filePath, 'export function hello(): void {}\n');

    db = openDb(':memory:');

    // First overlay index
    const stage1 = new SourceIndexStage();
    const ctx1 = makeContext(db, dir, { changedFiles: [filePath] });
    await stage1.execute(ctx1, 'update');
    await stage1.dispose?.();

    const firstSymIds = (db.prepare("SELECT id FROM symbols WHERE layer = 'overlay'").all() as Array<{ id: number }>).map(r => r.id);
    expect(firstSymIds.length).toBeGreaterThan(0);

    // Re-index overlay (simulates file change)
    writeFileSync(filePath, 'export function worldChanged(): void {}\n');
    const stage2 = new SourceIndexStage();
    const ctx2 = makeContext(db, dir, { changedFiles: [filePath] });
    await stage2.execute(ctx2, 'update');
    await stage2.dispose?.();

    // The first symbol IDs should be in the stale list
    for (const id of firstSymIds) {
      expect(ctx2.staleSymbolIds).toContain(id);
    }
  });

  it('should handle update with no changed files gracefully', async () => {
    const dir = makeTmpDir();
    db = openDb(':memory:');

    const stage = new SourceIndexStage();
    const ctx = makeContext(db, dir, { changedFiles: [] });

    await stage.execute(ctx, 'update');
    await stage.dispose?.();

    expect(ctx.files).toHaveLength(0);
  });

  it('should skip non-source files in overlay update', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'readme.txt');
    writeFileSync(filePath, 'This is not source code.\n');

    db = openDb(':memory:');
    const stage = new SourceIndexStage();
    const ctx = makeContext(db, dir, { changedFiles: [filePath] });

    await stage.execute(ctx, 'update');
    await stage.dispose?.();

    expect(ctx.files).toHaveLength(0);
    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('should delete file rows in baseline mode when file is removed', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'hello.ts');
    writeFileSync(filePath, 'export function hello(): void {}\n');

    db = openDb(':memory:');

    // Index the file in baseline mode
    const stage1 = new SourceIndexStage();
    const ctx1 = makeContext(db, dir, {
      changedFiles: [filePath],
      layer: 'baseline',
      generation: 1,
    });
    await stage1.execute(ctx1, 'update');
    await stage1.dispose?.();

    const countBefore = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(countBefore).toBe(1);

    // Delete file and run baseline update
    unlinkSync(filePath);
    const stage2 = new SourceIndexStage();
    const ctx2 = makeContext(db, dir, {
      changedFiles: [filePath],
      layer: 'baseline',
      generation: 1,
    });
    await stage2.execute(ctx2, 'update');
    await stage2.dispose?.();

    const countAfter = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(countAfter).toBe(0);
  });

  it('should re-index existing file in baseline mode (update existing row)', async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, 'hello.ts');
    writeFileSync(filePath, 'export function hello(): void {}\n');

    db = openDb(':memory:');

    // Index the file in baseline mode
    const stage1 = new SourceIndexStage();
    const ctx1 = makeContext(db, dir, {
      changedFiles: [filePath],
      layer: 'baseline',
      generation: 1,
    });
    await stage1.execute(ctx1, 'update');
    await stage1.dispose?.();

    // Change file and re-index in baseline mode
    writeFileSync(filePath, 'export function changed(): void {}\n');
    const stage2 = new SourceIndexStage();
    const ctx2 = makeContext(db, dir, {
      changedFiles: [filePath],
      layer: 'baseline',
      generation: 1,
    });
    await stage2.execute(ctx2, 'update');
    await stage2.dispose?.();

    // Should still have exactly one file row
    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(count).toBe(1);

    // The source should have the updated content
    const row = db.prepare('SELECT source FROM files WHERE path = ?').get(filePath) as { source: string };
    expect(row.source).toContain('changed');

    // Stale symbol IDs from first index should be tracked
    expect(ctx2.staleSymbolIds.length).toBeGreaterThan(0);
  });
});
