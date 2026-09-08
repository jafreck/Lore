import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openReadOnly } from '../../src/db/read-only.js';
import {
  claimWriterGeneration,
  openDb,
  reserveBaselineGeneration,
} from '../../src/db/schema.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import { IndexPipeline } from '../../src/indexer/pipeline.js';
import {
  applyBaselinePromotion,
  cleanupSupersededBaselineRows,
} from '../../src/indexer/stages/overlay-cleanup.js';
import { resolveEffectiveLspSettings } from '../../src/lsp/config.js';
import { resolveEffectiveScipSettings } from '../../src/scip/config.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

let rootDir: string;
let dbPath: string;

beforeEach(() => {
  resetLogger();
  initLogger({ level: LogLevel.SILENT });
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-storage-runtime-')));
  dbPath = path.join(rootDir, 'lore.db');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function createBuilder(walkerOverrides: Record<string, unknown> = {}): IndexBuilder {
  return new IndexBuilder(
    dbPath,
    { rootDir, ...walkerOverrides },
    undefined,
    {
      lsp: resolveEffectiveLspSettings({}, { enabled: false }),
      scip: resolveEffectiveScipSettings({}, { enabled: false }),
      validation: false,
    },
  );
}

function write(relativePath: string, source: string): string {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
  return filePath;
}

function effectiveFiles(): Array<{ path: string; source: string; layer: string; generation: number }> {
  const db = openDb(dbPath);
  try {
    return db.prepare(
      'SELECT path, source, layer, generation FROM effective_files ORDER BY path',
    ).all() as Array<{ path: string; source: string; layer: string; generation: number }>;
  } finally {
    db.close();
  }
}

describe('atomic baseline storage', () => {
  it('keeps the first candidate hidden from an independent reader until promotion', async () => {
    const filePath = write('src/initial.ts', 'export const initial = true;\n');
    const builder = createBuilder();
    const originalRun = IndexPipeline.prototype.run;
    let staged!: () => void;
    const stagedPromise = new Promise<void>((resolve) => { staged = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(IndexPipeline.prototype, 'run').mockImplementationOnce(async function (this: IndexPipeline, context, mode) {
      await originalRun.call(this, context, mode);
      staged();
      await releasePromise;
    });

    const build = builder.build();
    await stagedPromise;
    const reader = openReadOnly(dbPath);
    try {
      expect(reader.prepare('SELECT path FROM effective_files').all()).toEqual([]);
      expect(reader.prepare('SELECT generation FROM baseline_generations').all()).toEqual([]);
      expect(reader.prepare(
        "SELECT path FROM files WHERE layer = 'baseline'",
      ).all()).toEqual([{ path: filePath }]);
    } finally {
      reader.close();
    }

    release();
    await build;
    expect(effectiveFiles().map((file) => file.path)).toEqual([filePath]);
  });

  it('keeps the promoted baseline visible when a replacement build fails', async () => {
    const filePath = write('src/a.ts', 'export const value = 1;\n');
    const builder = createBuilder();
    await builder.build();

    fs.writeFileSync(filePath, 'export const value = 2;\n');
    write('src/new.ts', 'export const added = true;\n');

    const originalRun = IndexPipeline.prototype.run;
    let staged!: () => void;
    const stagedPromise = new Promise<void>((resolve) => { staged = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(IndexPipeline.prototype, 'run').mockImplementationOnce(async function (this: IndexPipeline, context, mode) {
      await originalRun.call(this, context, mode);
      staged();
      await releasePromise;
      throw new Error('injected post-pipeline failure');
    });

    const failedBuild = builder.baselineRebuild();
    await stagedPromise;

    const reader = openReadOnly(dbPath);
    try {
      const visible = reader.prepare(
        'SELECT path, source FROM effective_files ORDER BY path',
      ).all() as Array<{ path: string; source: string }>;
      expect(visible).toEqual([{ path: filePath, source: 'export const value = 1;\n' }]);
    } finally {
      reader.close();
    }

    release();
    await expect(failedBuild).rejects.toThrow('injected post-pipeline failure');

    expect(effectiveFiles()).toEqual([{
      path: filePath,
      source: 'export const value = 1;\n',
      layer: 'baseline',
      generation: 1,
    }]);
    const db = openDb(dbPath);
    try {
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM files WHERE layer = 'baseline'",
      ).get()).toEqual({ count: 1 });
      expect(db.prepare(
        "SELECT value FROM lore_meta WHERE key = 'generation_pending'",
      ).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('removes files absent from the second successful baseline build', async () => {
    const retained = write('src/retained.ts', 'export const retained = true;\n');
    const deleted = write('src/deleted.ts', 'export const deleted = true;\n');
    const builder = createBuilder();
    await builder.build();

    fs.rmSync(deleted);
    await builder.build();

    expect(effectiveFiles().map((file) => file.path)).toEqual([retained]);
    const db = openDb(dbPath);
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM files WHERE path = ?').get(deleted))
        .toEqual({ count: 0 });
      expect(db.prepare(
        "SELECT COUNT(DISTINCT generation) AS count FROM files WHERE layer = 'baseline'",
      ).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('fences a reclaimed writer from promoting or cleaning the newer generation', async () => {
    const filePath = write('src/a.ts', 'export const value = 1;\n');
    const builder = createBuilder();
    await builder.build();
    fs.writeFileSync(filePath, 'export const value = 2;\n');

    const originalRun = IndexPipeline.prototype.run;
    let staged!: () => void;
    const stagedPromise = new Promise<void>((resolve) => { staged = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let staleGeneration = 0;
    vi.spyOn(IndexPipeline.prototype, 'run').mockImplementationOnce(async function (this: IndexPipeline, context, mode) {
      await originalRun.call(this, context, mode);
      staleGeneration = context.generation;
      staged();
      await releasePromise;
    });

    const staleWriter = builder.baselineRebuild();
    await stagedPromise;

    // Simulate process B reclaiming process A's stale filesystem lease. The
    // database claim is the authoritative fence even while A is still alive.
    const reclaimingDb = openDb(dbPath);
    let reclaimedGeneration = 0;
    try {
      const writerGeneration = claimWriterGeneration(reclaimingDb);
      reclaimedGeneration = reserveBaselineGeneration(reclaimingDb, 'HEAD');
      reclaimingDb.prepare(
        `INSERT INTO files
           (path, branch, language, source, last_hash, layer, generation)
         VALUES (?, 'HEAD', 'typescript', 'export const value = 3;\n',
                 'reclaimed', 'baseline', ?)`,
      ).run(filePath, reclaimedGeneration);
      reclaimingDb.transaction(() => applyBaselinePromotion(
        reclaimingDb,
        'HEAD',
        {
          newGeneration: reclaimedGeneration,
          rebuildStartedAt: Math.floor(Date.now() / 1000),
        },
        writerGeneration,
      )).immediate();
      cleanupSupersededBaselineRows(
        reclaimingDb,
        'HEAD',
        reclaimedGeneration,
        writerGeneration,
      );
    } finally {
      reclaimingDb.close();
    }

    expect(reclaimedGeneration).toBeGreaterThan(staleGeneration);
    release();
    await expect(staleWriter).rejects.toThrow(/Lost database writer lease/u);

    const db = openDb(dbPath);
    try {
      expect(db.prepare(
        "SELECT generation FROM baseline_generations WHERE branch = 'HEAD'",
      ).get()).toEqual({ generation: reclaimedGeneration });
      expect(db.prepare(
        'SELECT source, generation FROM effective_files WHERE path = ?',
      ).get(filePath)).toEqual({
        source: 'export const value = 3;\n',
        generation: reclaimedGeneration,
      });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM files WHERE layer = 'baseline' AND generation > ?",
      ).get(reclaimedGeneration)).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

describe('refresh diffing', () => {
  it('overlays only content-changed and deleted files', async () => {
    const unchanged = write('src/unchanged.ts', 'export const unchanged = 1;\n');
    const changed = write('src/changed.ts', 'export const changed = 1;\n');
    const deleted = write('src/deleted.ts', 'export const deleted = 1;\n');
    const builder = createBuilder();
    await builder.build();

    fs.writeFileSync(changed, 'export const changed = 2;\n');
    fs.rmSync(deleted);

    await expect(builder.refresh()).resolves.toEqual([changed, deleted].sort());

    const db = openDb(dbPath);
    try {
      const dirty = db.prepare('SELECT path FROM dirty_files ORDER BY path').all() as Array<{ path: string }>;
      expect(dirty.map((row) => row.path)).toEqual([changed, deleted].sort());
      const visible = db.prepare(
        'SELECT path, layer FROM effective_files ORDER BY path',
      ).all() as Array<{ path: string; layer: string }>;
      expect(visible).toEqual([
        { path: changed, layer: 'overlay' },
        { path: unchanged, layer: 'baseline' },
      ].sort((left, right) => left.path.localeCompare(right.path)));
    } finally {
      db.close();
    }
  });

  it('preserves include, exclude, and language filters across build and refresh', async () => {
    const included = write('src/included.ts', 'export const included = 1;\n');
    const excluded = write('src/excluded/ignored.ts', 'export const ignored = 1;\n');
    write('src/ignored.py', 'ignored = 1\n');
    const builder = createBuilder({
      includeGlobs: ['src/**/*'],
      excludeGlobs: ['**/excluded/**'],
      extensions: ['.ts'],
    });
    await builder.build();

    fs.writeFileSync(included, 'export const included = 2;\n');
    fs.writeFileSync(excluded, 'export const ignored = 2;\n');
    await expect(builder.refresh()).resolves.toEqual([included]);
  });
});

describe('database-scoped writer queue', () => {
  it('serializes complete runs from separate IndexBuilder instances', async () => {
    write('src/a.ts', 'export const value = 1;\n');
    const first = createBuilder();
    const second = createBuilder();
    const originalRun = IndexPipeline.prototype.run;
    let active = 0;
    let maxActive = 0;
    vi.spyOn(IndexPipeline.prototype, 'run').mockImplementation(async function (this: IndexPipeline, context, mode) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await originalRun.call(this, context, mode);
      } finally {
        active--;
      }
    });

    await Promise.all([first.build(), second.build()]);
    expect(maxActive).toBe(1);

    const db = openDb(dbPath);
    try {
      expect(db.prepare(
        "SELECT generation FROM baseline_generations WHERE branch = 'HEAD'",
      ).get()).toEqual({ generation: 2 });
      expect(db.prepare(
        "SELECT COUNT(DISTINCT generation) AS count FROM files WHERE layer = 'baseline'",
      ).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
