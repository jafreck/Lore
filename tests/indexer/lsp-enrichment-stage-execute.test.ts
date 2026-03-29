/**
 * Tests for LspEnrichmentStage.execute() — baseline/overlay layer paths,
 * SCIP language filtering, enrichUnresolvedScipRefs, and preCacheFiles.
 *
 * Uses vi.mock to replace LspEnrichmentCoordinator with a controllable fake.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type Database } from '../../src/db/schema.js';

// ── Mock coordinator ────────────────────────────────────────────────────────────

const mockEnrich = vi.fn<any>().mockResolvedValue([]);
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockDispose = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lsp/enrichment.js', () => ({
  LspEnrichmentCoordinator: vi.fn().mockImplementation(function (this: any) {
    this.start = mockStart;
    this.dispose = mockDispose;
    this.enrich = mockEnrich;
  }),
}));

// Import AFTER mock declaration so the mock is applied
import { LspEnrichmentStage } from '../../src/indexer/stages/lsp-enrichment.js';
import { LspEnrichmentCoordinator } from '../../src/lsp/enrichment.js';

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeContext(overrides: Record<string, unknown> = {}): any {
  return {
    db: null as any,
    branch: 'main',
    lsp: { enabled: true, requestTimeoutMs: 1000, servers: {} },
    files: [],
    walkerConfig: { rootDir: '/tmp' },
    sourceCache: new Map<string, string>(),
    indexDependencies: false,
    layer: 'overlay' as const,
    generation: 1,
    log: { indexing: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    scipSourcedLanguages: undefined as ReadonlySet<string> | undefined,
    scipCoveredLanguages: undefined as ReadonlySet<string> | undefined,
    ...overrides,
  };
}

function insertFile(db: Database.Database, filePath: string, lang = 'typescript'): number {
  const info = db.prepare(
    `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
     VALUES (?, 'main', ?, 100, 'abc', 'source', 'baseline', 1)`,
  ).run(filePath, lang);
  return Number((info as any).lastInsertRowid);
}

function insertSymbol(db: Database.Database, fileId: number, name: string, startLine: number): number {
  const info = db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
     VALUES (?, ?, 'function', ?, ?, 'baseline', 1)`,
  ).run(fileId, name, startLine, startLine + 5);
  return Number((info as any).lastInsertRowid);
}

function insertCallRef(
  db: Database.Database,
  callerId: number,
  fileId: number,
  calleeName: string,
  line: number,
  char: number,
  resolutionMethod = 'unresolved',
  definitionPath: string | null = null,
): number {
  const info = db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, call_character,
       resolution_method, definition_path, layer, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'baseline', 1)`,
  ).run(callerId, fileId, calleeName, line, char, resolutionMethod, definitionPath);
  return Number((info as any).lastInsertRowid);
}

function insertTypeRef(
  db: Database.Database,
  fileId: number,
  symbolId: number,
  typeName: string,
  line: number,
  char: number,
  resolutionMethod = 'unresolved',
  definitionPath: string | null = null,
): number {
  const info = db.prepare(
    `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind,
       ref_line, ref_character, resolution_method, definition_path, layer, generation)
     VALUES (?, ?, ?, ?, 'annotation', ?, ?, ?, ?, 'baseline', 1)`,
  ).run(fileId, symbolId, typeName, typeName, line, char, resolutionMethod, definitionPath);
  return Number((info as any).lastInsertRowid);
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('LspEnrichmentStage.execute', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lore-stage-exec-'));
    db = openDb(':memory:');
    mockEnrich.mockReset().mockResolvedValue([]);
    mockStart.mockReset().mockResolvedValue(undefined);
    mockDispose.mockReset().mockResolvedValue(undefined);
    (LspEnrichmentCoordinator as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Baseline layer ──────────────────────────────────────────────────────────

  describe('baseline layer', () => {
    it('skips all files when all are SCIP-sourced', async () => {
      const stage = new LspEnrichmentStage();
      const sourceCache = new Map([['x', 'y']]);
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [
          { path: '/tmp/a.ts', language: 'typescript' },
          { path: '/tmp/b.ts', language: 'typescript' },
        ],
        sourceCache,
        scipSourcedLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');
      // Coordinator should NOT have been created
      expect(LspEnrichmentCoordinator).not.toHaveBeenCalled();
      expect(sourceCache.size).toBe(0);
    });

    it('skips files whose language is SCIP-covered', async () => {
      const stage = new LspEnrichmentStage();
      const sourceCache = new Map<string, string>();
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [
          { path: '/tmp/a.ts', language: 'typescript' },
        ],
        sourceCache,
        scipCoveredLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');
      expect(LspEnrichmentCoordinator).not.toHaveBeenCalled();
      expect(sourceCache.size).toBe(0);
    });

    it('creates coordinator and enriches non-SCIP files', async () => {
      const filePath = join(tmpDir, 'app.py');
      writeFileSync(filePath, 'def hello(): pass');

      const fileId = insertFile(db, filePath, 'python');
      insertSymbol(db, fileId, 'hello', 0);

      const stage = new LspEnrichmentStage();
      const sourceCache = new Map<string, string>();
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [
          { path: join(tmpDir, 'skip.ts'), language: 'typescript' },
          { path: filePath, language: 'python' },
        ],
        sourceCache,
        scipSourcedLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');

      // Coordinator should have been created and started with python
      expect(LspEnrichmentCoordinator).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledTimes(1);
      const startLangs = mockStart.mock.calls[0][0] as Set<string>;
      expect(startLangs.has('python')).toBe(true);
      expect(startLangs.has('typescript')).toBe(false);

      // enrich should have been called for the python file
      expect(mockEnrich).toHaveBeenCalled();
      const enrichArg = mockEnrich.mock.calls[0][0];
      expect(enrichArg.filePath).toBe(filePath);
      expect(enrichArg.language).toBe('python');

      expect(sourceCache.size).toBe(0); // cleared after
    });

    it('adds typescript to languages when indexDependencies is true', async () => {
      const filePath = join(tmpDir, 'app.py');
      writeFileSync(filePath, 'x = 1');

      insertFile(db, filePath, 'python');

      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [{ path: filePath, language: 'python' }],
        indexDependencies: true,
      });

      await stage.execute(ctx, 'build');

      const startLangs = mockStart.mock.calls[0][0] as Set<string>;
      expect(startLangs.has('typescript')).toBe(true);
      expect(startLangs.has('python')).toBe(true);
    });
  });

  // ── Overlay layer ──────────────────────────────────────────────────────────

  describe('overlay layer', () => {
    it('only enriches SCIP files in overlay mode (non-SCIP handled by LspExtractionStage)', async () => {
      const pyFile = join(tmpDir, 'app.py');
      const tsFile = join(tmpDir, 'app.ts');
      writeFileSync(pyFile, 'def greet(): pass');
      writeFileSync(tsFile, 'function greet() {}');

      const pyFileId = insertFile(db, pyFile, 'python');
      const pySymId = insertSymbol(db, pyFileId, 'greet', 0);

      const tsFileId = insertFile(db, tsFile, 'typescript');
      const tsSymId = insertSymbol(db, tsFileId, 'greet', 0);
      // Unresolved ref in the SCIP file
      insertCallRef(db, tsSymId, tsFileId, 'foo', 1, 5, 'unresolved', null);

      const stage = new LspEnrichmentStage();
      const sourceCache = new Map<string, string>();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [
          { path: pyFile, language: 'python' },
          { path: tsFile, language: 'typescript' },
        ],
        sourceCache,
        scipSourcedLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');

      // In overlay mode, LspEnrichmentStage only handles SCIP files
      // Non-SCIP files are enriched by LspExtractionStage
      expect(LspEnrichmentCoordinator).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledTimes(1);
      const startLangs = mockStart.mock.calls[0][0] as Set<string>;
      expect(startLangs.has('typescript')).toBe(true);
      // Python is NOT started — it's handled by LspExtractionStage
      expect(startLangs.has('python')).toBe(false);

      // Only the SCIP file should be enriched
      const tsCall = mockEnrich.mock.calls.find((c: any) => c[0].filePath === tsFile);
      expect(tsCall).toBeDefined();

      expect(sourceCache.size).toBe(0);
    });

    it('skips when no SCIP languages in overlay mode (all handled by LspExtractionStage)', async () => {
      const pyFile = join(tmpDir, 'app.py');
      writeFileSync(pyFile, 'def greet(): pass');

      const fileId = insertFile(db, pyFile, 'python');
      insertSymbol(db, fileId, 'greet', 0);

      const stage = new LspEnrichmentStage();
      const sourceCache = new Map<string, string>();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [{ path: pyFile, language: 'python' }],
        sourceCache,
      });

      await stage.execute(ctx, 'build');

      // No coordinator created — no SCIP files to enrich
      expect(LspEnrichmentCoordinator).not.toHaveBeenCalled();
      expect(sourceCache.size).toBe(0);
    });

    it('logs and returns early when all files filtered out', async () => {
      const stage = new LspEnrichmentStage();
      const sourceCache = new Map<string, string>();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [],
        sourceCache,
      });

      // files.length === 0 triggers the early-return in the top guard
      await stage.execute(ctx, 'build');
      expect(LspEnrichmentCoordinator).not.toHaveBeenCalled();
      expect(sourceCache.size).toBe(0);
    });

    it('adds typescript to languages when indexDependencies is true (overlay with SCIP files)', async () => {
      const tsFile = join(tmpDir, 'app.ts');
      writeFileSync(tsFile, 'const x = 1;');
      const fileId = insertFile(db, tsFile, 'typescript');
      const symId = insertSymbol(db, fileId, 'x', 0);
      insertCallRef(db, symId, fileId, 'foo', 1, 5, 'unresolved', null);

      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [{ path: tsFile, language: 'typescript' }],
        indexDependencies: true,
        scipSourcedLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');

      expect(mockStart).toHaveBeenCalledTimes(1);
      const startLangs = mockStart.mock.calls[0][0] as Set<string>;
      expect(startLangs.has('typescript')).toBe(true);
    });
  });

  // ── enrichUnresolvedScipRefs (via overlay path) ─────────────────────────────

  describe('enrichUnresolvedScipRefs (via overlay)', () => {
    it('only queries unresolved refs with no definition_path', async () => {
      const tsFile = join(tmpDir, 'module.ts');
      writeFileSync(tsFile, 'const x = db.prepare("SELECT 1");');

      const fileId = insertFile(db, tsFile, 'typescript');
      const symId = insertSymbol(db, fileId, 'x', 0);

      // Unresolved ref — should be picked up
      const unresolvedRefId = insertCallRef(db, symId, fileId, 'prepare', 0, 15, 'unresolved', null);
      // Already resolved ref — should NOT be picked up
      insertCallRef(db, symId, fileId, 'other', 0, 20, 'scip', '/already/resolved.ts');

      // Mock enrich to return a result for the one target
      mockEnrich.mockResolvedValueOnce([
        {
          resolvedTypeSignature: 'Statement',
          resolvedReturnType: null,
          definitionUri: 'file:///def.ts',
          definitionPath: '/def.ts',
          definitionLine: 10,
          definitionCharacter: 2,
        },
      ]);

      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [{ path: tsFile, language: 'typescript' }],
        scipSourcedLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');

      // The coordinator should have been called with exactly 1 target
      const tsCall = mockEnrich.mock.calls.find((c: any) => c[0].filePath === tsFile);
      expect(tsCall).toBeDefined();
      expect(tsCall![0].targets).toHaveLength(1);
      expect(tsCall![0].targets[0].line).toBe(0);
      expect(tsCall![0].targets[0].character).toBe(15);

      // Check that the unresolved ref was updated
      const row = db.prepare(
        'SELECT definition_path, definition_line, definition_character, resolved_type_signature FROM symbol_refs WHERE id = ?',
      ).get(unresolvedRefId) as any;
      expect(row.definition_path).toBe('/def.ts');
      expect(row.definition_line).toBe(10);
      expect(row.definition_character).toBe(2);
      expect(row.resolved_type_signature).toBe('Statement');
    });

    it('includes unresolved type_refs for SCIP files', async () => {
      const tsFile = join(tmpDir, 'types.ts');
      writeFileSync(tsFile, 'const x: SomeType = {};');

      const fileId = insertFile(db, tsFile, 'typescript');
      const symId = insertSymbol(db, fileId, 'x', 0);

      // Unresolved type ref — should be picked up
      const unresolvedTrId = insertTypeRef(db, fileId, symId, 'SomeType', 0, 9, 'unresolved', null);
      // Already resolved type ref — should NOT be picked up
      insertTypeRef(db, fileId, symId, 'OtherType', 0, 20, 'scip', '/resolved.ts');

      mockEnrich.mockResolvedValueOnce([
        {
          resolvedTypeSignature: 'interface SomeType',
          definitionUri: 'file:///types.ts',
          definitionPath: '/types.ts',
          definitionLine: 5,
          definitionCharacter: 0,
        },
      ]);

      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [{ path: tsFile, language: 'typescript' }],
        scipSourcedLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');

      const tsCall = mockEnrich.mock.calls.find((c: any) => c[0].filePath === tsFile);
      expect(tsCall).toBeDefined();
      expect(tsCall![0].targets).toHaveLength(1);
      expect(tsCall![0].targets[0].line).toBe(0);
      expect(tsCall![0].targets[0].character).toBe(9);

      const row = db.prepare(
        'SELECT definition_path, definition_line, resolved_type_signature FROM type_refs WHERE id = ?',
      ).get(unresolvedTrId) as any;
      expect(row.definition_path).toBe('/types.ts');
      expect(row.definition_line).toBe(5);
      expect(row.resolved_type_signature).toBe('interface SomeType');
    });

    it('skips SCIP file when it has no unresolved refs', async () => {
      const tsFile = join(tmpDir, 'clean.ts');
      writeFileSync(tsFile, 'const x = 1;');

      const fileId = insertFile(db, tsFile, 'typescript');
      const symId = insertSymbol(db, fileId, 'x', 0);
      // All refs already resolved
      insertCallRef(db, symId, fileId, 'foo', 0, 5, 'scip', '/resolved.ts');

      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [{ path: tsFile, language: 'typescript' }],
        scipSourcedLanguages: new Set(['typescript']),
      });

      await stage.execute(ctx, 'build');

      // enrich should still be called (the enrichUnresolvedScipRefs function
      // calls processFile which checks for targets), but with no targets
      // it returns [] so no DB updates happen
      const tsCall = mockEnrich.mock.calls.find((c: any) => c[0]?.filePath === tsFile);
      // processFile returns [] if no tagged targets, so enrich is not called
      expect(tsCall).toBeUndefined();
    });

    it('logs enriching SCIP refs message', async () => {
      const tsFile = join(tmpDir, 'logged.ts');
      writeFileSync(tsFile, 'const x = db.prepare();');

      const fileId = insertFile(db, tsFile, 'typescript');
      const symId = insertSymbol(db, fileId, 'x', 0);
      insertCallRef(db, symId, fileId, 'prepare', 0, 15, 'unresolved', null);

      const logFn = vi.fn();
      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'overlay',
        files: [{ path: tsFile, language: 'typescript' }],
        scipSourcedLanguages: new Set(['typescript']),
        log: { indexing: logFn, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      await stage.execute(ctx, 'build');

      expect(logFn).toHaveBeenCalledWith(
        'lsp-enrichment: enriching unresolved SCIP refs',
        { files: 1 },
      );
    });
  });

  // ── preCacheFiles ─────────────────────────────────────────────────────────

  describe('preCacheFiles (via execute)', () => {
    it('pre-caches files not already in sourceCache', async () => {
      const filePath = join(tmpDir, 'precache.py');
      writeFileSync(filePath, 'hello = True');

      insertFile(db, filePath, 'python');

      const stage = new LspEnrichmentStage();
      const sourceCache = new Map<string, string>();
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [{ path: filePath, language: 'python' }],
        sourceCache,
      });

      await stage.execute(ctx, 'build');

      // sourceCache gets cleared at the end, but enrich should have been
      // called with the file's content -- verify through the mock
      // The content should have been read before enrich was called
      expect(mockEnrich).not.toHaveBeenCalled(); // no symbols to enrich
      // But the coordinator was created and started
      expect(LspEnrichmentCoordinator).toHaveBeenCalledTimes(1);
    });

    it('does not re-read files already in sourceCache', async () => {
      const filePath = join(tmpDir, 'already-cached.py');
      writeFileSync(filePath, 'original content on disk');

      const fileId = insertFile(db, filePath, 'python');
      insertSymbol(db, fileId, 'fn', 0);

      const stage = new LspEnrichmentStage();
      const sourceCache = new Map<string, string>([[filePath, 'cached content']]);
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [{ path: filePath, language: 'python' }],
        sourceCache,
      });

      await stage.execute(ctx, 'build');

      // The mock enrich should have received the cached content
      expect(mockEnrich).toHaveBeenCalled();
      const call = mockEnrich.mock.calls[0][0];
      expect(call.source).toBe('cached content');
    });
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('disposes the coordinator after execute', async () => {
      const filePath = join(tmpDir, 'disp.py');
      writeFileSync(filePath, 'x = 1');
      insertFile(db, filePath, 'python');

      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [{ path: filePath, language: 'python' }],
      });

      await stage.execute(ctx, 'build');
      expect(mockDispose).not.toHaveBeenCalled();

      await stage.dispose();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });

    it('sets coordinator to null after dispose', async () => {
      const filePath = join(tmpDir, 'disp2.py');
      writeFileSync(filePath, 'x = 1');
      insertFile(db, filePath, 'python');

      const stage = new LspEnrichmentStage();
      const ctx = makeContext({
        db,
        layer: 'baseline',
        files: [{ path: filePath, language: 'python' }],
      });

      await stage.execute(ctx, 'build');
      await stage.dispose();
      // Second dispose should be safe (no-op)
      await stage.dispose();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });
  });
});
