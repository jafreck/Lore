import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function createGitRepoWithCommit(dir: string, branchName = 'feature/auto-branch'): string {
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Lore Test']);
  runGit(dir, ['config', 'user.email', 'lore-test@example.com']);
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'initial']);
  runGit(dir, ['checkout', '-b', branchName]);
  return branchName;
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

  it('should detect and use the current git branch when branch is omitted', async () => {
    const branch = createGitRepoWithCommit(srcDir);
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir });
    await builder.build();
    const branches = queryBranches(dbPath);
    expect(branches).toEqual([branch]);
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

  it('should persist checkpoint and last known HEAD metadata after build', async () => {
    const branch = createGitRepoWithCommit(srcDir);
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir });
    await builder.build();

    const db = new Database(dbPath, { readonly: true });
    const checkpointRow = db
      .prepare("SELECT value FROM kb_meta WHERE key = 'index_checkpoint'")
      .get() as { value: string } | undefined;
    const headRow = db
      .prepare("SELECT value FROM kb_meta WHERE key = 'last_known_head_sha'")
      .get() as { value: string } | undefined;
    db.close();

    expect(checkpointRow).toBeDefined();
    const checkpoint = JSON.parse(checkpointRow!.value) as { branch: string; nextFileIndex: number; totalFiles: number };
    expect(checkpoint.branch).toBe(branch);
    expect(checkpoint.nextFileIndex).toBe(checkpoint.totalFiles);
    expect(headRow?.value).toBe(runGit(srcDir, ['rev-parse', 'HEAD']));
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

  it('should detect and use the current git branch during update when branch is omitted', async () => {
    const gitBranch = createGitRepoWithCommit(srcDir, 'feature/update-auto');
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: gitBranch });
    await builder.build();

    writeFileSync(srcFile, 'export function updatedOnAutoBranch(): void {}\n');
    const autoBranchBuilder = new IndexBuilder(dbPath, { rootDir: srcDir });
    await autoBranchBuilder.update([srcFile]);

    const files = queryFilesWithBranch(dbPath, gitBranch);
    expect(files.length).toBeGreaterThan(0);
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

describe('IndexBuilder — call graph resolution during indexing', () => {
  let srcDir: string;
  let dbPath: string;
  let srcFile: string;

  beforeEach(() => {
    srcDir = createTmpSrcDir();
    dbPath = tmpDbPath();
    srcFile = join(srcDir, 'hello.ts');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    try { rmSync(srcDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const dbDir = join(dbPath, '..');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should invoke buildCallGraph during build()', async () => {
    vi.resetModules();
    const buildCallGraph = vi.fn();
    vi.doMock('../../src/indexer/call-graph.js', () => ({ buildCallGraph }));
    const { IndexBuilder: MockedIndexBuilder } = await import('../../src/indexer/index.js');

    const builder = new MockedIndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    expect(buildCallGraph).toHaveBeenCalledTimes(1);
  });

  it('should invoke buildCallGraph during update()', async () => {
    vi.resetModules();
    const buildCallGraph = vi.fn();
    vi.doMock('../../src/indexer/call-graph.js', () => ({ buildCallGraph }));
    const { IndexBuilder: MockedIndexBuilder } = await import('../../src/indexer/index.js');
    const builder = new MockedIndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    writeFileSync(srcFile, 'export function updated(): string { return "ok"; }\n');
    await builder.update([srcFile]);

    expect(buildCallGraph).toHaveBeenCalledTimes(2);
  });
});
