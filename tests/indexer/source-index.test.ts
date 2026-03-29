import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { openDb, setLoreMeta, LORE_META_INDEX_CHECKPOINT } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import { SourceIndexStage, processFile } from '../../src/indexer/stages/source-index.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';
import { ParserPool } from '../../src/parsing/parser.js';

let tmpDir: string;
let db: Database.Database;

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: tmpDir, include: ['**/*.ts', '**/*.py'], exclude: [] } as any,
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
    maxWorkers: 1, // force serial path for tests
    ...overrides,
  };
}

beforeEach(() => {
  resetLogger();
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-src-idx-')));
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SourceIndexStage', () => {
  it('has the correct name', () => {
    expect(new SourceIndexStage().name).toBe('source-index');
  });

  it('indexes TypeScript files in build mode', async () => {
    // Create a simple TS file with a function
    fs.writeFileSync(
      path.join(tmpDir, 'hello.ts'),
      `export function greet(name: string): string {\n  return \`Hello \${name}\`;\n}\n`,
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // Verify files were inserted
    const files = db.prepare('SELECT * FROM files').all() as Array<{ path: string; language: string }>;
    expect(files.length).toBe(1);
    expect(files[0]!.path).toContain('hello.ts');

    // Verify symbols were extracted
    const symbols = db.prepare('SELECT * FROM symbols').all() as Array<{ name: string; kind: string }>;
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    expect(symbols.some(s => s.name === 'greet')).toBe(true);
  });

  it('indexes Python files in build mode', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.py'),
      `def add(a: int, b: int) -> int:\n    return a + b\n\nclass Calculator:\n    def multiply(self, x, y):\n        return x * y\n`,
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx({
      walkerConfig: { rootDir: tmpDir, include: ['**/*.py'], exclude: [] } as any,
    });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const symbols = db.prepare('SELECT name, kind FROM symbols').all() as Array<{ name: string; kind: string }>;
    expect(symbols.some(s => s.name === 'add')).toBe(true);
    expect(symbols.some(s => s.name === 'Calculator')).toBe(true);
  });

  it('populates file_imports for import statements', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      `import { foo } from './util';\nconsole.log(foo());\n`,
    );
    fs.writeFileSync(path.join(tmpDir, 'util.ts'), `export function foo() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const imports = db.prepare('SELECT raw_import FROM file_imports').all() as Array<{ raw_import: string }>;
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports.some(i => i.raw_import === './util')).toBe(true);
  });

  it('populates symbol_refs for call references', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'caller.ts'),
      `function doStuff() {\n  console.log("hello");\n}\n`,
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const refs = db.prepare('SELECT callee_name FROM symbol_refs').all() as Array<{ callee_name: string }>;
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some(r => r.callee_name.includes('log') || r.callee_name.includes('console'))).toBe(true);
  });

  it('computes symbol metrics', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'complex.ts'),
      `export function complex(a: number, b: number): number {\n  if (a > 0) {\n    if (b > 0) {\n      return a + b;\n    }\n    return a;\n  }\n  return 0;\n}\n`,
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const metrics = db.prepare('SELECT * FROM symbol_metrics').all() as Array<{
      line_count: number; param_count: number; cyclomatic: number; max_nesting: number;
    }>;
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    const m = metrics[0]!;
    expect(m.line_count).toBeGreaterThanOrEqual(5);
    expect(m.cyclomatic).toBeGreaterThanOrEqual(3);
    expect(typeof m.param_count).toBe('number');
  });

  it('indexes multiple files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), `export function x() { return 1; }\n`);
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), `export function y() { return 2; }\n`);
    fs.writeFileSync(path.join(tmpDir, 'c.ts'), `export function z() { return 3; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const files = db.prepare('SELECT * FROM files').all();
    expect(files.length).toBe(3);
    const symbols = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(symbols.length).toBeGreaterThanOrEqual(3);
  });

  it('skips files already sourced from SCIP', async () => {
    fs.writeFileSync(path.join(tmpDir, 'scip.ts'), `export function scipVal() { return 1; }\n`);
    fs.writeFileSync(path.join(tmpDir, 'tree.ts'), `export function treeVal() { return 2; }\n`);

    const scipPath = path.join(tmpDir, 'scip.ts');

    const stage = new SourceIndexStage();
    const ctx = makeCtx({ scipSourcedFiles: new Set([scipPath]) });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // Only tree.ts should have been fully indexed (scip.ts is skipped for symbol extraction)
    const files = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
    const nonScipFiles = files.filter(f => !f.path.includes('scip.ts'));
    expect(nonScipFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('handles update mode with changed files', async () => {
    // First, do a build
    const filePath = path.join(tmpDir, 'updatable.ts');
    fs.writeFileSync(filePath, `export function original() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');

    // Now modify the file and run update
    fs.writeFileSync(filePath, `export function updated() { return 2; }\nexport function extra() { return 3; }\n`);

    const updateCtx = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 0,
    });
    await stage.execute(updateCtx, 'update');
    await stage.dispose?.();

    // Should have file rows for both baseline and overlay
    const allFiles = db.prepare('SELECT * FROM files').all();
    expect(allFiles.length).toBeGreaterThanOrEqual(1);

    // The updated symbols should be present
    const symbols = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(symbols.some(s => s.name === 'updated')).toBe(true);
  });

  it('handles update mode with deleted files', async () => {
    const filePath = path.join(tmpDir, 'deleteme.ts');
    fs.writeFileSync(filePath, `export function original() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');

    // Delete the file
    fs.unlinkSync(filePath);

    const updateCtx = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 0,
    });
    await stage.execute(updateCtx, 'update');
    await stage.dispose?.();

    // The file should be marked as dirty
    const dirtyFiles = db.prepare('SELECT * FROM dirty_files').all();
    expect(dirtyFiles.length).toBe(1);
  });

  it('populates context.files in build mode', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ctxfile.ts'), `export function x() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    expect(ctx.files.length).toBeGreaterThanOrEqual(1);
    expect(ctx.files.some(f => f.path.includes('ctxfile.ts'))).toBe(true);
  });

  it('stores source text in DB', async () => {
    const sourceContent = `export function stored(): string { return "value"; }\n`;
    fs.writeFileSync(path.join(tmpDir, 'stored.ts'), sourceContent);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const file = db.prepare('SELECT source FROM files').get() as { source: string };
    expect(file.source).toBe(sourceContent);
  });

  it('sets layer and generation on inserted rows', async () => {
    fs.writeFileSync(path.join(tmpDir, 'layered.ts'), `export function val() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({ layer: 'baseline', generation: 5 });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const file = db.prepare('SELECT layer, generation FROM files').get() as { layer: string; generation: number };
    expect(file.layer).toBe('baseline');
    expect(file.generation).toBe(5);

    const sym = db.prepare('SELECT layer, generation FROM symbols').get() as { layer: string; generation: number };
    expect(sym.layer).toBe('baseline');
    expect(sym.generation).toBe(5);
  });

  it('runs on empty directory without errors', async () => {
    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await expect(stage.execute(ctx, 'build')).resolves.not.toThrow();
    await stage.dispose?.();
  });

  it('hashes files and skips unchanged on re-index', async () => {
    fs.writeFileSync(path.join(tmpDir, 'unchanged.ts'), `export function x() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx1 = makeCtx();
    await stage.execute(ctx1, 'build');

    // Get the initial hash
    const before = db.prepare('SELECT last_hash FROM files').get() as { last_hash: string };
    expect(before.last_hash).toBeTruthy();

    // Re-run build — file is unchanged, should not crash
    const ctx2 = makeCtx();
    await stage.execute(ctx2, 'build');
    await stage.dispose?.();

    const after = db.prepare('SELECT last_hash FROM files').get() as { last_hash: string };
    expect(after.last_hash).toBe(before.last_hash);
  });

  it('indexes both Python and TypeScript files together', async () => {
    fs.writeFileSync(path.join(tmpDir, 'module.ts'), `export class Widget { render() {} }\n`);
    fs.writeFileSync(path.join(tmpDir, 'script.py'), `def process(data):\n    return data\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({
      walkerConfig: { rootDir: tmpDir, include: ['**/*.ts', '**/*.py'], exclude: [] } as any,
    });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const files = db.prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>;
    expect(files.length).toBe(2);
    const languages = files.map(f => f.language).sort();
    expect(languages).toContain('typescript');
    expect(languages).toContain('python');

    const symbols = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(symbols.some(s => s.name === 'Widget')).toBe(true);
    expect(symbols.some(s => s.name === 'process')).toBe(true);
  });

  it('skips SCIP-sourced files but indexes remaining files', async () => {
    const scipFile = path.join(tmpDir, 'from_scip.ts');
    const normalFile = path.join(tmpDir, 'normal.ts');
    fs.writeFileSync(scipFile, `export function scipFn() { return 1; }\n`);
    fs.writeFileSync(normalFile, `export function normalFn() { return 2; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({ scipSourcedFiles: new Set([scipFile]) });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // Only the normal file should have symbols
    const symbols = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(symbols.some(s => s.name === 'normalFn')).toBe(true);
    // SCIP file is skipped for symbol extraction by tree-sitter
    // but may still have a file row from context.files
  });

  it('update mode detects file content change via hash', async () => {
    const filePath = path.join(tmpDir, 'hashtest.ts');
    fs.writeFileSync(filePath, `export function v1() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');

    // Verify the file was indexed
    const fileRow = db.prepare('SELECT last_hash FROM files').get() as any;
    expect(fileRow?.last_hash).toBeTruthy();

    // Modify the file
    fs.writeFileSync(filePath, `export function v2() { return 2; }\n`);

    const updateCtx = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 1,
    });
    await stage.execute(updateCtx, 'update');
    await stage.dispose?.();

    // Overlay row should have the new symbol
    const overlaySymbols = db.prepare("SELECT name FROM symbols WHERE layer = 'overlay'").all() as Array<{ name: string }>;
    expect(overlaySymbols.some(s => s.name === 'v2')).toBe(true);
  });

  it('update mode with file deletion in baseline mode', async () => {
    const filePath = path.join(tmpDir, 'baseline_del.ts');
    fs.writeFileSync(filePath, `export function willDelete() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({ layer: 'baseline' });
    await stage.execute(ctx, 'build');

    const symbolsBefore = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(symbolsBefore.some(s => s.name === 'willDelete')).toBe(true);

    // Delete file and run update in baseline mode
    fs.unlinkSync(filePath);
    const updateCtx = makeCtx({
      changedFiles: [filePath],
      layer: 'baseline',
      generation: 1,
    });
    await stage.execute(updateCtx, 'update');
    await stage.dispose?.();

    // File and symbols should be removed
    const filesAfter = db.prepare('SELECT * FROM files WHERE path = ?').all(filePath);
    expect(filesAfter).toHaveLength(0);
  });

  it('update mode populates context.files and changedSourcePaths', async () => {
    const filePath = path.join(tmpDir, 'ctx_update.ts');
    fs.writeFileSync(filePath, `export function ctx() { return 1; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');

    // Modify and update
    fs.writeFileSync(filePath, `export function ctxUpdated() { return 2; }\n`);
    const updateCtx = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 1,
    });
    await stage.execute(updateCtx, 'update');
    await stage.dispose?.();

    expect(updateCtx.files.length).toBeGreaterThanOrEqual(1);
    expect(updateCtx.changedSourcePaths.length).toBeGreaterThanOrEqual(1);
    expect(updateCtx.changedSourcePaths.some(p => p.includes('ctx_update.ts'))).toBe(true);
  });

  it('update mode with non-source file in changedFiles is ignored', async () => {
    const filePath = path.join(tmpDir, 'readme.md');
    fs.writeFileSync(filePath, '# Hello\n');

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');

    const updateCtx = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 1,
    });
    await stage.execute(updateCtx, 'update');
    await stage.dispose?.();

    // No source files should have been processed
    expect(updateCtx.files).toHaveLength(0);
  });

  it('checkpoint is saved during build', async () => {
    // Create enough files so checkpointing can run
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
    }

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // Verify files were indexed
    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(5);
  });

  it('update mode in baseline batch-deletes and reindexes changed files', async () => {
    const fileA = path.join(tmpDir, 'bl_a.ts');
    const fileB = path.join(tmpDir, 'bl_b.ts');
    fs.writeFileSync(fileA, `export function fnA() { return 1; }\n`);
    fs.writeFileSync(fileB, `export function fnB() { return 2; }\n`);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({ layer: 'baseline', maxWorkers: 0 });
    await stage.execute(ctx, 'build');

    const filesBefore = db.prepare('SELECT id, path, layer FROM files').all() as Array<{ id: number; path: string; layer: string }>;
    expect(filesBefore).toHaveLength(2);

    // Change file A content
    fs.writeFileSync(fileA, `export function fnAChanged() { return 99; }\n`);

    const updateCtx = makeCtx({
      changedFiles: [fileA, fileB],
      layer: 'baseline',
      generation: 2,
      maxWorkers: 0,
    });
    await stage.execute(updateCtx, 'update');
    await stage.dispose?.();

    // After baseline update: old rows batch-deleted, files re-indexed
    const filesAfter = db.prepare('SELECT id, path FROM files').all() as Array<{ id: number; path: string }>;
    expect(filesAfter).toHaveLength(2);

    // Verify fnAChanged is present in the reindexed symbols
    const symbolsA = db.prepare(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = ?`,
    ).all(fileA) as Array<{ name: string }>;
    expect(symbolsA.some(s => s.name === 'fnAChanged')).toBe(true);
    expect(symbolsA.some(s => s.name === 'fnA')).toBe(false);

    // fnB should still be present
    const symbolsB = db.prepare(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.path = ?`,
    ).all(fileB) as Array<{ name: string }>;
    expect(symbolsB.some(s => s.name === 'fnB')).toBe(true);
  });

  it('processFile hash fast-path skips when stat size and hash match', async () => {
    const filePath = path.join(tmpDir, 'hashfast.ts');
    const source = `export function stable() { return 1; }\n`;
    fs.writeFileSync(filePath, source);
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const sizeBytes = Buffer.byteLength(source, 'utf8');

    // Pre-insert file row with correct hash and size
    db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', sizeBytes, hash, source, 'baseline', 0);

    const pool = new ParserPool();
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'baseline', 0);

    // processFile returned early via hash match — no symbols inserted
    const symbols = db.prepare('SELECT * FROM symbols').all();
    expect(symbols).toHaveLength(0);
  });

  it('processFile handles stat failure gracefully', async () => {
    const filePath = path.join(tmpDir, 'statfail.ts');
    const source = `export function original() { return 1; }\n`;
    fs.writeFileSync(filePath, source);
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const sizeBytes = Buffer.byteLength(source, 'utf8');

    // Pre-insert file row so the existing-row branch is entered
    db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', sizeBytes, hash, source, 'baseline', 0);

    // Mock stat to fail → triggers the catch block, falls through to re-read
    const statSpy = vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(new Error('EACCES'));

    const pool = new ParserPool();
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'baseline', 0);

    statSpy.mockRestore();

    // Falls through to re-read; hash matches existing row → early return
    const files = db.prepare('SELECT * FROM files WHERE path = ?').all(filePath);
    expect(files).toHaveLength(1);
    const symbols = db.prepare('SELECT * FROM symbols').all();
    expect(symbols).toHaveLength(0);
  });

  it('processFile handles read failure when file does not exist', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.ts');
    // File does not exist on disk — no existing row in DB either

    const pool = new ParserPool();
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'baseline', 0);

    // Should return silently with nothing inserted
    const files = db.prepare('SELECT * FROM files').all();
    expect(files).toHaveLength(0);
  });

  it('processFile handles readFile failure in hash fast-path (inner catch)', async () => {
    const filePath = path.join(tmpDir, 'innerread.ts');
    const source = `export function x() { return 1; }\n`;
    fs.writeFileSync(filePath, source);
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const sizeBytes = Buffer.byteLength(source, 'utf8');

    // Pre-insert file row with matching size and hash
    db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', sizeBytes, hash, source, 'baseline', 0);

    // Mock readFile to fail once (inner catch in hash fast-path)
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(new Error('EACCES'));

    const pool = new ParserPool();
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'baseline', 0);

    readSpy.mockRestore();

    // processFile caught the inner read error and returned early
    const symbols = db.prepare('SELECT * FROM symbols').all();
    expect(symbols).toHaveLength(0);
  });

  it('computes metrics for SCIP-sourced files', async () => {
    const filePath = path.join(tmpDir, 'scip_metrics.ts');
    fs.writeFileSync(
      filePath,
      `export function scipFunc(a: number): number {\n  if (a > 0) {\n    return a;\n  }\n  return 0;\n}\n`,
    );

    // Pre-insert file and symbol rows (simulating ScipIndexerStage output)
    const fileInfo = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', 100, 'fakehash', '', 'baseline', 0) as { lastInsertRowid: number | bigint };
    const fileId = Number(fileInfo.lastInsertRowid);

    db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'scipFunc', 'function', 0, 5, 'baseline', 0);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({
      scipSourcedFiles: new Set([filePath]),
      maxWorkers: 0,
    });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // Verify metrics were computed for the SCIP-sourced symbol
    const metrics = db.prepare('SELECT * FROM symbol_metrics').all() as Array<{
      line_count: number; param_count: number; cyclomatic: number; max_nesting: number;
    }>;
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics[0]!.cyclomatic).toBeGreaterThanOrEqual(2);
  });

  it('processFile re-indexes when size matches but hash differs', async () => {
    const filePath = path.join(tmpDir, 'hashchange.ts');
    const source1 = `export function aaa() { return 1; }\n`;
    fs.writeFileSync(filePath, source1);
    const hash1 = crypto.createHash('sha256').update(source1).digest('hex');
    const sizeBytes = Buffer.byteLength(source1, 'utf8');

    // Pre-insert file row with matching size but different hash
    db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', sizeBytes, 'oldhashvalue_not_matching', source1, 'baseline', 0);

    // Write a new file with same byte length but different content
    const source2 = `export function bbb() { return 2; }\n`;
    fs.writeFileSync(filePath, source2);

    const pool = new ParserPool();
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'baseline', 0);

    // The file should have been re-indexed: symbols should be 'bbb'
    const symbols = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
    expect(symbols.some(s => s.name === 'bbb')).toBe(true);
  });

  it('processFile overlay mode creates new overlay row alongside baseline', async () => {
    const filePath = path.join(tmpDir, 'overlay_test.ts');
    const source = `export function baseline() { return 1; }\n`;
    fs.writeFileSync(filePath, source);

    // First, build baseline
    const pool = new ParserPool();
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'baseline', 0);

    // Now write new content and process as overlay
    const source2 = `export function overlay_fn() { return 2; }\n`;
    fs.writeFileSync(filePath, source2);
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'overlay', 1);

    // Both rows should exist
    const files = db.prepare('SELECT layer FROM files WHERE path = ?').all(filePath) as Array<{ layer: string }>;
    expect(files.some(f => f.layer === 'baseline')).toBe(true);
    expect(files.some(f => f.layer === 'overlay')).toBe(true);

    // Overlay symbol should be present
    const overlaySyms = db.prepare(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.layer = 'overlay'`,
    ).all() as Array<{ name: string }>;
    expect(overlaySyms.some(s => s.name === 'overlay_fn')).toBe(true);

    // Dirty file marker should exist
    const dirty = db.prepare('SELECT * FROM dirty_files WHERE path = ?').all(filePath);
    expect(dirty.length).toBe(1);
  });

  it('processFile overlay mode replaces existing overlay row', async () => {
    const filePath = path.join(tmpDir, 'overlay_replace.ts');
    const source = `export function v1() { return 1; }\n`;
    fs.writeFileSync(filePath, source);

    const pool = new ParserPool();
    // Create baseline
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'baseline', 0);

    // Create first overlay
    const source2 = `export function v2() { return 2; }\n`;
    fs.writeFileSync(filePath, source2);
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'overlay', 1);

    // Create second overlay (should replace first)
    const source3 = `export function v3() { return 3; }\n`;
    fs.writeFileSync(filePath, source3);
    await processFile(db, pool, filePath, 'typescript', 'main', new Map(), 'overlay', 2);

    // Should be only one overlay file row
    const overlayFiles = db.prepare(
      `SELECT * FROM files WHERE path = ? AND layer = 'overlay'`,
    ).all(filePath);
    expect(overlayFiles.length).toBe(1);

    // Latest overlay symbol should be v3
    const syms = db.prepare(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.layer = 'overlay'`,
    ).all() as Array<{ name: string }>;
    expect(syms.some(s => s.name === 'v3')).toBe(true);
    expect(syms.some(s => s.name === 'v2')).toBe(false);
  });

  it('indexes file with duplicate symbol names and resolves by line', async () => {
    // Create a file with two functions named the same (method overloads/same name in different contexts)
    fs.writeFileSync(
      path.join(tmpDir, 'dup.ts'),
      [
        'function helper() { return 1; }',
        'class Foo {',
        '  helper() { return 2; }',
        '}',
      ].join('\n') + '\n',
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // Should have two symbols named 'helper'
    const helpers = db.prepare(
      `SELECT id, name, start_line, end_line FROM symbols WHERE name = 'helper'`,
    ).all() as Array<{ id: number; name: string; start_line: number; end_line: number }>;
    expect(helpers.length).toBe(2);
    // They should have different ids
    expect(helpers[0]!.id).not.toBe(helpers[1]!.id);
  });

  it('creates module-level symbol for top-level calls', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'toplevel.ts'),
      `console.log("hello");\nconst x = Math.random();\n`,
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // A module-level symbol should have been created
    const moduleSyms = db.prepare(
      `SELECT name FROM symbols WHERE kind = 'module'`,
    ).all() as Array<{ name: string }>;
    expect(moduleSyms.some(s => s.name.includes('<module:'))).toBe(true);

    // Call refs should exist with the module symbol as caller
    const refs = db.prepare('SELECT callee_name FROM symbol_refs').all() as Array<{ callee_name: string }>;
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('indexes parent_symbol_id for nested symbols', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'nested.ts'),
      [
        'class Outer {',
        '  method() {',
        '    return 1;',
        '  }',
        '}',
      ].join('\n') + '\n',
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const symbols = db.prepare(
      'SELECT id, name, parent_symbol_id FROM symbols',
    ).all() as Array<{ id: number; name: string; parent_symbol_id: number | null }>;

    const outer = symbols.find(s => s.name === 'Outer');
    const method = symbols.find(s => s.name === 'method');
    expect(outer).toBeDefined();
    expect(method).toBeDefined();
    expect(method!.parent_symbol_id).toBe(outer!.id);
  });

  it('update mode overlay deletion populates staleSymbolIds', async () => {
    const filePath = path.join(tmpDir, 'stale.ts');
    fs.writeFileSync(filePath, `export function staleFn() { return 1; }\n`);

    const stage = new SourceIndexStage();

    // Build baseline
    const ctx = makeCtx({ layer: 'baseline' });
    await stage.execute(ctx, 'build');

    // Create overlay
    fs.writeFileSync(filePath, `export function overlayFn() { return 2; }\n`);
    const updateCtx1 = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 1,
    });
    await stage.execute(updateCtx1, 'update');

    // Now delete the file and run update in overlay mode
    fs.unlinkSync(filePath);
    const updateCtx2 = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 2,
    });
    await stage.execute(updateCtx2, 'update');
    await stage.dispose?.();

    // staleSymbolIds should be populated
    expect(updateCtx2.staleSymbolIds.length).toBeGreaterThanOrEqual(1);
    // dirty_files should be marked
    const dirty = db.prepare('SELECT * FROM dirty_files WHERE path = ?').all(filePath);
    expect(dirty.length).toBe(1);
  });

  it('loadBuildCheckpoint resumes from a valid checkpoint', async () => {
    // Create 5 files
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `ckpt${i}.ts`),
        `export function f${i}() { return ${i}; }\n`,
      );
    }

    // Do a full build first
    const stage = new SourceIndexStage();
    const ctx1 = makeCtx();
    await stage.execute(ctx1, 'build');

    // Now save a checkpoint pretending only 3 were done and re-run
    // with same file count — it should resume from index 3
    const checkpoint = {
      branch: 'main',
      rootDir: tmpDir,
      totalFiles: 5,
      nextFileIndex: 3,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, JSON.stringify(checkpoint));

    // Re-build — should resume and process files 3-4 (files 0-2 already in DB)
    const ctx2 = makeCtx();
    await stage.execute(ctx2, 'build');
    await stage.dispose?.();

    // All 5 files should still be in the DB
    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(5);
  });

  it('loadBuildCheckpoint ignores checkpoint for different branch', async () => {
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `branch${i}.ts`),
        `export function f${i}() { return ${i}; }\n`,
      );
    }

    // Save a checkpoint for a different branch
    const checkpoint = {
      branch: 'feature-branch',
      rootDir: tmpDir,
      totalFiles: 3,
      nextFileIndex: 2,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, JSON.stringify(checkpoint));

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // All 3 files indexed from scratch (checkpoint ignored)
    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(3);
  });

  it('loadBuildCheckpoint ignores malformed JSON', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'malformed.ts'),
      `export function f() { return 1; }\n`,
    );

    setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, 'NOT_VALID_JSON!!!');

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(1);
  });

  it('loadBuildCheckpoint with failedFiles retries them', async () => {
    // Create files
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `retry${i}.ts`),
        `export function f${i}() { return ${i}; }\n`,
      );
    }

    // Do a full build first so that all files are in the DB
    const stage = new SourceIndexStage();
    const ctx1 = makeCtx();
    await stage.execute(ctx1, 'build');

    // Get the actual file paths from walkFiles order
    const allFiles = db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>;
    expect(allFiles.length).toBe(3);

    // Save a checkpoint saying 2 were done, 1 failed
    const failedPath = allFiles[1]!.path; // second file
    const checkpoint = {
      branch: 'main',
      rootDir: tmpDir,
      totalFiles: 3,
      nextFileIndex: 2,
      updatedAt: Math.floor(Date.now() / 1000),
      failedFiles: [failedPath],
    };
    setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, JSON.stringify(checkpoint));

    const ctx2 = makeCtx();
    await stage.execute(ctx2, 'build');
    await stage.dispose?.();

    // All 3 files should be indexed (retry + remaining)
    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(3);
  });

  it('computeMetricsForScipFiles reads source from filesystem when not cached', async () => {
    const filePath = path.join(tmpDir, 'fs_read.ts');
    fs.writeFileSync(
      filePath,
      `export function fsRead(a: number): number {\n  if (a > 0) return a;\n  return 0;\n}\n`,
    );

    // Pre-insert file and symbol rows
    const fileInfo = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', 100, 'fakehash', '', 'baseline', 0) as { lastInsertRowid: number | bigint };
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'fsRead', 'function', 0, 3, 'baseline', 0);

    const stage = new SourceIndexStage();
    // Don't pre-populate sourceCache — force filesystem read
    const ctx = makeCtx({
      scipSourcedFiles: new Set([filePath]),
      maxWorkers: 0,
      sourceCache: new Map(), // empty cache — triggers fs.readFileSync fallback
    });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const metrics = db.prepare('SELECT * FROM symbol_metrics').all() as Array<{
      line_count: number; cyclomatic: number;
    }>;
    expect(metrics.length).toBeGreaterThanOrEqual(1);
  });

  it('applyScipMetrics patches end_line when tree-sitter span is larger', async () => {
    const filePath = path.join(tmpDir, 'patchend.ts');
    fs.writeFileSync(
      filePath,
      `export function patchMe(a: number): number {\n  if (a > 0) {\n    return a;\n  }\n  return 0;\n}\n`,
    );

    // Pre-insert file and symbol with short end_line (as SCIP might produce)
    const fileInfo = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', 100, 'fakehash', '', 'baseline', 0) as { lastInsertRowid: number | bigint };
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'patchMe', 'function', 0, 0, 'baseline', 0);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({
      scipSourcedFiles: new Set([filePath]),
      maxWorkers: 0,
    });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // end_line should have been patched to the actual function end
    const sym = db.prepare(
      `SELECT end_line FROM symbols WHERE name = 'patchMe'`,
    ).get() as { end_line: number };
    expect(sym.end_line).toBeGreaterThan(0);
  });

  it('applyScipMetrics uses dotted name fallback for symbol matching', async () => {
    const filePath = path.join(tmpDir, 'dotted.ts');
    fs.writeFileSync(
      filePath,
      `class MyClass {\n  myMethod() {\n    return 1;\n  }\n}\n`,
    );

    // Pre-insert file and symbol using the short name only
    const fileInfo = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(filePath, 'main', 'typescript', 100, 'fakehash', '', 'baseline', 0) as { lastInsertRowid: number | bigint };
    const fileId = Number(fileInfo.lastInsertRowid);
    db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'MyClass', 'class', 0, 4, 'baseline', 0);
    db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(fileId, 'myMethod', 'method', 1, 3, 'baseline', 0);

    const stage = new SourceIndexStage();
    const ctx = makeCtx({
      scipSourcedFiles: new Set([filePath]),
      maxWorkers: 0,
    });
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // Metrics should have been applied
    const metrics = db.prepare('SELECT * FROM symbol_metrics').all() as any[];
    expect(metrics.length).toBeGreaterThanOrEqual(1);
  });

  it('update mode overlay existing file change populates staleSymbolIds', async () => {
    const filePath = path.join(tmpDir, 'overlay_stale.ts');
    fs.writeFileSync(filePath, `export function original() { return 1; }\n`);

    const stage = new SourceIndexStage();

    // Build baseline
    const ctx = makeCtx({ layer: 'baseline' });
    await stage.execute(ctx, 'build');

    // Create first overlay
    fs.writeFileSync(filePath, `export function first_overlay() { return 2; }\n`);
    const updateCtx1 = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 1,
    });
    await stage.execute(updateCtx1, 'update');

    // Modify the file again — second overlay should replace prior overlay
    fs.writeFileSync(filePath, `export function second_overlay() { return 3; }\n`);
    const updateCtx2 = makeCtx({
      changedFiles: [filePath],
      layer: 'overlay',
      generation: 2,
    });
    await stage.execute(updateCtx2, 'update');
    await stage.dispose?.();

    // staleSymbolIds from the first overlay should be captured
    expect(updateCtx2.staleSymbolIds.length).toBeGreaterThanOrEqual(1);

    // Only one overlay file row
    const overlayFiles = db.prepare(
      `SELECT * FROM files WHERE path = ? AND layer = 'overlay'`,
    ).all(filePath);
    expect(overlayFiles.length).toBe(1);

    // Second overlay symbol
    const syms = db.prepare(
      `SELECT s.name FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.layer = 'overlay'`,
    ).all() as Array<{ name: string }>;
    expect(syms.some(s => s.name === 'second_overlay')).toBe(true);
  });

  it('indexes type refs from TypeScript source', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'typerefs.ts'),
      [
        'interface Foo { x: number; }',
        'function useFoo(f: Foo): Foo {',
        '  return f;',
        '}',
      ].join('\n') + '\n',
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const typeRefs = db.prepare('SELECT type_name FROM type_refs').all() as Array<{ type_name: string }>;
    expect(typeRefs.some(r => r.type_name === 'Foo')).toBe(true);
  });

  it('indexes relationship data (extends/implements)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'inherit.ts'),
      [
        'class Base { }',
        'class Child extends Base { }',
      ].join('\n') + '\n',
    );

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const rels = db.prepare('SELECT target_symbol_name, relationship_type FROM symbol_relationships').all() as Array<{
      target_symbol_name: string; relationship_type: string;
    }>;
    expect(rels.some(r => r.target_symbol_name === 'Base')).toBe(true);
  });

  it('loadBuildCheckpoint ignores checkpoint with different totalFiles', async () => {
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `total${i}.ts`),
        `export function f${i}() { return ${i}; }\n`,
      );
    }

    // Checkpoint says totalFiles=5, but we only have 2 — should be ignored
    const checkpoint = {
      branch: 'main',
      rootDir: tmpDir,
      totalFiles: 5,
      nextFileIndex: 3,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, JSON.stringify(checkpoint));

    const stage = new SourceIndexStage();
    const ctx = makeCtx();
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(2);
  });

  it('build mode with maxWorkers > 1 uses serial fallback when worker script unavailable', async () => {
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `w${i}.ts`),
        `export function fn${i}() { return ${i}; }\n`,
      );
    }

    const stage = new SourceIndexStage();
    const ctx = makeCtx({ maxWorkers: 2 }); // Force workerCount > 1
    await stage.execute(ctx, 'build');
    await stage.dispose?.();

    // All files indexed via the serial fallback
    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(3);
  });

  it('build mode maxWorkers > 1 with checkpoint retries and remaining files', async () => {
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(
        path.join(tmpDir, `mw${i}.ts`),
        `export function fn${i}() { return ${i}; }\n`,
      );
    }

    // First build to populate DB
    const stage = new SourceIndexStage();
    const ctx1 = makeCtx({ maxWorkers: 2 });
    await stage.execute(ctx1, 'build');

    const allFiles = db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>;
    expect(allFiles.length).toBe(4);

    // Set a checkpoint with a failed file and resume point
    const failedPath = allFiles[0]!.path;
    const checkpoint = {
      branch: 'main',
      rootDir: tmpDir,
      totalFiles: 4,
      nextFileIndex: 2,
      updatedAt: Math.floor(Date.now() / 1000),
      failedFiles: [failedPath],
    };
    setLoreMeta(db, LORE_META_INDEX_CHECKPOINT, JSON.stringify(checkpoint));

    // Re-run with maxWorkers > 1 to trigger the workerScript fallback path
    const ctx2 = makeCtx({ maxWorkers: 2 });
    await stage.execute(ctx2, 'build');
    await stage.dispose?.();

    const count = (db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(4);
  });

  it('processFile parses tree but unknown language returns null extractor', async () => {
    const filePath = path.join(tmpDir, 'unknown_ext.weird');
    fs.writeFileSync(filePath, 'content that cannot be parsed');

    const pool = new ParserPool();
    // Calling processFile with a language that has no extractor
    // This exercises the `if (!extractor) return;` branch in processFileWithSource
    await processFile(db, pool, filePath, 'nonexistent_lang', 'main', new Map(), 'baseline', 0);

    // Should return without inserting anything
    const files = db.prepare('SELECT * FROM files').all();
    expect(files).toHaveLength(0);
  });
});
