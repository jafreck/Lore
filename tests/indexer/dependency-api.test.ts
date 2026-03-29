import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import { DependencyApiStage } from '../../src/indexer/stages/dependency-api.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

let tmpDir: string;
let db: Database.Database;

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: tmpDir } as any,
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

beforeEach(() => {
  resetLogger();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dep-api-'));
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DependencyApiStage', () => {
  it('has the correct name', () => {
    expect(new DependencyApiStage().name).toBe('dependency-api');
  });

  it('is a no-op when indexDependencies is false', async () => {
    const stage = new DependencyApiStage();
    const ctx = makeCtx({ indexDependencies: false });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const rows = db.prepare('SELECT * FROM external_symbols').all();
    expect(rows.length).toBe(0);
  });

  it('clears external_symbols even when indexDependencies is false', async () => {
    // Pre-populate with stale data
    db.prepare(
      `INSERT INTO external_symbols (package_name, symbol_name, symbol_kind, signature)
       VALUES ('stale-pkg', 'staleFunc', 'function', 'function staleFunc(): void')`,
    ).run();

    const before = db.prepare('SELECT COUNT(*) AS cnt FROM external_symbols').get() as { cnt: number };
    expect(before.cnt).toBe(1);

    const stage = new DependencyApiStage();
    await stage.execute(makeCtx({ indexDependencies: false }), 'build');
    await stage.dispose?.();

    const after = db.prepare('SELECT COUNT(*) AS cnt FROM external_symbols').get() as { cnt: number };
    expect(after.cnt).toBe(0);
  });

  it('skips when no package.json exists', async () => {
    const stage = new DependencyApiStage();
    const ctx = makeCtx({ indexDependencies: true });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const rows = db.prepare('SELECT * FROM external_symbols').all();
    expect(rows.length).toBe(0);
  });

  it('skips when package.json has no dependencies', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));

    const stage = new DependencyApiStage();
    const ctx = makeCtx({ indexDependencies: true });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const rows = db.prepare('SELECT * FROM external_symbols').all();
    expect(rows.length).toBe(0);
  });

  it('indexes .d.ts files from a real node_modules directory', async () => {
    // Create a fake package with a .d.ts file
    const pkgName = 'test-lib';
    const pkgDir = path.join(tmpDir, 'node_modules', pkgName);
    fs.mkdirSync(pkgDir, { recursive: true });

    // package.json for the dependency
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkgName, version: '2.0.0' }),
    );

    // A .d.ts file with an exported function
    fs.writeFileSync(
      path.join(pkgDir, 'index.d.ts'),
      `export declare function helperFunc(x: number): string;\nexport declare class Widget {\n  render(): void;\n}\n`,
    );

    // Root package.json declaring the dependency
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'my-project',
        version: '1.0.0',
        dependencies: { [pkgName]: '^2.0.0' },
      }),
    );

    const stage = new DependencyApiStage();
    const ctx = makeCtx({ indexDependencies: true });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const rows = db.prepare('SELECT * FROM external_symbols').all() as Array<{
      package_name: string;
      package_version: string;
      symbol_name: string;
      symbol_kind: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some(r => r.package_name === pkgName)).toBe(true);
    expect(rows.some(r => r.package_version === '2.0.0')).toBe(true);
  });

  it('skips missing node_modules directory for declared dependency', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'my-project',
        version: '1.0.0',
        dependencies: { 'nonexistent-dep': '^1.0.0' },
      }),
    );

    const stage = new DependencyApiStage();
    const ctx = makeCtx({ indexDependencies: true });
    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
    await stage.dispose?.();
  });

  it('handles devDependencies', async () => {
    const pkgName = 'dev-lib';
    const pkgDir = path.join(tmpDir, 'node_modules', pkgName);
    fs.mkdirSync(pkgDir, { recursive: true });

    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkgName, version: '3.0.0' }),
    );
    fs.writeFileSync(
      path.join(pkgDir, 'index.d.ts'),
      `export declare function devHelper(): void;\n`,
    );

    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'my-project',
        version: '1.0.0',
        devDependencies: { [pkgName]: '^3.0.0' },
      }),
    );

    const stage = new DependencyApiStage();
    const ctx = makeCtx({ indexDependencies: true });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const rows = db.prepare('SELECT * FROM external_symbols WHERE package_name = ?').all(pkgName);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
