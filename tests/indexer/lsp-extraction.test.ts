/**
 * Tests for LspExtractionStage — overlay-mode LSP-driven extraction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type Database } from '../../src/db/schema.js';
import {
  mapLspSymbolKind,
  buildSyntheticId,
} from '../../src/indexer/stages/lsp-extraction.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';

// ── Mock LspEnrichmentCoordinator and enrichProjectRefs before importing the stage ──
const mockDocumentSymbol = vi.fn().mockResolvedValue([]);
const mockOutgoingCalls = vi.fn().mockResolvedValue([]);
const mockDispose = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lsp/enrichment.js', () => ({
  LspEnrichmentCoordinator: class MockCoordinator {
    documentSymbol = mockDocumentSymbol;
    outgoingCalls = mockOutgoingCalls;
    dispose = mockDispose;
  },
}));

vi.mock('../../src/indexer/stages/lsp-enrichment.js', () => ({
  enrichProjectRefs: vi.fn().mockResolvedValue(undefined),
}));

// Must import the stage AFTER the mocks are set up
const { LspExtractionStage } = await import('../../src/indexer/stages/lsp-extraction.js');

function makeContext(db: Database.Database, overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: { rootDir: '/tmp', extensions: ['.ts'], include: ['**/*'], exclude: [] },
    branch: 'main',
    lsp: { enabled: true, requestTimeoutMs: 1000, servers: {} },
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
    layer: 'overlay',
    generation: 0,
    ...overrides,
  };
}

describe('LspExtractionStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: LogLevel.SILENT });
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('skips execution when layer is baseline', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, { layer: 'baseline' });
    await stage.execute(ctx, 'build');
    // No errors, no symbols inserted
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips execution when LSP is disabled', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, { lsp: null });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips execution when LSP enabled is false', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      lsp: { enabled: false, requestTimeoutMs: 1000, servers: {} },
    });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips execution when no changed files', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, { changedFiles: [] });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips files not in sourceCache', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/missing.ts'],
      files: [{ path: '/tmp/missing.ts', language: 'typescript' }],
    });
    // sourceCache is empty, so this file should be skipped
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips files without a matching entry in context.files', async () => {
    const stage = new LspExtractionStage();
    const cache = new Map<string, string>();
    cache.set('/tmp/orphan.ts', 'const x = 1;');
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/orphan.ts'],
      files: [], // no matching file entry
      sourceCache: cache,
    });
    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('has a name', () => {
    const stage = new LspExtractionStage();
    expect(stage.name).toBe('lsp-extraction');
  });

  it('dispose is a no-op', async () => {
    const stage = new LspExtractionStage();
    await expect(stage.dispose()).resolves.toBeUndefined();
  });
});

// ─── mapLspSymbolKind ─────────────────────────────────────────────────────────

describe('mapLspSymbolKind', () => {
  const cases: Array<[number, string, string]> = [
    [5, 'class', 'Class'],
    [6, 'method', 'Method'],
    [9, 'constructor', 'Constructor'],
    [10, 'enum', 'Enum'],
    [11, 'interface', 'Interface'],
    [12, 'function', 'Function'],
    [13, 'variable', 'Variable'],
    [14, 'constant', 'Constant'],
    [7, 'property', 'Property'],
    [8, 'property', 'Field'],
    [22, 'enum_member', 'EnumMember'],
    [23, 'class', 'Struct'],
    [15, 'type_alias', 'TypeParameter'],
    [2, 'module', 'Module'],
    [3, 'module', 'Namespace'],
    [4, 'module', 'Package'],
    [25, 'method', 'Operator'],
  ];

  for (const [kind, expected, label] of cases) {
    it(`maps ${label} (${kind}) to '${expected}'`, () => {
      expect(mapLspSymbolKind(kind)).toBe(expected);
    });
  }

  it('defaults to variable for unknown kinds', () => {
    expect(mapLspSymbolKind(99)).toBe('variable');
    expect(mapLspSymbolKind(0)).toBe('variable');
    expect(mapLspSymbolKind(-1)).toBe('variable');
  });
});

// ─── buildSyntheticId ─────────────────────────────────────────────────────────

describe('buildSyntheticId', () => {
  it('builds ID for top-level symbol', () => {
    const id = buildSyntheticId('/src/app.ts', [], 'main', 12);
    expect(id).toBe('lsp:/src/app.ts/main(12)');
  });

  it('builds ID for nested symbol (method in class)', () => {
    const id = buildSyntheticId('/src/app.ts', ['MyClass'], 'doWork', 6);
    expect(id).toBe('lsp:/src/app.ts/MyClass.doWork(6)');
  });

  it('builds ID for deeply nested symbol', () => {
    const id = buildSyntheticId('/src/app.ts', ['Outer', 'Inner'], 'deepMethod', 6);
    expect(id).toBe('lsp:/src/app.ts/Outer.Inner.deepMethod(6)');
  });

  it('disambiguates overloaded names by kind', () => {
    const fnId = buildSyntheticId('/src/app.ts', [], 'add', 12);
    const varId = buildSyntheticId('/src/app.ts', [], 'add', 13);
    expect(fnId).not.toBe(varId);
    expect(fnId).toContain('(12)');
    expect(varId).toContain('(13)');
  });
});

// ─── LspExtractionStage.execute with mocked coordinator ──────────────────────

describe('LspExtractionStage.execute with mocked coordinator', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: LogLevel.SILENT });
    db = openDb(':memory:');
    // Reset mocks between tests
    mockDocumentSymbol.mockReset().mockResolvedValue([]);
    mockOutgoingCalls.mockReset().mockResolvedValue([]);
    mockDispose.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts symbols from documentSymbol results', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/app.ts', 'main', 'typescript', 'function main() {}', 'overlay', 0)",
    ).run();

    mockDocumentSymbol.mockResolvedValue([
      {
        name: 'main',
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
        children: [],
      },
    ]);

    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/app.ts'],
      files: [{ path: '/tmp/app.ts', language: 'typescript' }],
      sourceCache: new Map([['/tmp/app.ts', 'function main() {}']]),
    });

    await stage.execute(ctx, 'update');

    const symbols = db.prepare('SELECT name, kind FROM symbols').all() as Array<{ name: string; kind: string }>;
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    expect(symbols.some(s => s.name === 'main' && s.kind === 'function')).toBe(true);
  });

  it('inserts nested symbols with parent_symbol_id', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/cls.ts', 'main', 'typescript', 'class Foo { bar() {} }', 'overlay', 0)",
    ).run();

    mockDocumentSymbol.mockResolvedValue([
      {
        name: 'Foo',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 23 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
        children: [
          {
            name: 'bar',
            kind: 6,
            range: { start: { line: 0, character: 12 }, end: { line: 0, character: 21 } },
            selectionRange: { start: { line: 0, character: 12 }, end: { line: 0, character: 15 } },
            children: [],
          },
        ],
      },
    ]);

    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/cls.ts'],
      files: [{ path: '/tmp/cls.ts', language: 'typescript' }],
      sourceCache: new Map([['/tmp/cls.ts', 'class Foo { bar() {} }']]),
    });

    await stage.execute(ctx, 'update');

    const symbols = db.prepare('SELECT name, kind, parent_symbol_id FROM symbols').all() as Array<{
      name: string;
      kind: string;
      parent_symbol_id: number | null;
    }>;
    expect(symbols.length).toBe(2);
    const foo = symbols.find(s => s.name === 'Foo');
    const bar = symbols.find(s => s.name === 'bar');
    expect(foo).toBeDefined();
    expect(bar).toBeDefined();
    expect(bar!.parent_symbol_id).not.toBeNull();
  });

  it('inserts call refs from outgoing calls', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/caller.ts', 'main', 'typescript', 'function caller() { helper(); }', 'overlay', 0)",
    ).run();

    mockDocumentSymbol.mockResolvedValue([
      {
        name: 'caller',
        kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 32 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
        children: [],
      },
    ]);
    mockOutgoingCalls.mockResolvedValue([
      {
        to: {
          name: 'helper',
          uri: 'file:///tmp/helper.ts',
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
        },
        fromRanges: [
          { start: { line: 0, character: 20 }, end: { line: 0, character: 26 } },
        ],
      },
    ]);

    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/caller.ts'],
      files: [{ path: '/tmp/caller.ts', language: 'typescript' }],
      sourceCache: new Map([['/tmp/caller.ts', 'function caller() { helper(); }']]),
    });

    await stage.execute(ctx, 'update');

    const refs = db.prepare('SELECT callee_name, resolution_method FROM symbol_refs').all() as Array<{
      callee_name: string;
      resolution_method: string;
    }>;
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some(r => r.callee_name === 'helper' && r.resolution_method === 'lsp_call_hierarchy')).toBe(true);
  });

  it('skips files without file_id in DB', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/no-file-row.ts'],
      files: [{ path: '/tmp/no-file-row.ts', language: 'typescript' }],
      sourceCache: new Map([['/tmp/no-file-row.ts', 'const x = 1;']]),
    });

    await stage.execute(ctx, 'update');
    // documentSymbol shouldn't be called since file_id lookup fails
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });

  it('skips when documentSymbol returns empty', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/empty.ts', 'main', 'typescript', '', 'overlay', 0)",
    ).run();

    mockDocumentSymbol.mockResolvedValue([]);

    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      changedFiles: ['/tmp/empty.ts'],
      files: [{ path: '/tmp/empty.ts', language: 'typescript' }],
      sourceCache: new Map([['/tmp/empty.ts', '']]),
    });

    await stage.execute(ctx, 'update');
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt;
    expect(count).toBe(0);
  });
});
