/**
 * Tests for FileDiscoveryStage — the file-walker-only stage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb, type Database, getLoreMeta, LORE_META_INDEX_CHECKPOINT } from '../../src/db/schema.js';
import { FileDiscoveryStage } from '../../src/indexer/stages/source-index.js';
import { ImportResolutionStage } from '../../src/indexer/stages/import-resolution.js';
import { ReverseDepsStage } from '../../src/indexer/stages/reverse-deps.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { resolveSymbolEdges } from '../../src/resolution/call-graph.js';
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
      includeGlobs: ['**/*'],
      excludeGlobs: [],
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

describe('FileDiscoveryStage', () => {
  describe('build mode', () => {
    it('walks files and inserts file rows', async () => {
      fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'const x = 1;');
      fs.writeFileSync(path.join(tmpDir, 'util.ts'), 'export function add() {}');

      const stage = new FileDiscoveryStage();
      const ctx = makeContext();
      await stage.execute(ctx, 'build');

      const files = db.prepare('SELECT path, language, layer, generation FROM files ORDER BY path').all() as Array<{ path: string; language: string; layer: string; generation: number }>;
      expect(files.length).toBe(2);
      expect(files.every(f => f.language === 'typescript')).toBe(true);
      expect(files.every(f => f.layer === 'baseline')).toBe(true);
      expect(files.every(f => f.generation === 1)).toBe(true);
      expect(ctx.files.length).toBe(2);
    });

    it('populates sourceCache with file contents', async () => {
      const content = 'const hello = "world";';
      fs.writeFileSync(path.join(tmpDir, 'main.ts'), content);

      const ctx = makeContext();
      await new FileDiscoveryStage().execute(ctx, 'build');

      const absPath = path.resolve(tmpDir, 'main.ts');
      expect(ctx.sourceCache.get(absPath)).toBe(content);

      // Verify DB row has correct size and hash
      const row = db.prepare('SELECT size_bytes, last_hash FROM files WHERE path = ?').get(absPath) as { size_bytes: number; last_hash: string };
      expect(row.size_bytes).toBe(Buffer.byteLength(content, 'utf8'));
      expect(row.last_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('saves index checkpoint in lore_meta', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), '1');

      await new FileDiscoveryStage().execute(makeContext(), 'build');

      const cp = getLoreMeta(db, LORE_META_INDEX_CHECKPOINT);
      expect(cp).toBeDefined();
      // Should be a valid ISO date string
      expect(new Date(cp!).getTime()).not.toBeNaN();
    });

    it('skips files sourced from SCIP', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), '1');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), '2');

      const absA = path.resolve(tmpDir, 'a.ts');
      const ctx = makeContext({ scipSourcedFiles: new Set([absA]) });
      await new FileDiscoveryStage().execute(ctx, 'build');

      const files = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
      expect(files.length).toBe(1);
      expect(files[0]!.path).toBe(path.resolve(tmpDir, 'b.ts'));
    });

    it('retains unsourced files even when SCIP covered the language', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), '1');
      fs.writeFileSync(path.join(tmpDir, 'b.py'), '2');

      const ctx = makeContext({ scipSourcedLanguages: new Set(['typescript']) });
      await new FileDiscoveryStage().execute(ctx, 'build');

      const files = db.prepare('SELECT language FROM files').all() as Array<{ language: string }>;
      expect(files.map((file) => file.language).sort()).toEqual(['python', 'typescript']);
    });

    it('skips files with unknown extensions', async () => {
      fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hi');

      await new FileDiscoveryStage().execute(makeContext(), 'build');

      const files = db.prepare('SELECT * FROM files').all();
      expect(files.length).toBe(0);
    });

    it('handles unreadable files gracefully', async () => {
      fs.writeFileSync(path.join(tmpDir, 'ok.ts'), 'a');
      // Create a symlink to a non-existent target
      const badPath = path.join(tmpDir, 'bad.ts');
      fs.symlinkSync('/nonexistent/path', badPath);

      const ctx = makeContext();
      await new FileDiscoveryStage().execute(ctx, 'build');

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
      await new FileDiscoveryStage().execute(ctx, 'update');

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
      await new FileDiscoveryStage().execute(ctx, 'update');

      const dirty = db.prepare('SELECT path, branch FROM dirty_files').all() as Array<{ path: string; branch: string }>;
      expect(dirty.length).toBe(1);
      expect(dirty[0]!.path).toBe(filePath);
      expect(dirty[0]!.branch).toBe('main');
    });

    it('handles deleted files by cleaning up DB rows', async () => {
      // First, insert a file
      const filePath = path.join(tmpDir, 'gone.ts');
      fs.writeFileSync(filePath, 'const z = 3;');

      const ctx1 = makeContext({ layer: 'overlay', generation: 0, changedFiles: [filePath] });
      await new FileDiscoveryStage().execute(ctx1, 'update');
      expect(db.prepare('SELECT COUNT(*) as cnt FROM files').get()).toEqual({ cnt: 1 });

      // Now delete the file and re-run
      fs.unlinkSync(filePath);
      const ctx2 = makeContext({ layer: 'overlay', generation: 0, changedFiles: [filePath], files: [] });
      await new FileDiscoveryStage().execute(ctx2, 'update');

      // File row should be cleaned up, dirty_files sentinel inserted
      expect(db.prepare('SELECT COUNT(*) as cnt FROM files').get()).toEqual({ cnt: 0 });
      expect(db.prepare('SELECT COUNT(*) as cnt FROM symbols').get()).toEqual({ cnt: 0 });
      const dirty = db.prepare('SELECT path FROM dirty_files').all() as Array<{ path: string }>;
      expect(dirty.length).toBe(1);
      expect(dirty[0]!.path).toBe(filePath);
    });

    it('marks effective baseline symbols stale when a file is deleted', async () => {
      const filePath = path.join(tmpDir, 'baseline-gone.ts');
      fs.writeFileSync(filePath, 'export const value = 1;');
      const canonicalPath = fs.realpathSync(filePath);
      const fileResult = db.prepare(
        `INSERT INTO files (path, branch, language, source, layer, generation)
         VALUES (?, 'main', 'typescript', 'export const value = 1;', 'baseline', 1)`,
      ).run(canonicalPath) as { lastInsertRowid: number | bigint };
      const symbolResult = db.prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
         VALUES (?, 'value', 'variable', 0, 0, 'baseline', 1)`,
      ).run(Number(fileResult.lastInsertRowid)) as { lastInsertRowid: number | bigint };
      const symbolId = Number(symbolResult.lastInsertRowid);
      db.prepare(
        "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
      ).run();
      fs.unlinkSync(filePath);

      const ctx = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [filePath],
      });
      await new FileDiscoveryStage().execute(ctx, 'update');

      expect(ctx.staleSymbolIds).toContain(symbolId);
      expect(db.prepare('SELECT id FROM effective_symbols WHERE id = ?').get(symbolId))
        .toBeUndefined();
      expect(db.prepare('SELECT id FROM symbols WHERE id = ?').get(symbolId)).toBeDefined();
    });

    it('repairs every inbound target on replacement and invalidates them on deletion', async () => {
      const targetPath = path.join(tmpDir, 'target.ts');
      const callerPath = path.join(tmpDir, 'caller.ts');
      fs.writeFileSync(targetPath, 'export function targetFn() {}\nexport class Base {}\nexport type Model = string;');
      fs.writeFileSync(callerPath, 'export function caller() { targetFn(); }');

      const insertFile = db.prepare(
        `INSERT INTO files
           (path, branch, language, source, last_hash, layer, generation)
         VALUES (?, 'main', 'typescript', ?, 'old-hash', 'baseline', 1)`,
      );
      const baselineTargetId = Number(insertFile.run(targetPath, fs.readFileSync(targetPath, 'utf8')).lastInsertRowid);
      const callerFileId = Number(insertFile.run(callerPath, fs.readFileSync(callerPath, 'utf8')).lastInsertRowid);
      db.prepare(
        "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
      ).run();
      const insertSymbol = db.prepare(
        `INSERT INTO symbols
           (file_id, name, kind, start_line, end_line, layer, generation)
         VALUES (?, ?, ?, ?, ?, 'baseline', 1)`,
      );
      const oldTarget = Number(insertSymbol.run(baselineTargetId, 'targetFn', 'function', 0, 0).lastInsertRowid);
      const oldBase = Number(insertSymbol.run(baselineTargetId, 'Base', 'class', 1, 1).lastInsertRowid);
      const oldModel = Number(insertSymbol.run(baselineTargetId, 'Model', 'type', 2, 2).lastInsertRowid);
      const caller = Number(insertSymbol.run(callerFileId, 'caller', 'function', 0, 0).lastInsertRowid);
      const child = Number(insertSymbol.run(callerFileId, 'Child', 'class', 1, 1).lastInsertRowid);
      db.prepare(
        `INSERT INTO symbol_refs
           (caller_id, file_id, callee_id, callee_name, call_line, definition_path,
            definition_line, resolution_method, layer, generation)
         VALUES (?, ?, ?, 'targetFn', 0, ?, 0, 'scip_definition', 'baseline', 1)`,
      ).run(caller, callerFileId, oldTarget, targetPath);
      db.prepare(
        `INSERT INTO type_refs
           (file_id, symbol_id, type_id, type_name, type_name_bare, ref_line,
            definition_path, definition_line, resolution_method, layer, generation)
         VALUES (?, ?, ?, 'Model', 'Model', 0, ?, 2, 'scip_definition', 'baseline', 1)`,
      ).run(callerFileId, caller, oldModel, targetPath);
      db.prepare(
        `INSERT INTO symbol_relationships
           (file_id, source_symbol_id, target_symbol_id, target_symbol_name,
            relationship_type, line, definition_path, definition_line,
            resolution_method, layer, generation)
         VALUES (?, ?, ?, 'Base', 'extends', 1, ?, 1,
                 'scip_definition', 'baseline', 1)`,
      ).run(callerFileId, child, oldBase, targetPath);
      db.prepare(
        `INSERT INTO file_imports
           (file_id, raw_import, resolved_id, resolution_method, layer, generation)
         VALUES (?, './target', ?, 'filesystem_exact', 'baseline', 1)`,
      ).run(callerFileId, baselineTargetId);

      fs.writeFileSync(targetPath, 'export function targetFn() { return 2; }\nexport class Base {}\nexport type Model = number;');
      const replacementContext = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [targetPath],
      });
      await new FileDiscoveryStage().execute(replacementContext, 'update');

      const overlayTarget = db.prepare(
        `SELECT id FROM effective_files WHERE path = ? AND branch = 'main'`,
      ).get(targetPath) as { id: number };
      expect(overlayTarget.id).not.toBe(baselineTargetId);
      expect(db.prepare(
        'SELECT resolved_id FROM file_imports WHERE file_id = ?',
      ).get(callerFileId)).toEqual({ resolved_id: overlayTarget.id });
      expect(db.prepare(
        'SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?',
      ).get(caller)).toEqual({ callee_id: null, resolution_method: 'unresolved' });

      const insertOverlaySymbol = db.prepare(
        `INSERT INTO symbols
           (file_id, name, kind, start_line, end_line, layer, generation)
         VALUES (?, ?, ?, ?, ?, 'overlay', 0)`,
      );
      const newTarget = Number(insertOverlaySymbol.run(overlayTarget.id, 'targetFn', 'function', 0, 0).lastInsertRowid);
      const newBase = Number(insertOverlaySymbol.run(overlayTarget.id, 'Base', 'class', 1, 1).lastInsertRowid);
      const newModel = Number(insertOverlaySymbol.run(overlayTarget.id, 'Model', 'type', 2, 2).lastInsertRowid);
      resolveSymbolEdges(db, { overlayOnly: true, branch: 'main' });

      expect(db.prepare('SELECT callee_id FROM symbol_refs WHERE caller_id = ?').get(caller))
        .toEqual({ callee_id: newTarget });
      expect(db.prepare('SELECT type_id FROM type_refs WHERE symbol_id = ?').get(caller))
        .toEqual({ type_id: newModel });
      expect(db.prepare(
        'SELECT target_symbol_id FROM symbol_relationships WHERE source_symbol_id = ?',
      ).get(child)).toEqual({ target_symbol_id: newBase });

      await new ReverseDepsStage().execute(replacementContext, 'update');
      expect(db.prepare(
        `SELECT dep_kind FROM reverse_deps
          WHERE file_id = ? AND dependent_id = ? ORDER BY dep_kind`,
      ).all(overlayTarget.id, callerFileId)).toEqual([
        { dep_kind: 'import' },
        { dep_kind: 'ref' },
      ]);

      fs.writeFileSync(targetPath, 'export function targetFn() { return 3; }\nexport class Base {}\nexport type Model = bigint;');
      const secondReplacementContext = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [targetPath],
      });
      await new FileDiscoveryStage().execute(secondReplacementContext, 'update');
      const secondOverlayTarget = db.prepare(
        `SELECT id FROM effective_files WHERE path = ? AND branch = 'main'`,
      ).get(targetPath) as { id: number };
      expect(secondOverlayTarget.id).not.toBe(overlayTarget.id);
      expect(db.prepare(
        'SELECT resolved_id FROM file_imports WHERE file_id = ?',
      ).get(callerFileId)).toEqual({ resolved_id: secondOverlayTarget.id });
      insertOverlaySymbol.run(secondOverlayTarget.id, 'targetFn', 'function', 0, 0);
      insertOverlaySymbol.run(secondOverlayTarget.id, 'Base', 'class', 1, 1);
      insertOverlaySymbol.run(secondOverlayTarget.id, 'Model', 'type', 2, 2);
      resolveSymbolEdges(db, { overlayOnly: true, branch: 'main' });
      await new ReverseDepsStage().execute(secondReplacementContext, 'update');

      fs.unlinkSync(targetPath);
      const deletionContext = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [targetPath],
      });
      await new FileDiscoveryStage().execute(deletionContext, 'update');
      resolveSymbolEdges(db, { overlayOnly: true, branch: 'main' });
      await new ReverseDepsStage().execute(deletionContext, 'update');

      expect(db.prepare('SELECT id FROM effective_files WHERE path = ?').get(targetPath)).toBeUndefined();
      expect(db.prepare(
        'SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?',
      ).get(caller)).toEqual({ callee_id: null, resolution_method: 'overlay_stale' });
      expect(db.prepare(
        'SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = ?',
      ).get(caller)).toEqual({ type_id: null, resolution_method: 'overlay_stale' });
      expect(db.prepare(
        `SELECT target_symbol_id, resolution_method
           FROM symbol_relationships WHERE source_symbol_id = ?`,
      ).get(child)).toEqual({ target_symbol_id: null, resolution_method: 'overlay_stale' });
      expect(db.prepare(
        'SELECT resolved_id, resolution_method FROM file_imports WHERE file_id = ?',
      ).get(callerFileId)).toEqual({ resolved_id: null, resolution_method: 'overlay_stale' });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM reverse_deps
          WHERE file_id IN (?, ?, ?) OR dependent_id IN (?, ?, ?)`,
      ).get(
        baselineTargetId,
        overlayTarget.id,
        secondOverlayTarget.id,
        baselineTargetId,
        overlayTarget.id,
        secondOverlayTarget.id,
      ))
        .toEqual({ count: 0 });

      for (const [edgeView, targetView, targetColumn] of [
        ['effective_symbol_refs', 'effective_symbols', 'callee_id'],
        ['effective_type_refs', 'effective_symbols', 'type_id'],
        ['effective_symbol_relationships', 'effective_symbols', 'target_symbol_id'],
        ['effective_file_imports', 'effective_files', 'resolved_id'],
      ] as const) {
        expect(db.prepare(
          `SELECT COUNT(*) AS count FROM ${edgeView} edge
           LEFT JOIN ${targetView} target ON target.id = edge.${targetColumn}
           WHERE edge.${targetColumn} IS NOT NULL AND target.id IS NULL`,
        ).get()).toEqual({ count: 0 });
      }

      fs.writeFileSync(
        targetPath,
        'export function targetFn() { return 4; }\nexport class Base {}\nexport type Model = unknown;',
      );
      const restoredContext = makeContext({
        layer: 'overlay',
        generation: 0,
        changedFiles: [targetPath],
      });
      await new FileDiscoveryStage().execute(restoredContext, 'update');
      const restoredFile = db.prepare(
        `SELECT id FROM effective_files WHERE path = ? AND branch = 'main'`,
      ).get(targetPath) as { id: number };
      const restoredTarget = Number(insertOverlaySymbol.run(
        restoredFile.id,
        'targetFn',
        'function',
        0,
        0,
      ).lastInsertRowid);
      const restoredBase = Number(insertOverlaySymbol.run(
        restoredFile.id,
        'Base',
        'class',
        1,
        1,
      ).lastInsertRowid);
      const restoredModel = Number(insertOverlaySymbol.run(
        restoredFile.id,
        'Model',
        'type',
        2,
        2,
      ).lastInsertRowid);

      await new ImportResolutionStage().execute(restoredContext, 'update');
      resolveSymbolEdges(db, { overlayOnly: true, branch: 'main' });

      expect(db.prepare(
        'SELECT callee_id, resolution_method FROM symbol_refs WHERE caller_id = ?',
      ).get(caller)).toEqual({ callee_id: restoredTarget, resolution_method: 'lsp_definition' });
      expect(db.prepare(
        'SELECT type_id, resolution_method FROM type_refs WHERE symbol_id = ?',
      ).get(caller)).toEqual({ type_id: restoredModel, resolution_method: 'lsp_definition' });
      expect(db.prepare(
        `SELECT target_symbol_id, resolution_method
           FROM symbol_relationships WHERE source_symbol_id = ?`,
      ).get(child)).toEqual({
        target_symbol_id: restoredBase,
        resolution_method: 'lsp_definition',
      });
      expect(db.prepare(
        'SELECT resolved_id, resolution_method FROM file_imports WHERE file_id = ?',
      ).get(callerFileId)).toEqual({
        resolved_id: restoredFile.id,
        resolution_method: 'filesystem_exact',
      });
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
      await new FileDiscoveryStage().execute(ctx, 'update');

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
      await new FileDiscoveryStage().execute(ctx, 'update');

      expect(ctx.files.length).toBe(0);
    });
  });

  describe('dispose', () => {
    it('is a no-op', async () => {
      const stage = new FileDiscoveryStage();
      await expect(stage.dispose()).resolves.toBeUndefined();
    });
  });
});
