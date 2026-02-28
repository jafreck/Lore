import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

function querySymbolNamesForFile(dbPath: string, filePath: string, branch: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT s.name
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE f.path = ? AND f.branch = ?
     ORDER BY s.name`,
  ).all(filePath, branch) as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
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
});

describe('IndexBuilder — transactional file loops', () => {
  let srcDir: string;
  let dbPath: string;

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'lore-index-test-src-'));
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(srcDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const dbDir = join(dbPath, '..');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should roll back build() file writes when one file processing step fails', async () => {
    const firstFile = join(srcDir, 'one.ts');
    const secondFile = join(srcDir, 'two.ts');
    writeFileSync(firstFile, 'export function one(): string { return "one"; }\n');
    writeFileSync(secondFile, 'export function two(): string { return "two"; }\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    const privateBuilder = builder as unknown as {
      processFile: (db: unknown, filePath: string, language: string, branch: string) => void;
    };
    const originalProcessFile = privateBuilder.processFile.bind(builder) as typeof privateBuilder.processFile;
    let calls = 0;
    vi.spyOn(privateBuilder, 'processFile').mockImplementation((db, filePath, language, branch) => {
      calls += 1;
      if (calls === 2) throw new Error('forced build failure');
      originalProcessFile(db, filePath, language, branch);
    });

    await expect(builder.build()).rejects.toThrow('forced build failure');
    expect(queryFilesWithBranch(dbPath, 'main')).toEqual([]);
  });

  it('should roll back update() file writes when one changed file fails to process', async () => {
    const firstFile = join(srcDir, 'one.ts');
    const secondFile = join(srcDir, 'two.ts');
    writeFileSync(firstFile, 'export function one(): string { return "one"; }\n');
    writeFileSync(secondFile, 'export function two(): string { return "two"; }\n');

    const seedBuilder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await seedBuilder.build();
    expect(querySymbolNamesForFile(dbPath, firstFile, 'main')).toContain('one');

    writeFileSync(firstFile, 'export function oneUpdated(): string { return "one"; }\n');
    writeFileSync(secondFile, 'export function twoUpdated(): string { return "two"; }\n');

    const updateBuilder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    const privateBuilder = updateBuilder as unknown as {
      processFile: (db: unknown, filePath: string, language: string, branch: string) => void;
    };
    const originalProcessFile = privateBuilder.processFile.bind(updateBuilder) as typeof privateBuilder.processFile;
    let calls = 0;
    vi.spyOn(privateBuilder, 'processFile').mockImplementation((db, filePath, language, branch) => {
      calls += 1;
      if (calls === 2) throw new Error('forced update failure');
      originalProcessFile(db, filePath, language, branch);
    });

    await expect(updateBuilder.update([firstFile, secondFile])).rejects.toThrow('forced update failure');
    const symbolNames = querySymbolNamesForFile(dbPath, firstFile, 'main');
    expect(symbolNames).toContain('one');
    expect(symbolNames).not.toContain('oneUpdated');
  });
});
