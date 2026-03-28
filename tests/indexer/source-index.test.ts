import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { openDb } from '../../src/db/schema.js';
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
});
