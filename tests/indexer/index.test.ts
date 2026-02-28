import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { IndexBuilder } from '../../src/indexer/index.js';
import type { EmbeddingProvider } from '../../src/indexer/embedder.js';

const esmRequire = createRequire(import.meta.url);

/** Create a temp directory containing a minimal TypeScript source file. */
function createTmpSrcDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-index-test-src-'));
  writeFileSync(join(dir, 'hello.ts'), 'export function hello(): string { return "hi"; }\n');
  return dir;
}

/** Create a temp path for a database file (not yet created). */
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-index-test-db-'));
  return join(dir, 'test.db');
}

function queryBranches(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT DISTINCT branch FROM files').all() as { branch: string }[];
  db.close();
  return rows.map(r => r.branch);
}

function queryFilesWithBranch(dbPath: string, branch: string): { path: string; branch: string }[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT path, branch FROM files WHERE branch = ?').all(branch) as { path: string; branch: string }[];
  db.close();
  return rows;
}

function queryStructuralEmbeddingCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  (esmRequire('sqlite-vec') as { load(database: Database.Database): void }).load(db);
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_embeddings'")
    .get() as { name: string } | undefined;
  if (!hasTable) {
    db.close();
    return 0;
  }
  const row = db.prepare('SELECT COUNT(*) AS count FROM symbol_embeddings').get() as { count: number };
  db.close();
  return row.count;
}

describe('IndexBuilder — branch support in build()', () => {
  let srcDir: string;
  let dbPath: string;

  beforeEach(() => {
    srcDir = createTmpSrcDir();
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    try { rmSync(srcDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const dbDir = join(dbPath, '..');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should default branch to "HEAD" when not specified in WalkerConfig', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir });
    await builder.build();
    const branches = queryBranches(dbPath);
    expect(branches).toEqual(['HEAD']);
  });

  it('should use the specified branch when provided in WalkerConfig', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();
    const branches = queryBranches(dbPath);
    expect(branches).toEqual(['main']);
  });

  it('should store all indexed files under the configured branch', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'feat/new-thing' });
    await builder.build();
    const files = queryFilesWithBranch(dbPath, 'feat/new-thing');
    expect(files.length).toBeGreaterThan(0);
    files.forEach(f => expect(f.branch).toBe('feat/new-thing'));
  });

  it('should allow indexing the same source under different branches', async () => {
    const builder1 = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder1.build();

    const builder2 = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'dev' });
    await builder2.build();

    const branches = queryBranches(dbPath).sort();
    expect(branches).toContain('main');
    expect(branches).toContain('dev');
  });
});

describe('IndexBuilder — branch support in update()', () => {
  let srcDir: string;
  let dbPath: string;
  let srcFile: string;

  beforeEach(async () => {
    srcDir = createTmpSrcDir();
    dbPath = tmpDbPath();
    srcFile = join(srcDir, 'hello.ts');

    // Prime the DB with a full build first.
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();
  });

  afterEach(() => {
    try { rmSync(srcDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const dbDir = join(dbPath, '..');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should update files under the configured branch', async () => {
    writeFileSync(srcFile, 'export function updated(): void {}\n');
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.update([srcFile]);

    const files = queryFilesWithBranch(dbPath, 'main');
    expect(files.length).toBeGreaterThan(0);
    files.forEach(f => expect(f.branch).toBe('main'));
  });

  it('should not affect files under a different branch on update', async () => {
    // Build under a second branch
    const builder2 = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'dev' });
    await builder2.build();

    // Modify and update under 'main' only
    writeFileSync(srcFile, 'export function modifiedForMain(): void {}\n');
    const builderMain = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builderMain.update([srcFile]);

    // 'dev' branch files should still be present
    const devFiles = queryFilesWithBranch(dbPath, 'dev');
    expect(devFiles.length).toBeGreaterThan(0);
  });

  it('should default branch to "HEAD" when not specified during update()', async () => {
    // Build under HEAD first
    const builderHead = new IndexBuilder(dbPath, { rootDir: srcDir });
    await builderHead.build();

    writeFileSync(srcFile, 'export function updatedHead(): void {}\n');
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir });
    await builder.update([srcFile]);

    const headFiles = queryFilesWithBranch(dbPath, 'HEAD');
    expect(headFiles.length).toBeGreaterThan(0);
  });

  it('should not persist structural embeddings during update() when embedder is not configured', async () => {
    writeFileSync(srcFile, 'export function updatedWithoutEmbeddings(name: string): string { return name; }\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.update([srcFile]);

    expect(queryStructuralEmbeddingCount(dbPath)).toBe(0);
  });

  it('should persist structural embeddings during update() when embedder is configured', async () => {
    writeFileSync(srcFile, 'export function updatedWithEmbeddings(name: string): string { return name; }\n');

    let initCalled = false;
    const embedder: EmbeddingProvider = {
      modelName: 'test-embedder',
      dims: 3,
      async init(): Promise<void> {
        initCalled = true;
      },
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((_, i) => [i + 1, i + 2, i + 3]);
      },
      async dispose(): Promise<void> {},
    };

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, embedder);
    await builder.update([srcFile]);

    expect(initCalled).toBe(true);
    expect(queryStructuralEmbeddingCount(dbPath)).toBeGreaterThan(0);
  });
});
