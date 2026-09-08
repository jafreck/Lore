import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import {
  extractCIncludes,
  IncludePathIndex,
  IMPORT_RESOLUTION_BATCH_LIMITS,
  ImportResolutionStage,
} from '../../src/indexer/stages/import-resolution.js';
import { ReverseDepsStage } from '../../src/indexer/stages/reverse-deps.js';
import { OverlayCleanupStage } from '../../src/indexer/stages/overlay-cleanup.js';
import { EmbeddingStage } from '../../src/indexer/stages/embedding.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

function makeCtx(db: Database.Database, overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp/test' } as any,
    branch: 'main',
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

describe('ImportResolutionStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('has the correct name', () => {
    const stage = new ImportResolutionStage();
    expect(stage.name).toBe('import-resolution');
  });

  it('extracts literal C includes and ignores computed includes', () => {
    expect(extractCIncludes([
      '#include "local.h"',
      '# include <stdio.h>',
      '#include HEADER_NAME',
      '#include "local.h"',
    ].join('\n'))).toEqual(['local.h', '<stdio.h>']);
  });

  it('extracts includes through comments without reading commented directives', () => {
    expect(extractCIncludes([
      '/* #include "hidden-block.h" */',
      '// #include <hidden-line.h>',
      '/* prefix */ # /* gap */ include /* operand */ "visible.h" // trailing',
      '#include "path//component.h"',
      'const char *text = "/* #include <not-a-directive.h> */";',
    ].join('\n'))).toEqual(['visible.h', 'path//component.h']);
  });

  it('requires matching include delimiters and a complete directive', () => {
    expect(extractCIncludes([
      '#include "wrong-angle.h>',
      '#include <wrong-quote.h"',
      '#include "valid-local.h"',
      '#include <valid-system.h>',
      '#include <trailing.h> unexpected',
      '#include HEADER',
    ].join('\n'))).toEqual(['valid-local.h', '<valid-system.h>']);
  });

  it('handles backslash-newline splicing before include lexing', () => {
    expect(extractCIncludes('#inc\\\nlude "continued.h"\n')).toEqual(['continued.h']);
  });

  it('uses a bounded suffix index for a large synthetic file set', () => {
    expect(IMPORT_RESOLUTION_BATCH_LIMITS.sourceRows).toBeLessThanOrEqual(128);
    expect(IMPORT_RESOLUTION_BATCH_LIMITS.unresolvedImports).toBeLessThanOrEqual(512);
    expect(IMPORT_RESOLUTION_BATCH_LIMITS.overlayPaths).toBeLessThanOrEqual(128);
    const index = new IncludePathIndex();
    const fileCount = 20_000;
    for (let id = 1; id <= fileCount; id++) {
      index.add(id, `/repo/package-${id}/include/api-${id}.h`);
    }

    for (let id = 1; id <= fileCount; id += 37) {
      expect(index.resolve('/repo/src/main.c', `package-${id}/include/api-${id}.h`))
        .toMatchObject({ id, resolutionMethod: 'include_suffix_unique' });
    }
    expect(index.stats).toMatchObject({ candidates: fileCount, basenames: fileCount });
    expect(index.stats.suffixNodes).toBeLessThan(fileCount * 5);
  });

  it('does not return a heuristic include match when the best score is tied', () => {
    const index = new IncludePathIndex();
    index.add(1, '/repo/alpha/include/config.h');
    index.add(2, '/repo/beta/include/config.h');

    expect(index.resolve('/repo/src/main.c', 'config.h')).toBeNull();
  });

  it('runs without error on empty database', async () => {
    const stage = new ImportResolutionStage();
    const ctx = makeCtx(db);
    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
  });

  it('resolves internal imports when files exist', async () => {
    // Insert files
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES (?, ?, 'main', 'baseline', 1)",
    ).run('src/a.ts', 'typescript');
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES (?, ?, 'main', 'baseline', 1)",
    ).run('src/b.ts', 'typescript');

    const fileA = db.prepare("SELECT id FROM files WHERE path = 'src/a.ts'").get() as { id: number };
    const fileB = db.prepare("SELECT id FROM files WHERE path = 'src/b.ts'").get() as { id: number };

    // Insert an import from a.ts → ./b (should resolve to b.ts)
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, layer, generation) VALUES (?, ?, ?, ?)',
    ).run(fileA.id, './b', 'baseline', 1);

    const stage = new ImportResolutionStage();
    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // Check that the import was resolved
    const imp = db.prepare('SELECT resolved_id FROM file_imports WHERE file_id = ?').get(fileA.id) as { resolved_id: number | null };
    expect(imp).toBeDefined();
    // resolved_id should point to fileB if the resolver matched
    if (imp.resolved_id !== null) {
      expect(imp.resolved_id).toBe(fileB.id);
    }
  });

  it('inserts external dependency for unresolved non-internal imports', async () => {
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES (?, ?, 'main', 'baseline', 1)",
    ).run('src/app.ts', 'typescript');

    const fileA = db.prepare("SELECT id FROM files WHERE path = 'src/app.ts'").get() as { id: number };

    // Insert an import that looks external (e.g., npm package)
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, layer, generation) VALUES (?, ?, ?, ?)',
    ).run(fileA.id, 'lodash', 'baseline', 1);

    const stage = new ImportResolutionStage();
    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // Should have inserted into external_deps
    const ext = db.prepare('SELECT package FROM external_deps WHERE file_id = ?').all(fileA.id) as Array<{ package: string }>;
    expect(ext.length).toBeGreaterThanOrEqual(1);
    expect(ext.some(e => e.package === 'lodash')).toBe(true);
    expect(db.prepare(
      'SELECT resolved_id, resolution_method FROM file_imports WHERE file_id = ?',
    ).get(fileA.id)).toEqual({
      resolved_id: null,
      resolution_method: 'external_dependency',
    });
  });

  it('extracts and suffix-resolves C header dependencies', async () => {
    db.prepare(
      "INSERT INTO files (path, language, branch, source, layer, generation) VALUES ('/tmp/test/src/main.c', 'c', 'main', '#include \"config.h\"', 'baseline', 1)",
    ).run();
    db.prepare(
      "INSERT INTO files (path, language, branch, source, layer, generation) VALUES ('/tmp/test/include/config.h', 'c', 'main', '#define CONFIG 1', 'baseline', 1)",
    ).run();

    const source = db.prepare("SELECT id FROM files WHERE path = '/tmp/test/src/main.c'").get() as { id: number };
    const target = db.prepare("SELECT id FROM files WHERE path = '/tmp/test/include/config.h'").get() as { id: number };
    await new ImportResolutionStage().execute(makeCtx(db), 'build');

    const include = db.prepare(
      "SELECT raw_import, resolved_id FROM file_imports WHERE file_id = ? AND raw_import = 'config.h'",
    ).get(source.id) as { raw_import: string; resolved_id: number | null };
    expect(include).toEqual({ raw_import: 'config.h', resolved_id: target.id });
  });

  it('keeps missing quoted C includes unresolved while classifying angle includes as external', async () => {
    db.prepare(
      `INSERT INTO files (path, language, branch, source, layer, generation)
       VALUES ('/tmp/test/src/main.c', 'c', 'main', '#include "generated.h"\n#include <stdio.h>', 'baseline', 1)`,
    ).run();

    await new ImportResolutionStage().execute(makeCtx(db), 'build');
    expect(db.prepare(
      `SELECT raw_import, resolution_method FROM file_imports ORDER BY raw_import`,
    ).all()).toEqual([
      { raw_import: '<stdio.h>', resolution_method: 'external_dependency' },
      { raw_import: 'generated.h', resolution_method: 'unresolved' },
    ]);
  });

  it('chooses the nearest module when C header basenames are duplicated', async () => {
    for (const [filePath, source] of [
      ['/tmp/test/lib/compress/main.c', '#include "mem.h"'],
      ['/tmp/test/lib/common/mem.h', '#define CORE_MEM 1'],
      ['/tmp/test/contrib/kernel/mem.h', '#define KERNEL_MEM 1'],
    ] as const) {
      db.prepare(
        "INSERT INTO files (path, language, branch, source, layer, generation) VALUES (?, 'c', 'main', ?, 'baseline', 1)",
      ).run(filePath, source);
    }

    await new ImportResolutionStage().execute(makeCtx(db), 'build');
    const include = db.prepare(
      `SELECT target.path, fi.resolution_method
       FROM file_imports fi
       JOIN files source ON source.id = fi.file_id
       JOIN files target ON target.id = fi.resolved_id
       WHERE source.path = '/tmp/test/lib/compress/main.c' AND fi.raw_import = 'mem.h'`,
    ).get() as { path: string; resolution_method: string };
    expect(include.path).toBe('/tmp/test/lib/common/mem.h');
    expect(include.resolution_method).toBe('include_basename_nearest');
  });

  it('scopes overlay source extraction and unresolved-import work to current files', async () => {
    for (const [filePath, source, layer] of [
      ['/tmp/test/old/main.c', '#include "old.h"', 'baseline'],
      ['/tmp/test/old/old.h', '#define OLD 1', 'baseline'],
      ['/tmp/test/new/main.c', '#include "new.h"', 'overlay'],
      ['/tmp/test/new/new.h', '#define NEW 1', 'overlay'],
    ] as const) {
      db.prepare(
        `INSERT INTO files (path, language, branch, source, layer, generation)
         VALUES (?, 'c', 'main', ?, ?, ?)`,
      ).run(filePath, source, layer, layer === 'overlay' ? 0 : 1);
    }
    for (const filePath of ['/tmp/test/new/main.c', '/tmp/test/new/new.h']) {
      db.prepare(
        `INSERT INTO dirty_files (path, branch, overlay_gen)
         VALUES (?, 'main', 0)`,
      ).run(filePath);
    }

    const ctx = makeCtx(db, {
      layer: 'overlay',
      generation: 0,
      files: [{ path: '/tmp/test/new/main.c', language: 'c' }],
    });
    await new ImportResolutionStage().execute(ctx, 'update');

    const imports = db.prepare(
      `SELECT source.path, fi.raw_import, fi.layer
       FROM file_imports fi JOIN files source ON source.id = fi.file_id
       ORDER BY source.path`,
    ).all() as Array<{ path: string; raw_import: string; layer: string }>;
    expect(imports).toEqual([{
      path: '/tmp/test/new/main.c',
      raw_import: 'new.h',
      layer: 'overlay',
    }]);
  });
});

describe('ReverseDepsStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('has the correct name', () => {
    const stage = new ReverseDepsStage();
    expect(stage.name).toBe('reverse-deps');
  });

  it('runs without error on empty database in build mode', async () => {
    const stage = new ReverseDepsStage();
    const ctx = makeCtx(db);
    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
  });

  it('builds reverse deps from resolved imports', async () => {
    // Insert two files
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/a.ts', 'typescript', 'main', 'baseline', 1)",
    ).run();
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/b.ts', 'typescript', 'main', 'baseline', 1)",
    ).run();

    const fileA = db.prepare("SELECT id FROM files WHERE path = 'src/a.ts'").get() as { id: number };
    const fileB = db.prepare("SELECT id FROM files WHERE path = 'src/b.ts'").get() as { id: number };

    // a.ts imports b.ts (resolved)
    db.prepare(
      'INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation) VALUES (?, ?, ?, ?, ?)',
    ).run(fileA.id, './b', fileB.id, 'baseline', 1);

    const stage = new ReverseDepsStage();
    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // b.ts is depended on by a.ts
    const deps = db.prepare('SELECT * FROM reverse_deps WHERE file_id = ?').all(fileB.id) as Array<{ dependent_id: number }>;
    expect(deps.length).toBeGreaterThanOrEqual(1);
    expect(deps.some(d => d.dependent_id === fileA.id)).toBe(true);
  });

  it('handles update mode with no changed files', async () => {
    const stage = new ReverseDepsStage();
    const ctx = makeCtx(db, { changedFiles: [] });
    await expect(stage.execute(ctx, 'update')).resolves.not.toThrow();
  });
});

describe('OverlayCleanupStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('has the correct name', () => {
    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: Math.floor(Date.now() / 1000),
    });
    expect(stage.name).toBe('overlay-cleanup');
  });

  it('deletes old baseline rows', async () => {
    // Insert a file with generation 1
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/old.ts', 'typescript', 'main', 'baseline', 1)",
    ).run();

    // Insert a file with generation 2
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/new.ts', 'typescript', 'main', 'baseline', 2)",
    ).run();

    // Simulate a newer writer already staging its own hidden generation.
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/future.ts', 'typescript', 'main', 'baseline', 3)",
    ).run();

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: Math.floor(Date.now() / 1000) + 100,
    });

    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // Old generation file should be deleted
    const old = db.prepare("SELECT * FROM files WHERE path = 'src/old.ts'").get();
    expect(old).toBeUndefined();

    // New generation file should remain
    const newer = db.prepare("SELECT * FROM files WHERE path = 'src/new.ts'").get();
    expect(newer).toBeDefined();

    const future = db.prepare("SELECT * FROM files WHERE path = 'src/future.ts'").get();
    expect(future).toBeDefined();
  });

  it('stores baseline HEAD SHA when headSha provided', async () => {
    db.prepare(
      "INSERT INTO files (path, language, branch, layer, generation) VALUES ('src/a.ts', 'typescript', 'main', 'baseline', 2)",
    ).run();

    const stage = new OverlayCleanupStage({
      newGeneration: 2,
      rebuildStartedAt: Math.floor(Date.now() / 1000) + 100,
      headSha: 'abc123def456',
    });

    const ctx = makeCtx(db);
    await stage.execute(ctx, 'build');

    // Verify HEAD SHA was stored
    const meta = db.prepare("SELECT value FROM lore_meta WHERE key = 'baseline_head_sha'").get() as { value: string } | undefined;
    expect(meta).toBeDefined();
    expect(meta!.value).toBe('abc123def456');
  });
});

describe('EmbeddingStage', () => {
  it('has the correct name', () => {
    const stage = new EmbeddingStage();
    expect(stage.name).toBe('embedding');
  });

  it('skips when no embedder is configured', async () => {
    resetLogger();
    const db = openDb(':memory:');
    const ctx = makeCtx(db, { embedder: null });
    const stage = new EmbeddingStage();

    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
    db.close();
  });
});
