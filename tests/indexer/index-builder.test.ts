import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/schema.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import type { EmbeddingProvider } from '../../src/embeddings/embedder.js';
import { IndexValidationError } from '../../src/validation/index-health.js';
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

describe('IndexBuilder', () => {
  it('builds a baseline of source snapshots without pretending fallback symbols exist', async () => {
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

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir }, undefined, {
      lsp: false,
      scip: false,
      validation: false,
    });

    await builder.build();

    // Verify the DB was populated
    const db = openDb(dbPath);
    try {
      const files = db.prepare('SELECT * FROM files').all() as Array<{ path: string }>;
      expect(files.length).toBeGreaterThanOrEqual(2);

      expect(db.prepare('SELECT COUNT(*) AS count FROM symbols').get()).toEqual({ count: 0 });
      expect(db.prepare(
        "SELECT layer, generation FROM effective_files WHERE path LIKE '%/src/main.ts'",
      ).get()).toMatchObject({ layer: 'baseline', generation: 1 });
      expect(db.prepare(
        'SELECT status, fallback_degraded FROM index_runs ORDER BY started_at DESC, rowid DESC LIMIT 1',
      ).get()).toEqual({ status: 'degraded', fallback_degraded: 1 });
    } finally {
      db.close();
    }
  });

  it('updates an effective source snapshot incrementally', async () => {
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

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir }, undefined, {
      lsp: false,
      scip: false,
      validation: false,
    });

    await builder.build();

    // Modify the file
    fs.writeFileSync(filePath, `export function updated(): number { return 2; }\nexport function extra(): string { return "x"; }\n`);

    await builder.update([filePath]);

    const db = openDb(dbPath);
    try {
      const effective = db.prepare(
        'SELECT source, layer FROM effective_files WHERE path = ?',
      ).get(fs.realpathSync(filePath)) as { source: string; layer: string } | undefined;
      expect(effective).toEqual({
        source: 'export function updated(): number { return 2; }\nexport function extra(): string { return "x"; }\n',
        layer: 'overlay',
      });
      expect(db.prepare('SELECT overlay_gen FROM dirty_files WHERE path = ?').get(fs.realpathSync(filePath)))
        .toEqual({ overlay_gen: 0 });
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

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir }, undefined, {
      lsp: false,
      scip: false,
      validation: false,
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

  it('establishes a promoted baseline when only historical run provenance exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'first.ts'), 'export const first = 1;\n');
    const db = openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO index_runs
           (id, mode, root_dir, branch, layer, generation, status, completed_at)
         VALUES ('orphan-run', 'build', ?, 'main', 'baseline', 7, 'succeeded', unixepoch())`,
      ).run(tmpDir);
    } finally {
      db.close();
    }

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir, branch: 'main' }, undefined, {
      lsp: false,
      scip: false,
      validation: false,
    });
    await builder.refresh();

    const inspected = openDb(dbPath);
    try {
      expect(inspected.prepare(
        "SELECT generation FROM baseline_generations WHERE branch = 'main'",
      ).get()).toEqual({ generation: 8 });
      expect(inspected.prepare(
        "SELECT layer FROM effective_files WHERE branch = 'main' AND path LIKE '%/first.ts'",
      ).get()).toEqual({ layer: 'baseline' });
    } finally {
      inspected.close();
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

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir }, undefined, {
      lsp: false,
      scip: false,
      validation: false,
    });

    // Launch two builds concurrently — they should serialize via the mutex
    const [r1, r2] = await Promise.allSettled([builder.build(), builder.build()]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('fulfilled');
    const db = openDb(dbPath);
    try {
      expect(db.prepare(
        "SELECT COUNT(DISTINCT generation) AS count FROM files WHERE layer = 'baseline'",
      ).get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM baseline_generations').get())
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('keeps a candidate baseline hidden without holding a write transaction during embedding', async () => {
    const fixtureRoot = path.resolve('tests/fixtures/scip-projects/typescript');
    const walker = { rootDir: fixtureRoot, branch: 'atomic-test' };
    const options = {
      lsp: false,
      scip: { enabled: true, indexDir: '../scip-indexes' },
      validation: false as const,
    };
    await new IndexBuilder(dbPath, walker, undefined, options).build();

    let signalStarted!: () => void;
    let releaseEmbedding!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
    const embedder: EmbeddingProvider = {
      modelName: 'blocking-test-model',
      dims: 4,
      async init() {},
      async dispose() {},
      async embed(texts) {
        signalStarted();
        await gate;
        return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
      },
    };

    const rebuilding = new IndexBuilder(dbPath, walker, embedder, options).baselineRebuild();
    await started;

    const observer = new Database(dbPath);
    try {
      observer.pragma('busy_timeout = 100');
      expect(observer.prepare(
        "SELECT generation FROM baseline_generations WHERE branch = 'atomic-test'",
      ).get()).toEqual({ generation: 1 });
      const staged = observer.prepare(
        "SELECT COUNT(*) AS count FROM files WHERE branch = 'atomic-test' AND generation = 2",
      ).get() as { count: number };
      expect(staged.count).toBeGreaterThan(0);
      // A direct independent writer succeeds while the model/subprocess phase
      // is awaiting, proving there is no run-long BEGIN IMMEDIATE transaction.
      expect(() => observer.prepare(
        "INSERT OR REPLACE INTO lore_meta (key, value) VALUES ('concurrent_probe', 'ok')",
      ).run()).not.toThrow();
    } finally {
      observer.close();
    }

    releaseEmbedding();
    await rebuilding;
    const promoted = openDb(dbPath);
    try {
      expect(promoted.prepare(
        "SELECT generation FROM baseline_generations WHERE branch = 'atomic-test'",
      ).get()).toEqual({ generation: 2 });
    } finally {
      promoted.close();
    }
  });

  it('preserves the prior baseline and failed provider provenance when validation rejects a candidate', async () => {
    const filePath = path.join(tmpDir, 'app.ts');
    fs.writeFileSync(filePath, 'export const current = 2;\n');
    const canonicalPath = fs.realpathSync(filePath);
    const seeded = openDb(dbPath);
    try {
      seeded.prepare(
        `INSERT INTO files (path, branch, language, source, layer, generation)
         VALUES (?, 'main', 'typescript', 'export const prior = 1;\n', 'baseline', 1)`,
      ).run(canonicalPath);
      seeded.prepare(
        "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
      ).run();
    } finally {
      seeded.close();
    }

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir, branch: 'main' }, undefined, {
      lsp: false,
      scip: false,
      validation: 'strict',
    });
    await expect(builder.build()).rejects.toBeInstanceOf(IndexValidationError);

    const inspected = openDb(dbPath);
    try {
      expect(inspected.prepare(
        "SELECT source, generation FROM effective_files WHERE branch = 'main' AND path = ?",
      ).get(canonicalPath)).toEqual({ source: 'export const prior = 1;\n', generation: 1 });
      expect(inspected.prepare(
        "SELECT COUNT(*) AS count FROM files WHERE branch = 'main' AND generation = 2",
      ).get()).toEqual({ count: 0 });
      const failedRun = inspected.prepare(
        "SELECT id, status FROM index_runs WHERE branch = 'main' ORDER BY rowid DESC LIMIT 1",
      ).get() as { id: string; status: string };
      expect(failedRun.status).toBe('failed');
      expect(inspected.prepare(
        "SELECT COUNT(*) AS count FROM indexer_runs WHERE run_id = ? AND provider = 'discovery'",
      ).get(failedRun.id)).toEqual({ count: 1 });
    } finally {
      inspected.close();
    }
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

    const builder = new IndexBuilder(dbPath, { rootDir: tmpDir }, undefined, {
      lsp: false,
      scip: false,
      validation: false,
    });

    await builder.build();

    // Insert a first-party symbol row; source-only fallback intentionally does
    // not manufacture symbols in the SCIP/LSP architecture.
    const db = openDb(dbPath);
    let symId: number;
    try {
      const file = db.prepare('SELECT id FROM effective_files WHERE path = ?').get(
        fs.realpathSync(path.join(srcDir, 'sum.ts')),
      ) as { id: number };
      const result = db.prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
         VALUES (?, 'summarize', 'function', 0, 0, 'baseline', 1)`,
      ).run(file.id) as { lastInsertRowid: number | bigint };
      symId = Number(result.lastInsertRowid);
    } finally {
      db.close();
    }

    // Ingest a summary
    await builder.ingestSummary(symId, 'This function summarizes stuff', 'gpt-4');

    const db2 = openDb(dbPath);
    try {
      const summary = db2.prepare('SELECT summary, model FROM symbol_summaries WHERE symbol_id = ?').get(symId) as { summary: string; model: string };
      expect(summary.summary).toBe('This function summarizes stuff');
      expect(summary.model).toBe('gpt-4');
    } finally {
      db2.close();
    }
  });
});
