import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type Database } from '../../src/db/schema.js';
import { ImportResolutionStage } from '../../src/indexer/stages/import-resolution.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';
import { discoverCompilationDatabase } from '../../src/scip/compdb.js';

function makeContext(db: Database.Database, rootDir: string): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir } as PipelineContext['walkerConfig'],
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
  };
}

describe('ImportResolutionStage compilation database integration', () => {
  let rootDir: string;
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-import-compdb-'));
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
    resetLogger();
  });

  it('uses shared validated discovery, including fallback candidates and response-file include paths', async () => {
    const sourcePath = path.join(rootDir, 'src', 'main.c');
    const headerPath = path.join(rootDir, 'include', 'config.h');
    const buildDir = path.join(rootDir, 'build');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(headerPath), { recursive: true });
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(sourcePath, '#include "config.h"\n');
    fs.writeFileSync(headerPath, '#define CONFIG 1\n');

    // The first candidate is malformed. Both scip-clang setup and import
    // resolution must skip it and select the same validated build candidate.
    fs.writeFileSync(path.join(rootDir, 'compile_commands.json'), '{bad');
    fs.writeFileSync(path.join(buildDir, 'flags.rsp'), '-I../include');
    fs.writeFileSync(path.join(buildDir, 'compile_commands.json'), JSON.stringify([{
      directory: buildDir,
      file: sourcePath,
      arguments: ['clang', '@flags.rsp', '-c', sourcePath],
    }]));

    db.prepare(
      "INSERT INTO files (path, language, branch, source, layer, generation) VALUES (?, 'c', 'main', ?, 'baseline', 1)",
    ).run(sourcePath, '#include "config.h"\n');
    db.prepare(
      "INSERT INTO files (path, language, branch, source, layer, generation) VALUES (?, 'c', 'main', ?, 'baseline', 1)",
    ).run(headerPath, '#define CONFIG 1\n');

    await new ImportResolutionStage().execute(makeContext(db, rootDir), 'build');

    const resolved = db.prepare(
      `SELECT target.path
       FROM file_imports fi
       JOIN files source ON source.id = fi.file_id
       JOIN files target ON target.id = fi.resolved_id
       WHERE source.path = ? AND fi.raw_import = 'config.h'`,
    ).get(sourcePath) as { path: string } | undefined;
    expect(resolved?.path).toBe(headerPath);
  });

  it('reuses the run-scoped parsed database instead of parsing it again', async () => {
    const sourcePath = path.join(rootDir, 'src', 'main.c');
    const firstHeader = path.join(rootDir, 'include-a', 'config.h');
    const selectedHeader = path.join(rootDir, 'include-b', 'config.h');
    for (const filePath of [sourcePath, firstHeader, selectedHeader]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(sourcePath, '#include "config.h"\n');
    fs.writeFileSync(firstHeader, '#define CONFIG_A 1\n');
    fs.writeFileSync(selectedHeader, '#define CONFIG_B 1\n');

    const compdbPath = path.join(rootDir, 'compile_commands.json');
    fs.writeFileSync(compdbPath, JSON.stringify([{
      directory: rootDir,
      file: sourcePath,
      arguments: ['clang', `-I${path.dirname(selectedHeader)}`, '-c', sourcePath],
    }]));
    const cached = discoverCompilationDatabase(rootDir);
    expect(cached.database?.path).toBe(compdbPath);
    fs.unlinkSync(compdbPath);

    for (const [filePath, source] of [
      [sourcePath, '#include "config.h"\n'],
      [firstHeader, '#define CONFIG_A 1\n'],
      [selectedHeader, '#define CONFIG_B 1\n'],
    ]) {
      db.prepare(
        `INSERT INTO files (path, language, branch, source, layer, generation)
         VALUES (?, 'c', 'main', ?, 'baseline', 1)`,
      ).run(filePath, source);
    }

    const context = makeContext(db, rootDir);
    context.compilationDatabase = cached;
    await new ImportResolutionStage().execute(context, 'build');

    const resolved = db.prepare(
      `SELECT target.path, fi.resolution_method
       FROM file_imports fi
       JOIN files source ON source.id = fi.file_id
       JOIN files target ON target.id = fi.resolved_id
       WHERE source.path = ? AND fi.raw_import = 'config.h'`,
    ).get(sourcePath) as { path: string; resolution_method: string } | undefined;
    expect(resolved).toEqual({
      path: selectedHeader,
      resolution_method: 'compilation_database',
    });
  });
});
