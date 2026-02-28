import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { IndexBuilder } from '../../src/indexer/index.js';

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

  it('should remove branch-scoped file rows and related symbols_fts entries when a tracked file is deleted', async () => {
    const importingFile = join(srcDir, 'consumer.ts');
    writeFileSync(importingFile, 'import { hello } from "./hello";\nexport const value = hello();\n');
    const builderMainForImport = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builderMainForImport.update([importingFile]);

    const builderDev = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'dev' });
    await builderDev.build();

    const beforeDb = new Database(dbPath, { readonly: true });
    const mainFileRow = beforeDb
      .prepare('SELECT id FROM files WHERE path = ? AND branch = ?')
      .get(srcFile, 'main') as { id: number } | undefined;
    expect(mainFileRow).toBeDefined();

    const mainSymbolIds = beforeDb
      .prepare(
        'SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND f.branch = ?',
      )
      .all(srcFile, 'main') as Array<{ id: number }>;
    const resolvedImportRows = beforeDb
      .prepare(
        `SELECT fi.id
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_id = ? AND f.branch = ?`,
      )
      .all(mainFileRow!.id, 'main') as Array<{ id: number }>;
    beforeDb.close();
    expect(mainSymbolIds.length).toBeGreaterThan(0);
    expect(resolvedImportRows.length).toBeGreaterThan(0);

    rmSync(srcFile, { force: true });
    const builderMain = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builderMain.update([srcFile]);

    const afterDb = new Database(dbPath, { readonly: true });
    const deletedMainFile = afterDb
      .prepare('SELECT id FROM files WHERE path = ? AND branch = ?')
      .get(srcFile, 'main') as { id: number } | undefined;
    const devFile = afterDb
      .prepare('SELECT id FROM files WHERE path = ? AND branch = ?')
      .get(srcFile, 'dev') as { id: number } | undefined;
    const staleFtsCountRow = afterDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM symbols_fts
         WHERE rowid IN (${mainSymbolIds.map(() => '?').join(',')})`,
      )
      .get(...mainSymbolIds.map(row => row.id)) as { count: number };
    const clearedResolvedCount = afterDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM file_imports
         WHERE id IN (${resolvedImportRows.map(() => '?').join(',')}) AND resolved_id IS NULL`,
      )
      .get(...resolvedImportRows.map(row => row.id)) as { count: number };
    afterDb.close();

    expect(deletedMainFile).toBeUndefined();
    expect(devFile).toBeDefined();
    expect(staleFtsCountRow.count).toBe(0);
    expect(clearedResolvedCount.count).toBe(resolvedImportRows.length);
  });
});
