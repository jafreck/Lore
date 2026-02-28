import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function queryInheritanceRelationships(
  dbPath: string,
): Array<{ source_name: string; target_name: string; relationship_type: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT s_src.name AS source_name,
           rel.target_symbol_name AS target_name,
           rel.relationship_type AS relationship_type
      FROM symbol_relationships rel
      JOIN symbols s_src ON s_src.id = rel.source_symbol_id
  `).all() as Array<{ source_name: string; target_name: string; relationship_type: string }>;
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

  it('should persist extracted inheritance relationships during build', async () => {
    writeFileSync(
      join(srcDir, 'inheritance.ts'),
      'export class Base {}\nexport class Child extends Base {}\n',
    );
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    expect(queryInheritanceRelationships(dbPath)).toContainEqual({
      source_name: 'Child',
      target_name: 'Base',
      relationship_type: 'extends',
    });
  });

  it('should persist target_symbol_id when relationship target is indexed', async () => {
    writeFileSync(
      join(srcDir, 'inheritance.ts'),
      'export class Base {}\nexport class Child extends Base {}\n',
    );
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    const db = new Database(dbPath, { readonly: true });
    const relationship = db.prepare(`
      SELECT rel.target_symbol_id AS target_symbol_id,
             rel.target_symbol_name AS target_symbol_name
        FROM symbol_relationships rel
        JOIN symbols s_src ON s_src.id = rel.source_symbol_id
       WHERE s_src.name = 'Child'
         AND rel.relationship_type = 'extends'
    `).get() as { target_symbol_id: number | null; target_symbol_name: string } | undefined;
    db.close();

    expect(relationship).toBeDefined();
    expect(relationship?.target_symbol_name).toBe('Base');
    expect(relationship?.target_symbol_id).not.toBeNull();
  });

  it('should persist relationships even when target symbol is not indexed', async () => {
    writeFileSync(
      join(srcDir, 'external-inheritance.ts'),
      'export class Child extends ExternalBase {}\n',
    );
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    const db = new Database(dbPath, { readonly: true });
    const relationship = db.prepare(`
      SELECT rel.target_symbol_id AS target_symbol_id,
             rel.target_symbol_name AS target_symbol_name
        FROM symbol_relationships rel
        JOIN symbols s_src ON s_src.id = rel.source_symbol_id
       WHERE s_src.name = 'Child'
         AND rel.relationship_type = 'extends'
    `).get() as { target_symbol_id: number | null; target_symbol_name: string } | undefined;
    db.close();

    expect(relationship).toBeDefined();
    expect(relationship?.target_symbol_name).toBe('ExternalBase');
    expect(relationship?.target_symbol_id).toBeNull();
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
