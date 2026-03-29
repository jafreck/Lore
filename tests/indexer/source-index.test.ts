/**
 * Tests for SourceIndexStage — the file-walker-only stage after tree-sitter removal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb, type Database, getLoreMeta, LORE_META_INDEX_CHECKPOINT } from '../../src/db/schema.js';
import { SourceIndexStage } from '../../src/indexer/stages/source-index.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

let tmpDir: string;
let db: Database.Database;

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: {
      rootDir: tmpDir,
      extensions: ['.ts', '.js', '.py'],
      include: ['**/*'],
      exclude: [],
    },
    branch: 'main',
    lsp: null,
    scip: null,
    embedder: null,
    log: {
      indexing: vi.fn(),
      startup: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      toolCall: vi.fn(),
    } as any,
    files: [],
    indexDependencies: false,
    history: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    sourceCache: new Map(),
    layer: 'baseline',
    generation: 1,
    ...overrides,
  };
}

beforeEach(() => {
  resetLogger();
  initLogger({ level: LogLevel.SILENT });
  // Use realpathSync to resolve macOS /var → /private/var symlinks,
  // matching what walkFiles does internally.
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lore-source-idx-')));
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SourceIndexStage', () => {
  describe('build mode', () => {
    it('walks files and inserts file rows', async () => {
      fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'const x = 1;');
      fs.writeFileSync(path.join(tmpDir, 'util.ts'), 'export function add() {}');

      const stage = new SourceIndexStage();
      const ctx = makeContext();
      await stage.execute(ctx, 'build');

      const files = db.prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>;
      expect(files.length).toBe(2);
      expect(files.map(f => f.language)).toEqual(['typescript', 'typescript']);
      expect(ctx.files.length).toBe(2);
    });

    it('populates sourceCache with file contents', async () => {
      const content = 'const hello = "world";';
      fs.writeFileSync(path.join(tmpDir, 'main.ts'), content);

      const ctx = makeContext();
      await new SourceIndexStage().execute(ctx, 'build');

      const absPath = path.resolve(tmpDir, 'main.ts');
      expect(ctx.sourceCache.get(absPath)).toBe(content);
    });

    it('saves index checkpoint in lore_meta', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), '1');

      await new SourceIndexStage().execute(makeContext(), 'build');

      const cp = getLoreMeta(db, LORE_META_INDEX_CHECKPOINT);
      expect(cp).toBeDefined();
      expect(cp!.length).toBeGreaterThan(0);
    });

    it('skips files sourced from SCIP', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), '1');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), '2');

      const absA = path.resolve(tmpDir, 'a.ts');
      const ctx = makeContext({ scipSourcedFiles: new Set([absA]) });
      await new SourceIndexStage().execute(ctx, 'build');

      const files = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
      expect(files.length).toBe(1);
      expect(files[0]!.path).toContain('b.ts');
    });

    it('skips languages fully covered by SCIP', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), '1');
      fs.writeFileSync(path.join(tmpDir, 'b.py'), '2');

      const ctx = makeContext({ scipSourcedLanguages: new Set(['typescript']) });
      await new SourceIndexStage().execute(ctx, 'build');

      const files = db.prepare('SELECT language FROM files').all() as Array<{ language: string }>;
      expect(files.length).toBe(1);
      expect(files[0]!.language).toBe('python');
    });

    it('skips files with unknown extensions', async () => {
      fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hi');

      await new SourceIndexStage().execute(makeContext(), 'build');

      const files = db.prepare('SELECT * FROM files').all();
      expect(files.length).toBe(0);
    });

    it('handles unreadable files gracefully', async () => {
      fs.writeFileSync(path.join(tmpDir, 'ok.ts'), 'a');
      // Create a symlink to a non-existent target
      const badPath = path.join(tmpDir, 'bad.ts');
      fs.symlinkSync('/nonexistent/path', badPath);

      const ctx = makeContext();
      await new SourceIndexStage().execute(ctx, 'build');

      // Only the readable file should be indexed
      expect(ctx.files.length).toBe(1);
      expect(ctx.files[0]!.path).toContain('ok.ts');
    });
  });

  describe('update mode (overlay)', () => {
    it('processes only changed files', async () => {
      const filePath = path.join(tmpDir, 'changed.ts');
      fs.writeFileSync(filePath, 'const y = 2;');

      const ctx = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [filePath],
      });
      await new SourceIndexStage().execute(ctx, 'update');

      const files = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
      expect(files.length).toBe(1);
      expect(ctx.files.length).toBe(1);
      expect(ctx.changedSourcePaths.length).toBe(1);
    });

    it('inserts dirty_files sentinel', async () => {
      const filePath = path.join(tmpDir, 'changed.ts');
      fs.writeFileSync(filePath, 'const y = 2;');

      const ctx = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [filePath],
      });
      await new SourceIndexStage().execute(ctx, 'update');

      const dirty = db.prepare('SELECT * FROM dirty_files').all() as Array<{ path: string }>;
      expect(dirty.length).toBe(1);
    });

    it('handles deleted files by cleaning up DB rows', async () => {
      // First, insert a file
      const filePath = path.join(tmpDir, 'gone.ts');
      fs.writeFileSync(filePath, 'const z = 3;');

      const ctx1 = makeContext({ layer: 'overlay', generation: 0, changedFiles: [filePath] });
      await new SourceIndexStage().execute(ctx1, 'update');
      expect(db.prepare('SELECT COUNT(*) as cnt FROM files').get()).toEqual({ cnt: 1 });

      // Now delete the file and re-run
      fs.unlinkSync(filePath);
      const ctx2 = makeContext({ layer: 'overlay', generation: 0, changedFiles: [filePath], files: [] });
      await new SourceIndexStage().execute(ctx2, 'update');

      // File row should be cleaned up, dirty_files sentinel inserted
      expect(db.prepare('SELECT COUNT(*) as cnt FROM files').get()).toEqual({ cnt: 0 });
      const dirty = db.prepare('SELECT * FROM dirty_files').all();
      expect(dirty.length).toBeGreaterThanOrEqual(1);
    });

    it('skips files already sourced from SCIP', async () => {
      const filePath = path.join(tmpDir, 'scip.ts');
      fs.writeFileSync(filePath, 'x');

      const ctx = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [filePath],
        scipSourcedFiles: new Set([filePath]),
      });
      await new SourceIndexStage().execute(ctx, 'update');

      expect(ctx.files.length).toBe(0);
    });

    it('skips files with no detectable language', async () => {
      const filePath = path.join(tmpDir, 'data.xyz');
      fs.writeFileSync(filePath, 'junk');

      const ctx = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [filePath],
      });
      await new SourceIndexStage().execute(ctx, 'update');

      expect(ctx.files.length).toBe(0);
    });
  });

  describe('dispose', () => {
    it('is a no-op', async () => {
      const stage = new SourceIndexStage();
      await expect(stage.dispose()).resolves.toBeUndefined();
    });
  });
});
