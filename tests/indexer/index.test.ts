import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { IndexBuilder } from '../../src/indexer/index.js';
import { buildCallGraph } from '../../src/indexer/call-graph.js';
import type { EmbeddingProvider } from '../../src/indexer/embedder.js';

const esmRequire = createRequire(import.meta.url);
const HELLO_SOURCE = 'export function hello(): string { return "hi"; }\n';

/** Create a temp directory containing a minimal TypeScript source file. */
function createTmpSrcDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-index-test-src-'));
  writeFileSync(join(dir, 'hello.ts'), HELLO_SOURCE);
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

function queryFileSourceForBranch(dbPath: string, filePath: string, branch: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT source FROM files WHERE path = ? AND branch = ?').get(filePath, branch) as
    | { source: string }
    | undefined;
  db.close();
  return row?.source;
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

function queryCommitCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT COUNT(*) as count FROM commits').get() as { count: number };
  db.close();
  return row.count;
}

function queryCommitEmbeddingCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  (esmRequire('sqlite-vec') as { load(database: Database.Database): void }).load(db);
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'commit_embeddings'")
    .get() as { name: string } | undefined;
  if (!hasTable) {
    db.close();
    return 0;
  }
  const row = db.prepare('SELECT COUNT(*) AS count FROM commit_embeddings').get() as { count: number };
  db.close();
  return row.count;
}

function queryKbMetaValue(dbPath: string, key: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM lore_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  db.close();
  return row?.value;
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

function queryExternalSymbolsForPackage(
  dbPath: string,
  packageName: string,
): Array<{ symbol_name: string; symbol_kind: string; signature: string; doc_comment: string | null; package_version: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT symbol_name, symbol_kind, signature, doc_comment, package_version
     FROM external_symbols
     WHERE package_name = ?
     ORDER BY symbol_name`,
  ).all(packageName) as Array<{
    symbol_name: string;
    symbol_kind: string;
    signature: string;
    doc_comment: string | null;
    package_version: string | null;
  }>;
  db.close();
  return rows;
}

function querySymbolCountByName(dbPath: string, symbolName: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT COUNT(*) AS count FROM symbols WHERE name = ?').get(symbolName) as { count: number };
  db.close();
  return row.count;
}

function queryExternalSymbolCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT COUNT(*) AS count FROM external_symbols').get() as { count: number };
  db.close();
  return row.count;
}

function queryRoutesForFile(
  dbPath: string,
  filePath: string,
  branch: string,
): Array<{ method: string; path: string; handler_id: number | null; handler_name: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT ar.method, ar.path, ar.handler_id, ar.handler_name
     FROM api_routes ar
     JOIN files f ON f.id = ar.file_id
     WHERE f.path = ? AND f.branch = ?
     ORDER BY ar.method, ar.path`,
  ).all(filePath, branch) as Array<{ method: string; path: string; handler_id: number | null; handler_name: string }>;
  db.close();
  return rows;
}

function queryTestsForSourceFile(
  dbPath: string,
  sourcePath: string,
  branch: string,
): Array<{ test_path: string; confidence: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT test_files.path AS test_path, tm.confidence
     FROM test_mappings tm
     JOIN files source_files ON source_files.id = tm.source_file_id
     JOIN files test_files ON test_files.id = tm.test_file_id
     WHERE source_files.path = ? AND source_files.branch = ?
     ORDER BY test_files.path`,
  ).all(sourcePath, branch) as Array<{ test_path: string; confidence: string }>;
  db.close();
  return rows;
}

function queryDocsForBranch(
  dbPath: string,
  branch: string,
): Array<{ id: number; path: string; kind: string; title: string; content_hash: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT id, path, kind, title, content_hash
     FROM docs
     WHERE branch = ?
     ORDER BY path`,
  ).all(branch) as Array<{ id: number; path: string; kind: string; title: string; content_hash: string }>;
  db.close();
  return rows;
}

function queryDocSectionsForPath(
  dbPath: string,
  filePath: string,
  branch: string,
): Array<{ id: number; section_index: number; title: string; heading_path: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT ds.id, ds.section_index, ds.title, ds.heading_path
     FROM doc_sections ds
     JOIN docs d ON d.id = ds.doc_id
     WHERE d.path = ? AND d.branch = ?
     ORDER BY ds.section_index`,
  ).all(filePath, branch) as Array<{ id: number; section_index: number; title: string; heading_path: string }>;
  db.close();
  return rows;
}

function queryDocSectionEmbeddingCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  (esmRequire('sqlite-vec') as { load(database: Database.Database): void }).load(db);
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'doc_section_embeddings'")
    .get() as { name: string } | undefined;
  if (!hasTable) {
    db.close();
    return 0;
  }
  const row = db.prepare('SELECT COUNT(*) AS count FROM doc_section_embeddings').get() as { count: number };
  db.close();
  return row.count;
}

function queryDocScopedNotes(
  dbPath: string,
): Array<{ key: string; scope: string; content: string; source_hash: string | null; updated_at: number }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT key, scope, content, source_hash, updated_at
     FROM notes
     WHERE scope LIKE 'doc:%'
     ORDER BY key, scope`,
  ).all() as Array<{ key: string; scope: string; content: string; source_hash: string | null; updated_at: number }>;
  db.close();
  return rows;
}

describe('IndexBuilder — dependency indexing options', () => {
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

  it('should index project symbols when indexDependencies is omitted', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    expect(querySymbolNamesForFile(dbPath, join(srcDir, 'hello.ts'), 'main')).toContain('hello');
    expect(queryExternalSymbolCount(dbPath)).toBe(0);
  });

  it('should still build and ingest history when indexDependencies is enabled', async () => {
    const branch = createGitRepoWithCommit(srcDir);
    const builder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir },
      undefined,
      { history: true, indexDependencies: true },
    );
    await builder.build();

    expect(querySymbolNamesForFile(dbPath, join(srcDir, 'hello.ts'), branch)).toContain('hello');
    expect(queryCommitCount(dbPath)).toBeGreaterThan(0);
    expect(queryCommitEmbeddingCount(dbPath)).toBe(0);
  });

  it('should persist commit embeddings during build when history and an embedder are enabled', async () => {
    createGitRepoWithCommit(srcDir);

    const embedder: EmbeddingProvider = {
      modelName: 'test-embedder',
      dims: 3,
      async init(): Promise<void> {},
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((_, i) => [i + 1, i + 2, i + 3]);
      },
      async dispose(): Promise<void> {},
    };

    const builder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      embedder,
      { history: true },
    );
    await builder.build();

    expect(queryCommitCount(dbPath)).toBeGreaterThan(0);
    expect(queryCommitEmbeddingCount(dbPath)).toBe(queryCommitCount(dbPath));
  });

  it('should skip commit embeddings for empty commit messages during build', async () => {
    runGit(srcDir, ['init']);
    runGit(srcDir, ['config', 'user.name', 'Test User']);
    runGit(srcDir, ['config', 'user.email', 'test@example.com']);
    runGit(srcDir, ['add', 'hello.ts']);
    runGit(srcDir, ['commit', '--allow-empty-message', '-m', '']);

    const embedder: EmbeddingProvider = {
      modelName: 'test-embedder',
      dims: 3,
      async init(): Promise<void> {},
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((_, i) => [i + 1, i + 2, i + 3]);
      },
      async dispose(): Promise<void> {},
    };

    const builder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      embedder,
      { history: true },
    );
    await builder.build();

    const db = new Database(dbPath, { readonly: true });
    const nonEmptyCommitMessages = db.prepare(
      'SELECT COUNT(*) AS count FROM commits WHERE length(trim(message)) > 0',
    ).get() as { count: number };
    db.close();

    expect(queryCommitCount(dbPath)).toBeGreaterThan(0);
    expect(nonEmptyCommitMessages.count).toBe(0);
    expect(queryCommitEmbeddingCount(dbPath)).toBe(0);
  });

  it('should index only direct dependency declaration exports into external_symbols', async () => {
    writeFileSync(
      join(srcDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        dependencies: {
          'dep-one': '^1.0.0',
        },
      }),
    );

    const depOneDir = join(srcDir, 'node_modules', 'dep-one');
    const transitiveDir = join(depOneDir, 'node_modules', 'dep-transitive');
    mkdirSync(depOneDir, { recursive: true });
    mkdirSync(transitiveDir, { recursive: true });

    writeFileSync(
      join(depOneDir, 'package.json'),
      JSON.stringify({ name: 'dep-one', version: '1.2.3' }),
    );
    writeFileSync(
      join(depOneDir, 'index.d.ts'),
      `
      /** Direct dependency public API */
      export declare function depPublic(input: string): string;
      export function depImplementation(input: string): string { return input; }
      declare function depPrivate(): void;
      `,
    );

    writeFileSync(
      join(transitiveDir, 'package.json'),
      JSON.stringify({ name: 'dep-transitive', version: '9.9.9' }),
    );
    writeFileSync(
      join(transitiveDir, 'index.d.ts'),
      'export declare function transitiveFn(): void;',
    );

    const builder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      undefined,
      { indexDependencies: true },
    );
    await builder.build();

    expect(querySymbolNamesForFile(dbPath, join(srcDir, 'hello.ts'), 'main')).toContain('hello');
    expect(queryExternalSymbolsForPackage(dbPath, 'dep-one')).toEqual([
      {
        symbol_name: 'depPublic',
        symbol_kind: 'function',
        signature: 'function depPublic(input: string): string;',
        doc_comment: '/** Direct dependency public API */',
        package_version: '1.2.3',
      },
    ]);
    expect(queryExternalSymbolsForPackage(dbPath, 'dep-transitive')).toEqual([]);
    expect(querySymbolCountByName(dbPath, 'depPublic')).toBe(0);
  });

  it('should keep declaration-only class, interface, and type exports while excluding implementation bodies', async () => {
    writeFileSync(
      join(srcDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        dependencies: {
          'dep-shapes': '^3.0.0',
        },
      }),
    );

    const depDir = join(srcDir, 'node_modules', 'dep-shapes');
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({ name: 'dep-shapes', version: '3.1.4' }),
    );
    writeFileSync(
      join(depDir, 'index.d.ts'),
      `
      export declare class DepClass {
        run(): void;
      }
      export interface DepContract {
        value: string;
      }
      export type DepAlias = string | number;
      export function depRuntimeImplementation(): string { return "runtime"; }
      `,
    );

    const builder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      undefined,
      { indexDependencies: true },
    );
    await builder.build();

    const symbols = queryExternalSymbolsForPackage(dbPath, 'dep-shapes');
    expect(symbols.map((symbol) => symbol.symbol_name)).toEqual(['DepAlias', 'DepClass', 'DepContract']);
    expect(symbols.map((symbol) => symbol.symbol_kind)).toEqual(['type', 'class', 'interface']);
    expect(symbols.find((symbol) => symbol.symbol_name === 'depRuntimeImplementation')).toBeUndefined();
  });

  it('should fall back to declared dependency version when installed package metadata is missing', async () => {
    writeFileSync(
      join(srcDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        dependencies: {
          'dep-without-package-json': '^2.5.0',
        },
      }),
    );

    const depDir = join(srcDir, 'node_modules', 'dep-without-package-json');
    mkdirSync(depDir, { recursive: true });
    writeFileSync(depDir + '/index.d.ts', 'export declare function depFn(): string;');

    const builder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      undefined,
      { indexDependencies: true },
    );
    await builder.build();

    expect(queryExternalSymbolsForPackage(dbPath, 'dep-without-package-json')).toEqual([
      {
        symbol_name: 'depFn',
        symbol_kind: 'function',
        signature: 'function depFn(): string;',
        doc_comment: null,
        package_version: '^2.5.0',
      },
    ]);
  });

  it('should clear external symbols when dependency indexing is turned off for a subsequent build', async () => {
    writeFileSync(
      join(srcDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        dependencies: {
          'dep-one': '^1.0.0',
        },
      }),
    );
    const depDir = join(srcDir, 'node_modules', 'dep-one');
    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: 'dep-one', version: '1.2.3' }));
    writeFileSync(join(depDir, 'index.d.ts'), 'export declare function depPublic(): void;');

    const builderWithDeps = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      undefined,
      { indexDependencies: true },
    );
    await builderWithDeps.build();
    expect(queryExternalSymbolCount(dbPath)).toBe(1);

    const builderWithoutDeps = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      undefined,
      { indexDependencies: false },
    );
    await builderWithoutDeps.build();

    expect(queryExternalSymbolCount(dbPath)).toBe(0);
  });
});

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

  it('should persist indexed file source content during build', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();
    expect(queryFileSourceForBranch(dbPath, join(srcDir, 'hello.ts'), 'main')).toBe(HELLO_SOURCE);
  });

  it('should refresh persisted file source when build reprocesses a changed file', async () => {
    const filePath = join(srcDir, 'hello.ts');
    const updatedSource = 'export function hello(): string { return "updated"; }\n';
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });

    await builder.build();
    expect(queryFileSourceForBranch(dbPath, filePath, 'main')).toBe(HELLO_SOURCE);

    writeFileSync(filePath, updatedSource);
    const db = new Database(dbPath);
    db.prepare(
      "INSERT OR REPLACE INTO lore_meta (key, value) VALUES ('index_checkpoint', ?)",
    ).run(
      JSON.stringify({
        branch: 'main',
        rootDir: srcDir,
        totalFiles: 1,
        nextFileIndex: 0,
        updatedAt: Math.floor(Date.now() / 1000),
      }),
    );
    db.close();

    await builder.build();
    expect(queryFileSourceForBranch(dbPath, filePath, 'main')).toBe(updatedSource);
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
      .prepare("SELECT value FROM lore_meta WHERE key = 'index_checkpoint'")
      .get() as { value: string } | undefined;
    const headRow = db
      .prepare("SELECT value FROM lore_meta WHERE key = 'last_known_head_sha'")
      .get() as { value: string } | undefined;
    db.close();

    expect(checkpointRow).toBeDefined();
    const checkpoint = JSON.parse(checkpointRow!.value) as { branch: string; nextFileIndex: number; totalFiles: number };
    expect(checkpoint.branch).toBe(branch);
    expect(checkpoint.nextFileIndex).toBe(checkpoint.totalFiles);
    expect(headRow?.value).toBe(runGit(srcDir, ['rev-parse', 'HEAD']));
  });

  it('should index documentation content and section chunks during build', async () => {
    const docPath = join(srcDir, 'README.md');
    writeFileSync(docPath, '# Lore\n\n## Install\nUse npm\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    const docs = queryDocsForBranch(dbPath, 'main');
    const indexedDoc = docs.find(doc => doc.path === docPath);
    expect(indexedDoc).toMatchObject({
      path: docPath,
      kind: 'readme',
      title: 'Lore',
    });

    const sections = queryDocSectionsForPath(dbPath, docPath, 'main');
    expect(sections.map(section => section.title)).toEqual(['Lore', 'Install']);
    expect(sections[1]?.heading_path).toBe(JSON.stringify(['Lore', 'Install']));
  });

  it('should remove stale documentation rows on subsequent builds', async () => {
    const docPath = join(srcDir, 'README.md');
    writeFileSync(docPath, '# Lore\n\n## Install\nUse npm\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();
    expect(queryDocsForBranch(dbPath, 'main').find(doc => doc.path === docPath)).toBeDefined();

    rmSync(docPath, { force: true });
    await builder.build();

    expect(queryDocsForBranch(dbPath, 'main').find(doc => doc.path === docPath)).toBeUndefined();
    expect(queryDocSectionsForPath(dbPath, docPath, 'main')).toEqual([]);
  });

  it('should persist documentation chunk embeddings during build when embedder is configured', async () => {
    const docPath = join(srcDir, 'README.md');
    writeFileSync(docPath, '# Lore\n\n## Install\nUse npm\n');

    const embedder: EmbeddingProvider = {
      modelName: 'test-embedder',
      dims: 3,
      async init(): Promise<void> {},
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((_, i) => [i + 1, i + 2, i + 3]);
      },
      async dispose(): Promise<void> {},
    };

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, embedder);
    await builder.build();

    expect(queryDocSectionEmbeddingCount(dbPath)).toBeGreaterThan(0);
  });

  it('should replace stale api_routes rows when build() reprocesses an existing file', async () => {
    const routeFile = join(srcDir, 'routes.js');
    writeFileSync(routeFile, 'function health() { return "ok"; }\napp.get("/health", health);\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();
    expect(queryRoutesForFile(dbPath, routeFile, 'main').map((row) => row.path)).toEqual(['/health']);

    writeFileSync(routeFile, 'function health() { return "ok"; }\napp.get("/status", health);\n');
    const db = new Database(dbPath);
    db.prepare(
      "INSERT OR REPLACE INTO lore_meta (key, value) VALUES ('index_checkpoint', ?)",
    ).run(
      JSON.stringify({ branch: 'main', rootDir: srcDir, totalFiles: 2, nextFileIndex: 0, updatedAt: Math.floor(Date.now() / 1000) }),
    );
    db.close();

    await builder.build();
    expect(queryRoutesForFile(dbPath, routeFile, 'main').map((row) => row.path)).toEqual(['/status']);
  });

  it('should persist test mappings after build resolves imports', async () => {
    const sourceFile = join(srcDir, 'math.ts');
    const testDir = join(srcDir, 'tests');
    const testFile = join(testDir, 'math.test.ts');
    mkdirSync(testDir);
    writeFileSync(sourceFile, 'export const sum = (a: number, b: number) => a + b;\n');
    writeFileSync(testFile, 'import { sum } from "../math";\nexport const value = sum(1, 2);\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    expect(queryTestsForSourceFile(dbPath, sourceFile, 'main')).toEqual([
      { test_path: testFile, confidence: 'import' },
    ]);
  });
});

describe('IndexBuilder — docs auto-notes metadata', () => {
  let srcDir: string;
  let dbPath: string;
  let srcFile: string;

  beforeEach(() => {
    srcDir = createTmpSrcDir();
    dbPath = tmpDbPath();
    srcFile = join(srcDir, 'hello.ts');
  });

  afterEach(() => {
    try { rmSync(srcDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const dbDir = join(dbPath, '..');
    try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should persist docs_auto_notes as enabled by default during build()', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    expect(queryKbMetaValue(dbPath, 'docs_auto_notes')).toBe('1');
  });

  it('should persist docs_auto_notes as disabled during build() when docsAutoNotes is false', async () => {
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, undefined, {
      docsAutoNotes: false,
    });
    await builder.build();

    expect(queryKbMetaValue(dbPath, 'docs_auto_notes')).toBe('0');
  });

  it('should persist docs_auto_notes updates during update()', async () => {
    const defaultBuilder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await defaultBuilder.build();
    expect(queryKbMetaValue(dbPath, 'docs_auto_notes')).toBe('1');

    const disabledBuilder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, undefined, {
      docsAutoNotes: false,
    });
    await disabledBuilder.update([srcFile]);
    expect(queryKbMetaValue(dbPath, 'docs_auto_notes')).toBe('0');

    const enabledBuilder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await enabledBuilder.update([srcFile]);
    expect(queryKbMetaValue(dbPath, 'docs_auto_notes')).toBe('1');
  });
});

describe('IndexBuilder — docs auto-notes seeding', () => {
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

  it('should seed readme, architecture, and adr notes with deterministic keys/scopes and doc source hashes', async () => {
    const readmePath = join(srcDir, 'README.md');
    const architecturePath = join(srcDir, 'ARCHITECTURE.md');
    const adrsDir = join(srcDir, 'docs', 'adrs');
    const adrPath = join(adrsDir, '0001-api-boundaries.md');

    mkdirSync(adrsDir, { recursive: true });
    writeFileSync(readmePath, '# Lore\n\nProject overview\n', 'utf8');
    writeFileSync(architecturePath, '# Architecture\n\nSystem layout\n', 'utf8');
    writeFileSync(adrPath, '# ADR 0001\n\n## Decision\nUse seeded docs notes.\n', 'utf8');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    const notes = queryDocScopedNotes(dbPath);
    expect(notes.map(({ key, scope }) => ({ key, scope }))).toEqual(expect.arrayContaining([
      { key: 'docs/readme', scope: `doc:${readmePath}@main` },
      { key: 'docs/architecture', scope: `doc:${architecturePath}@main` },
      { key: 'docs/adr/0001-api-boundaries', scope: `doc:${adrPath}@main` },
    ]));

    const docsByPath = new Map(queryDocsForBranch(dbPath, 'main').map(doc => [doc.path, doc.content_hash]));
    expect(notes.find(note => note.scope === `doc:${readmePath}@main`)?.source_hash).toBe(docsByPath.get(readmePath));
    expect(notes.find(note => note.scope === `doc:${architecturePath}@main`)?.source_hash).toBe(docsByPath.get(architecturePath));
    expect(notes.find(note => note.scope === `doc:${adrPath}@main`)?.source_hash).toBe(docsByPath.get(adrPath));
  });

  it('should keep seeded-note upserts idempotent across repeated build/update runs', async () => {
    const readmePath = join(srcDir, 'README.md');
    writeFileSync(readmePath, '# Lore\n\nStable content\n', 'utf8');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();
    await builder.build();
    await builder.update([readmePath]);

    const notes = queryDocScopedNotes(dbPath).filter(
      note => note.key === 'docs/readme' && note.scope === `doc:${readmePath}@main`,
    );
    expect(notes).toHaveLength(1);
  });

  it('should skip seeded-note creation when docs auto-notes are disabled in builder options', async () => {
    const readmePath = join(srcDir, 'README.md');
    writeFileSync(readmePath, '# Lore\n\nNo seeding\n', 'utf8');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, undefined, {
      docsAutoNotes: false,
    });
    await builder.build();
    await builder.update([readmePath]);

    expect(queryDocScopedNotes(dbPath)).toEqual([]);
  });

  it('should keep seeded notes branch-scoped so one branch does not overwrite another', async () => {
    const readmePath = join(srcDir, 'README.md');
    writeFileSync(readmePath, '# Lore\n\nMain branch details\n', 'utf8');

    const mainBuilder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await mainBuilder.build();

    writeFileSync(readmePath, '# Lore\n\nDev branch details\n', 'utf8');
    const devBuilder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'dev' });
    await devBuilder.build();

    const notes = queryDocScopedNotes(dbPath).filter(note => note.key === 'docs/readme');
    const mainNote = notes.find(note => note.scope === `doc:${readmePath}@main`);
    const devNote = notes.find(note => note.scope === `doc:${readmePath}@dev`);

    expect(mainNote).toBeDefined();
    expect(devNote).toBeDefined();
    expect(mainNote?.content).toContain('Main branch details');
    expect(devNote?.content).toContain('Dev branch details');
    expect(mainNote?.source_hash).not.toBe(devNote?.source_hash);
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
    const updatedSource = 'export function updated(): void {}\n';
    writeFileSync(srcFile, updatedSource);
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.update([srcFile]);

    const files = queryFilesWithBranch(dbPath, 'main');
    expect(files.length).toBeGreaterThan(0);
    files.forEach(f => expect(f.branch).toBe('main'));
    expect(queryFileSourceForBranch(dbPath, srcFile, 'main')).toBe(updatedSource);
  });

  it('should not affect files under a different branch on update', async () => {
    // Build under a second branch
    const builder2 = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'dev' });
    await builder2.build();
    const devSourceBeforeMainUpdate = queryFileSourceForBranch(dbPath, srcFile, 'dev');
    expect(devSourceBeforeMainUpdate).toBe(HELLO_SOURCE);

    // Modify and update under 'main' only
    const mainUpdatedSource = 'export function modifiedForMain(): void {}\n';
    writeFileSync(srcFile, mainUpdatedSource);
    const builderMain = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builderMain.update([srcFile]);

    // 'dev' branch files should still be present
    const devFiles = queryFilesWithBranch(dbPath, 'dev');
    expect(devFiles.length).toBeGreaterThan(0);
    expect(queryFileSourceForBranch(dbPath, srcFile, 'main')).toBe(mainUpdatedSource);
    expect(queryFileSourceForBranch(dbPath, srcFile, 'dev')).toBe(devSourceBeforeMainUpdate);
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

  it('should ingest git history during update() when history is enabled', async () => {
    runGit(srcDir, ['init']);
    runGit(srcDir, ['config', 'user.name', 'Test User']);
    runGit(srcDir, ['config', 'user.email', 'test@example.com']);
    runGit(srcDir, ['add', 'hello.ts']);
    runGit(srcDir, ['commit', '-m', 'initial commit']);

    writeFileSync(srcFile, 'export function updatedWithHistory(): void {}\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, undefined, { history: true });
    await builder.update([srcFile]);

    expect(queryCommitCount(dbPath)).toBeGreaterThan(0);
    expect(queryCommitEmbeddingCount(dbPath)).toBe(0);
  });

  it('should respect history options during update() when history is configured as an object', async () => {
    runGit(srcDir, ['init']);
    runGit(srcDir, ['config', 'user.name', 'Test User']);
    runGit(srcDir, ['config', 'user.email', 'test@example.com']);
    runGit(srcDir, ['add', 'hello.ts']);
    runGit(srcDir, ['commit', '-m', 'initial commit']);

    writeFileSync(srcFile, 'export function secondCommit(): void {}\n');
    runGit(srcDir, ['add', 'hello.ts']);
    runGit(srcDir, ['commit', '-m', 'second commit']);

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, undefined, {
      history: { depth: 1, all: false },
    });
    await builder.update([srcFile]);

    expect(queryCommitCount(dbPath)).toBe(1);
  });

  it('should persist commit embeddings during update() when history and an embedder are enabled', async () => {
    runGit(srcDir, ['init']);
    runGit(srcDir, ['config', 'user.name', 'Test User']);
    runGit(srcDir, ['config', 'user.email', 'test@example.com']);
    runGit(srcDir, ['add', 'hello.ts']);
    runGit(srcDir, ['commit', '-m', 'initial commit']);

    writeFileSync(srcFile, 'export function updatedWithHistoryEmbeddings(): void {}\n');
    runGit(srcDir, ['add', 'hello.ts']);
    runGit(srcDir, ['commit', '-m', 'second commit']);

    const embedder: EmbeddingProvider = {
      modelName: 'test-embedder',
      dims: 3,
      async init(): Promise<void> {},
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((_, i) => [i + 1, i + 2, i + 3]);
      },
      async dispose(): Promise<void> {},
    };

    const builder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      embedder,
      { history: true },
    );
    await builder.update([srcFile]);

    expect(queryCommitCount(dbPath)).toBeGreaterThan(0);
    expect(queryCommitEmbeddingCount(dbPath)).toBe(queryCommitCount(dbPath));
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

  it('should persist doc-section embeddings when docs are updated with an embedder', async () => {
    const docsDir = join(srcDir, 'docs');
    const docPath = join(docsDir, 'guide.md');
    mkdirSync(docsDir, { recursive: true });

    const embedder: EmbeddingProvider = {
      modelName: 'test-embedder',
      dims: 3,
      async init(): Promise<void> {},
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((_, i) => [i + 1, i + 2, i + 3]);
      },
      async dispose(): Promise<void> {},
    };

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' }, embedder);

    writeFileSync(docPath, '# Guide\n\n## Intro\nFirst pass\n');
    await builder.update([docPath]);
    expect(queryDocSectionsForPath(dbPath, docPath, 'main').map(section => section.title)).toEqual(['Guide', 'Intro']);
    expect(queryDocSectionEmbeddingCount(dbPath)).toBe(2);
  });

  it('should upsert docs on add/modify and remove docs on delete during update with hash-idempotent behavior', async () => {
    const docsDir = join(srcDir, 'docs');
    const docPath = join(docsDir, 'guide.md');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(docPath, '# Guide\n\n## Intro\nFirst pass\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.update([docPath]);

    const afterInsert = queryDocsForBranch(dbPath, 'main').find(doc => doc.path === docPath);
    expect(afterInsert).toBeDefined();
    const insertedSectionIds = queryDocSectionsForPath(dbPath, docPath, 'main').map(section => section.id);
    expect(insertedSectionIds.length).toBe(2);

    await builder.update([docPath]);
    const afterNoop = queryDocsForBranch(dbPath, 'main').find(doc => doc.path === docPath);
    const noOpSectionIds = queryDocSectionsForPath(dbPath, docPath, 'main').map(section => section.id);
    expect(afterNoop?.content_hash).toBe(afterInsert?.content_hash);
    expect(noOpSectionIds).toEqual(insertedSectionIds);

    writeFileSync(docPath, '# Guide\n\n## Intro\nUpdated\n\n## Advanced\nDeeper details\n');
    await builder.update([docPath]);
    const afterModify = queryDocsForBranch(dbPath, 'main').find(doc => doc.path === docPath);
    expect(afterModify?.content_hash).not.toBe(afterInsert?.content_hash);
    const updatedSections = queryDocSectionsForPath(dbPath, docPath, 'main');
    expect(updatedSections.map(section => section.title)).toEqual(['Guide', 'Intro', 'Advanced']);

    rmSync(docPath, { force: true });
    await builder.update([docPath]);
    expect(queryDocsForBranch(dbPath, 'main').find(doc => doc.path === docPath)).toBeUndefined();
    expect(queryDocSectionsForPath(dbPath, docPath, 'main')).toEqual([]);
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
    expect(mainSymbolIds.length).toBeGreaterThan(0);
    expect(resolvedImportRows.length).toBeGreaterThan(0);
    beforeDb.close();
    const writeDb = new Database(dbPath);
    const insertedSymbolRefId = Number(
      writeDb
        .prepare('INSERT INTO symbol_refs (caller_id, callee_name, call_line) VALUES (?, ?, ?)')
        .run(mainSymbolIds[0]!.id, 'hello', 1).lastInsertRowid,
    );
    writeDb.close();

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
    const staleSymbolRefCountRow = afterDb
      .prepare(
        `SELECT COUNT(*) AS count
         FROM symbol_refs
         WHERE id = ?`,
      )
      .get(insertedSymbolRefId) as { count: number };
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
    expect(staleSymbolRefCountRow.count).toBe(0);
    expect(clearedResolvedCount.count).toBe(resolvedImportRows.length);
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

  it('should persist extracted routes with handler linkage and handler name fallback during update()', async () => {
    const routeFile = join(srcDir, 'routes.js');
    writeFileSync(
      routeFile,
      'function health() { return "ok"; }\napp.get("/health", health);\napp.get("/fallback", makeHandler());\n',
    );

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.update([routeFile]);

    const routes = queryRoutesForFile(dbPath, routeFile, 'main');
    expect(routes).toHaveLength(2);
    expect(routes).toContainEqual({ method: 'GET', path: '/health', handler_id: expect.any(Number), handler_name: 'health' });
    expect(routes).toContainEqual({ method: 'GET', path: '/fallback', handler_id: null, handler_name: 'makeHandler()' });
  });

  it('should replace stale api_routes rows when a file route declaration changes', async () => {
    const routeFile = join(srcDir, 'routes.js');
    writeFileSync(routeFile, 'function health() { return "ok"; }\napp.get("/health", health);\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.update([routeFile]);
    expect(queryRoutesForFile(dbPath, routeFile, 'main').map((row) => row.path)).toEqual(['/health']);

    writeFileSync(routeFile, 'function health() { return "ok"; }\napp.get("/status", health);\n');
    await builder.update([routeFile]);

    const paths = queryRoutesForFile(dbPath, routeFile, 'main').map((row) => row.path);
    expect(paths).toEqual(['/status']);
  });

  it('should remove api_routes rows when a tracked file is deleted', async () => {
    const routeFile = join(srcDir, 'routes.js');
    writeFileSync(routeFile, 'function health() { return "ok"; }\napp.get("/health", health);\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.update([routeFile]);
    expect(queryRoutesForFile(dbPath, routeFile, 'main')).toHaveLength(1);
    expect(existsSync(routeFile)).toBe(true);

    rmSync(routeFile, { force: true });
    await builder.update([routeFile]);

    expect(queryRoutesForFile(dbPath, routeFile, 'main')).toEqual([]);
  });

  it('should refresh test mappings after update resolves changed imports', async () => {
    const sourceFile = join(srcDir, 'math.ts');
    const replacementSourceFile = join(srcDir, 'math2.ts');
    const testDir = join(srcDir, 'tests');
    const testFile = join(testDir, 'math.test.ts');
    mkdirSync(testDir);
    writeFileSync(sourceFile, 'export const sum = (a: number, b: number) => a + b;\n');
    writeFileSync(testFile, 'import { sum } from "../math";\nexport const value = sum(1, 2);\n');

    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();
    expect(queryTestsForSourceFile(dbPath, sourceFile, 'main')).toEqual([
      { test_path: testFile, confidence: 'import' },
    ]);

    writeFileSync(replacementSourceFile, 'export const sum = (a: number, b: number) => a + b;\n');
    writeFileSync(testFile, 'import { sum } from "../math2";\nexport const value = sum(2, 3);\n');
    await builder.update([replacementSourceFile, testFile]);

    expect(queryTestsForSourceFile(dbPath, sourceFile, 'main')).toEqual([]);
    expect(queryTestsForSourceFile(dbPath, replacementSourceFile, 'main')).toEqual([
      { test_path: testFile, confidence: 'import' },
    ]);
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

  it('should resolve symbol_refs.callee_id for known symbol names during build()', async () => {
    writeFileSync(srcFile, 'export function target() { return "ok"; }\nexport function caller() { return target(); }\n');
    const builder = new IndexBuilder(dbPath, { rootDir: srcDir, branch: 'main' });
    await builder.build();

    const db = new Database(dbPath);
    const caller = db
      .prepare(
        `SELECT s.id
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path = ? AND f.branch = ? AND s.name = ?`,
      )
      .get(srcFile, 'main', 'caller') as { id: number } | undefined;
    expect(caller).toBeDefined();
    db.prepare('INSERT INTO symbol_refs (caller_id, callee_name, call_line) VALUES (?, ?, ?)')
      .run(caller!.id, 'target', 1);

    buildCallGraph(db);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM symbol_refs sr
         JOIN symbols s ON s.id = sr.caller_id
         JOIN files f ON f.id = s.file_id
         WHERE f.path = ? AND f.branch = ? AND sr.callee_name = ? AND sr.callee_id IS NOT NULL`,
      )
      .get(srcFile, 'main', 'target') as { count: number };
    db.close();

    expect(row.count).toBeGreaterThan(0);
  });
});
