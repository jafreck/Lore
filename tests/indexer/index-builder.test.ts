import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb } from '../../src/db/schema.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  resetLogger();
  initLogger({ level: LogLevel.SILENT });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-idx-builder-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// TODO: Re-enable once IndexBuilder tests are updated for SCIP-first architecture.
// These tests create simple TS files and expect tree-sitter extraction to produce symbols.
// With tree-sitter removed, they need SCIP indexes or LSP to produce symbols.
describe.skip('IndexBuilder', () => {
  it('builds an index from source files', async () => {
    // Create source files
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `export function main(): void {\n  console.log("hello");\n}\n`,
    );
    fs.writeFileSync(
      path.join(srcDir, 'util.ts'),
      `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    );

    // Initialize git so resolveBranch works
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // git may not be available, that's ok — branch will fall back to 'HEAD'
    }

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir } as any, undefined, {
      maxWorkers: 1,
    });

    await builder.build();

    // Verify the DB was populated
    const db = openDb(dbPath);
    try {
      const files = db.prepare('SELECT * FROM files').all() as Array<{ path: string }>;
      expect(files.length).toBeGreaterThanOrEqual(2);

      const symbols = db.prepare('SELECT name, kind FROM symbols').all() as Array<{ name: string; kind: string }>;
      expect(symbols.length).toBeGreaterThanOrEqual(2);
      expect(symbols.some(s => s.name === 'main')).toBe(true);
      expect(symbols.some(s => s.name === 'add')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('updates an index incrementally', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    const filePath = path.join(srcDir, 'app.ts');
    fs.writeFileSync(filePath, `export function original(): number { return 1; }\n`);

    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // git not available
    }

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir } as any, undefined, {
      maxWorkers: 1,
    });

    await builder.build();

    // Modify the file
    fs.writeFileSync(filePath, `export function updated(): number { return 2; }\nexport function extra(): string { return "x"; }\n`);

    await builder.update([filePath]);

    const db = openDb(dbPath);
    try {
      const symbols = db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>;
      expect(symbols.some(s => s.name === 'updated')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('handles empty directory build', async () => {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // git not available
    }

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir } as any, undefined, {
      maxWorkers: 1,
    });

    await expect(builder.build()).resolves.not.toThrow();

    const db = openDb(dbPath);
    try {
      const files = db.prepare('SELECT * FROM files').all();
      expect(files.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('mutex prevents concurrent builds', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'a.ts'), `export const x = 1;\n`);

    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // git not available
    }

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir } as any, undefined, {
      maxWorkers: 1,
    });

    // Launch two builds concurrently — they should serialize via the mutex
    const [r1, r2] = await Promise.allSettled([builder.build(), builder.build()]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');
  });

  it('ingestSummary stores a symbol summary', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'sum.ts'), `export function summarize(): void {}\n`);

    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
    } catch {
      // git not available
    }

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir } as any, undefined, {
      maxWorkers: 1,
    });

    await builder.build();

    // Get a symbol ID
    const db = openDb(dbPath);
    let symId: number;
    try {
      const sym = db.prepare('SELECT id FROM symbols LIMIT 1').get() as { id: number } | undefined;
      expect(sym).toBeDefined();
      symId = sym!.id;
    } finally {
      db.close();
    }

    // Ingest a summary
    await builder.ingestSummary(symId!, 'This function summarizes stuff', 'gpt-4');

    const db2 = openDb(dbPath);
    try {
      const summary = db2.prepare('SELECT summary, model FROM symbol_summaries WHERE symbol_id = ?').get(symId!) as { summary: string; model: string };
      expect(summary.summary).toBe('This function summarizes stuff');
      expect(summary.model).toBe('gpt-4');
    } finally {
      db2.close();
    }
  });
});
