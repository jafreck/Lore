/**
 * Tests for pipeline stage layer guards and overlay mode entry points.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/db/schema.js';
import { ScipIndexerStage } from '../../src/indexer/stages/scip-indexer.js';
import { LspEnrichmentStage, enrichProjectRefs } from '../../src/indexer/stages/lsp-enrichment.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import type Database from 'better-sqlite3';

function makeContext(db: Database.Database, overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp' },
    branch: 'HEAD',
    lsp: null,
    scip: { enabled: true, timeoutMs: 120_000, indexers: {}, indexDir: null },
    embedder: null,
    log: initLogger({ level: LogLevel.SILENT }),
    files: [],
    indexDependencies: false,
    history: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    changedDocPaths: [],
    sourceCache: new Map(),
    layer: 'baseline',
    generation: 1,
    ...overrides,
  };
}

describe('ScipIndexerStage — overlay guard', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should skip entirely when layer is overlay', async () => {
    db = openDb(':memory:');
    const stage = new ScipIndexerStage();
    const ctx = makeContext(db, { layer: 'overlay' });

    // This should return immediately without trying to load SCIP indexes
    await stage.execute(ctx, 'update');

    // No files should have been indexed
    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('should skip when SCIP is disabled', async () => {
    db = openDb(':memory:');
    const stage = new ScipIndexerStage();
    const ctx = makeContext(db, { scip: null });

    await stage.execute(ctx, 'build');

    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });
});

describe('LspEnrichmentStage — baseline/overlay behavior', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should skip when LSP is disabled', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const ctx = makeContext(db, { lsp: null, layer: 'overlay' });

    // Should not throw
    await stage.execute(ctx, 'update');
    await stage.dispose?.();
  });

  it('should skip when no files to enrich', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const ctx = makeContext(db, {
      lsp: { enabled: true, languages: {} },
      layer: 'overlay',
      files: [],
    });

    // Should not throw
    await stage.execute(ctx, 'update');
    await stage.dispose?.();
  });

  it('should return early in baseline mode for SCIP-covered languages', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const ctx = makeContext(db, {
      lsp: { enabled: true, languages: {} },
      layer: 'baseline',
      files: [{ path: '/a.ts', language: 'typescript' }],
      scipSourcedLanguages: new Set(['typescript']),
      scipCoveredLanguages: new Set(['typescript']),
    });

    // Should return early (no non-SCIP files)
    await stage.execute(ctx, 'build');
    await stage.dispose?.();
  });

  it('should log and return early when both non-SCIP and SCIP file lists are empty in overlay mode', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const log = initLogger({ level: LogLevel.SILENT });
    const ctx = makeContext(db, {
      lsp: { enabled: true, languages: {} },
      layer: 'overlay',
      files: [{ path: '/a.ts', language: 'typescript' }],
      scipSourcedLanguages: new Set(['typescript']),
      scipCoveredLanguages: new Set(['typescript']),
    });
    // All files are SCIP-covered in overlay mode — but since they're scip-sourced
    // they go to scipFiles. Test the case where enrichUnresolvedScipRefs is called.
    await stage.execute(ctx, 'update');
    await stage.dispose?.();
  });

  it('should dispose safely when coordinator was never created', async () => {
    const stage = new LspEnrichmentStage();
    // dispose should be safe even if execute was never called
    await stage.dispose();
    // No error means success
  });

  it('should handle overlay mode with non-SCIP files', async () => {
    db = openDb(':memory:');
    const stage = new LspEnrichmentStage();
    const tmpRoot = mkdtempSync(join(tmpdir(), 'lore-lsp-test-'));
    writeFileSync(join(tmpRoot, 'file.py'), 'def hello(): pass\n', 'utf8');

    const ctx = makeContext(db, {
      lsp: {
        enabled: true,
        languages: {},
        requestTimeoutMs: 500,
        servers: {},
      },
      layer: 'overlay',
      walkerConfig: { rootDir: tmpRoot },
      files: [{ path: join(tmpRoot, 'file.py'), language: 'python' }],
      scipSourcedLanguages: new Set(),
      scipCoveredLanguages: new Set(),
    });

    // This will try to start the LspEnrichmentCoordinator with python
    // It may fail to find a python LSP server, but should not throw
    await stage.execute(ctx, 'update');
    await stage.dispose?.();
  });
});

describe('enrichProjectRefs', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should handle files that do not exist on disk', async () => {
    db = openDb(':memory:');
    const mockCoordinator = {
      start: vi.fn(async () => new Set()),
      enrich: vi.fn(() => []),
      dispose: vi.fn(async () => {}),
      coveredLanguages: new Set(),
    };

    // enrichProjectRefs with a non-existent file should just skip it
    await enrichProjectRefs(
      db,
      'HEAD',
      [{ path: '/nonexistent/file.ts', language: 'typescript' }],
      mockCoordinator as any,
      new Map(),
    );

    // Should not have called enrich since the file doesn't exist on disk
    expect(mockCoordinator.enrich).not.toHaveBeenCalled();
  });

  it('should use sourceCache when available', async () => {
    db = openDb(':memory:');
    const tmpRoot = mkdtempSync(join(tmpdir(), 'lore-enrich-cache-'));
    const filePath = join(tmpRoot, 'cached.ts');
    writeFileSync(filePath, 'export const x = 1;\n', 'utf8');

    // Insert a file record and a symbol
    db.exec(`INSERT INTO files (path, branch, language, last_hash) VALUES ('${filePath}', 'HEAD', 'typescript', 'abc')`);
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number }).id;
    db.exec(`INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line) VALUES (${fileId}, 'x', 'variable', 'const x', 1, 1)`);

    const mockCoordinator = {
      start: vi.fn(async () => new Set()),
      enrich: vi.fn(() => [null]),
      dispose: vi.fn(async () => {}),
      coveredLanguages: new Set(),
    };

    const sourceCache = new Map<string, string>();
    sourceCache.set(filePath, 'export const x = 1;\n');

    await enrichProjectRefs(
      db,
      'HEAD',
      [{ path: filePath, language: 'typescript' }],
      mockCoordinator as any,
      sourceCache,
    );

    // Should have called enrich since the file has symbols
    expect(mockCoordinator.enrich).toHaveBeenCalled();
  });

  it('should apply updates when coordinator returns metadata', async () => {
    db = openDb(':memory:');
    const tmpRoot = mkdtempSync(join(tmpdir(), 'lore-enrich-update-'));
    const filePath = join(tmpRoot, 'update.ts');
    writeFileSync(filePath, 'export function greet(): string { return "hi"; }\n', 'utf8');

    db.exec(`INSERT INTO files (path, branch, language, last_hash) VALUES ('${filePath}', 'HEAD', 'typescript', 'def')`);
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number }).id;
    db.exec(`INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line) VALUES (${fileId}, 'greet', 'function', 'function greet(): string', 1, 1)`);


    const mockCoordinator = {
      start: vi.fn(async () => new Set()),
      enrich: vi.fn(() => [{
        resolvedTypeSignature: '() => string',
        resolvedReturnType: 'string',
        definitionUri: 'file:///test',
        definitionPath: filePath,
        definitionLine: 1,
        definitionCharacter: 16,
      }]),
      dispose: vi.fn(async () => {}),
      coveredLanguages: new Set(),
    };

    await enrichProjectRefs(
      db,
      'HEAD',
      [{ path: filePath, language: 'typescript' }],
      mockCoordinator as any,
    );

    // Verify the symbol was updated
    const symbol = db.prepare('SELECT resolved_type_signature, resolved_return_type, definition_path FROM symbols WHERE name = ?').get('greet') as any;
    expect(symbol.resolved_type_signature).toBe('() => string');
    expect(symbol.resolved_return_type).toBe('string');
    expect(symbol.definition_path).toBe(filePath);
  });

  it('should update callRef, typeRef, and relationship rows', async () => {
    db = openDb(':memory:');
    const tmpRoot = mkdtempSync(join(tmpdir(), 'lore-enrich-refs-'));
    const filePath = join(tmpRoot, 'refs.ts');
    writeFileSync(filePath, 'export function caller() { callee(); }\n', 'utf8');

    // Insert file and symbols
    db.exec(`INSERT INTO files (path, branch, language, last_hash) VALUES ('${filePath}', 'HEAD', 'typescript', 'x')`);
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number }).id;
    db.exec(`INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (${fileId}, 'caller', 'function', 1, 1)`);
    db.exec(`INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (${fileId}, 'callee', 'function', 2, 2)`);
    const callerId = (db.prepare("SELECT id FROM symbols WHERE name = 'caller'").get() as { id: number }).id;
    const calleeId = (db.prepare("SELECT id FROM symbols WHERE name = 'callee'").get() as { id: number }).id;

    // Insert a symbol_ref (call ref)
    db.exec(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method) VALUES (${callerId}, ${fileId}, ${calleeId}, 'callee', 1, 5, 'direct', 'unresolved')`);
    const refId = (db.prepare('SELECT id FROM symbol_refs LIMIT 1').get() as { id: number }).id;

    // Insert a type_ref
    db.exec(`INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method) VALUES (${fileId}, ${callerId}, ${calleeId}, 'MyType', 'MyType', 'type_annotation', 1, 10, 'unresolved')`);
    const typeRefId = (db.prepare('SELECT id FROM type_refs LIMIT 1').get() as { id: number }).id;

    // Insert a relationship
    db.exec(`INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method) VALUES (${fileId}, ${callerId}, ${calleeId}, 'callee', 'extends', 1, 0, 'unresolved')`);
    const relId = (db.prepare('SELECT id FROM symbol_relationships LIMIT 1').get() as { id: number }).id;

    const enrichResult = {
      resolvedTypeSignature: '() => void',
      resolvedReturnType: 'void',
      definitionUri: 'file:///test/refs.ts',
      definitionPath: filePath,
      definitionLine: 2,
      definitionCharacter: 0,
    };

    const mockCoordinator = {
      start: vi.fn(async () => new Set()),
      // Return results parallel to tagged: [symbol, symbol, callRef, typeRef, relationship]
      enrich: vi.fn(() => [null, null, enrichResult, enrichResult, enrichResult]),
      dispose: vi.fn(async () => {}),
      coveredLanguages: new Set(),
    };

    await enrichProjectRefs(
      db,
      'HEAD',
      [{ path: filePath, language: 'typescript' }],
      mockCoordinator as any,
    );

    // Verify callRef was updated
    const ref = db.prepare('SELECT resolved_type_signature, definition_path, definition_line FROM symbol_refs WHERE id = ?').get(refId) as any;
    expect(ref.resolved_type_signature).toBe('() => void');
    expect(ref.definition_path).toBe(filePath);
    expect(ref.definition_line).toBe(2);

    // Verify typeRef was updated
    const tref = db.prepare('SELECT resolved_type_signature, definition_path, definition_line FROM type_refs WHERE id = ?').get(typeRefId) as any;
    expect(tref.resolved_type_signature).toBe('() => void');
    expect(tref.definition_path).toBe(filePath);

    // Verify relationship was updated
    const rel = db.prepare('SELECT definition_uri, definition_path, definition_line FROM symbol_relationships WHERE id = ?').get(relId) as any;
    expect(rel.definition_uri).toBe('file:///test/refs.ts');
    expect(rel.definition_path).toBe(filePath);
    expect(rel.definition_line).toBe(2);
  });
});
