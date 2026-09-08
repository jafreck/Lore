/**
 * Tests for LspExtractionStage — overlay-mode LSP-driven extraction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type Database } from '../../src/db/schema.js';
import {
  mapLspSymbolKind,
  buildSyntheticId,
  extractPreprocessorMacros,
} from '../../src/indexer/stages/lsp-extraction.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';
import { effectiveLspSettings } from '../helpers/effective-settings.js';
import {
  dropStagingEffectiveViews,
  installStagingEffectiveViews,
} from '../../src/indexer/staging-views.js';

// ── Mock LspEnrichmentCoordinator and enrichProjectRefs before importing the stage ──
const mockDocumentSymbol = vi.fn().mockResolvedValue([]);
const mockOutgoingCalls = vi.fn().mockResolvedValue([]);
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockDispose = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lsp/enrichment.js', () => ({
  LspEnrichmentCoordinator: class MockCoordinator {
    start = mockStart;
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
    walkerConfig: { rootDir: '/tmp', extensions: ['.ts'], includeGlobs: ['**/*'], excludeGlobs: [] },
    branch: 'main',
    lsp: effectiveLspSettings(),
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
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
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
      lsp: effectiveLspSettings({ enabled: false }),
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

  it('disambiguates same-kind overloads by source position and signature', () => {
    const first = buildSyntheticId('/src/app.cpp', [], 'add', 12, {
      line: 4, character: 5, signature: 'int add(int)',
    });
    const second = buildSyntheticId('/src/app.cpp', [], 'add', 12, {
      line: 5, character: 5, signature: 'double add(double)',
    });
    expect(first).not.toBe(second);
  });
});

describe('extractPreprocessorMacros', () => {
  it('extracts object-like, function-like, and continued definitions', () => {
    const source = [
      '#define VERSION 7',
      '#define SQUARE(x) ((x) * (x))',
      '#define CHECK(x) \\',
      '  do { consume(x); } while (0)',
      '/* #define COMMENTED_OUT 1 */',
      '// #define ALSO_COMMENTED_OUT 1',
    ].join('\n');

    expect(extractPreprocessorMacros(source)).toEqual([
      expect.objectContaining({
        name: 'VERSION', startLine: 0, endLine: 0,
        signature: '#define VERSION 7', conditional: false, heuristic: false,
      }),
      expect.objectContaining({
        name: 'SQUARE', startLine: 1, endLine: 1,
        signature: '#define SQUARE(x) ((x) * (x))', conditional: false, heuristic: false,
      }),
      expect.objectContaining({
        name: 'CHECK', startLine: 2, endLine: 3,
        signature: '#define CHECK(x) \\\n  do { consume(x); } while (0)', conditional: false, heuristic: false,
      }),
    ]);
  });
});

// ─── LspExtractionStage.execute with mocked coordinator ──────────────────────

describe('LspExtractionStage.execute with mocked coordinator', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: LogLevel.SILENT });
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
    // Reset mocks between tests
    mockDocumentSymbol.mockReset().mockResolvedValue([]);
    mockOutgoingCalls.mockReset().mockResolvedValue([]);
    mockStart.mockReset().mockResolvedValue(undefined);
    mockDispose.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
  });

  it('extracts baseline symbols from files that SCIP did not source', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/fallback.c', 'main', 'c', 'int fallback(void) { return 1; }', 'baseline', 1)",
    ).run();
    mockDocumentSymbol.mockResolvedValue([{
      name: 'fallback',
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 32 } },
      selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 12 } },
      children: [],
    }]);

    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      layer: 'baseline',
      generation: 1,
      walkerConfig: { rootDir: '/tmp' },
      files: [{ path: '/tmp/fallback.c', language: 'c' }],
      sourceCache: new Map([['/tmp/fallback.c', 'int fallback(void) { return 1; }']]),
      scipSourcedFiles: new Set(),
    });

    await stage.execute(ctx, 'build');

    const symbol = db.prepare("SELECT name, kind, layer FROM symbols WHERE name = 'fallback'").get();
    expect(symbol).toMatchObject({ name: 'fallback', kind: 'function', layer: 'baseline' });
  });

  it('targets the exact hidden baseline generation when an older path coexists', async () => {
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source, layer, generation)
       VALUES (1, '/tmp/fallback.c', 'main', 'c', 'old', 'baseline', 1),
              (2, '/tmp/fallback.c', 'main', 'c', 'int candidate;', 'baseline', 2)`,
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
    installStagingEffectiveViews(db, 'main', 2);
    mockDocumentSymbol.mockResolvedValue([{
      name: 'candidate',
      kind: 13,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 14 } },
      selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 13 } },
      children: [],
    }]);

    try {
      await new LspExtractionStage().execute(makeContext(db, {
        layer: 'baseline',
        generation: 2,
        walkerConfig: { rootDir: '/tmp' },
        files: [{ path: '/tmp/fallback.c', language: 'c' }],
        sourceCache: new Map([['/tmp/fallback.c', 'int candidate;']]),
        scipSourcedFiles: new Set(),
      }), 'build');
      expect(db.prepare("SELECT file_id FROM symbols WHERE name = 'candidate'").get())
        .toEqual({ file_id: 2 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM symbols WHERE file_id = 1').get())
        .toEqual({ count: 0 });
    } finally {
      dropStagingEffectiveViews(db);
    }
  });

  it('refines spans without duplicating baseline files already sourced by SCIP', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/covered.c', 'main', 'c', 'int covered(void) { return 1; }', 'baseline', 1)",
    ).run();
    db.prepare(
      "INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation) VALUES (1, 'covered', 'function', 0, 0, 'baseline', 1)",
    ).run();
    mockDocumentSymbol.mockResolvedValue([{
      name: 'covered',
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 11 } },
      children: [],
    }]);

    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      layer: 'baseline',
      files: [{ path: '/tmp/covered.c', language: 'c' }],
      sourceCache: new Map([['/tmp/covered.c', 'int covered(void);']]),
      scipSourcedFiles: new Set(['/tmp/covered.c']),
    });

    await stage.execute(ctx, 'build');
    expect(mockDocumentSymbol).toHaveBeenCalledOnce();
    const symbols = db.prepare("SELECT name, start_line, end_line FROM symbols WHERE name = 'covered'").all();
    expect(symbols).toEqual([{ name: 'covered', start_line: 0, end_line: 2 }]);
  });

  it('does not overwrite a valid SCIP multiline span while repairing another symbol in the file', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/mixed.cpp', 'main', 'cpp', '', 'baseline', 1)",
    ).run();
    db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, start_character, end_line,
         end_character, selection_line, selection_character, layer, generation)
       VALUES (1, 'valid', 'function', 0, 0, 5, 1, 0, 4, 'baseline', 1),
              (1, 'broken', 'function', 10, 0, 10, 20, 10, 4, 'baseline', 1)`,
    ).run();
    mockDocumentSymbol.mockResolvedValue([
      {
        name: 'valid', kind: 12,
        range: { start: { line: 0, character: 0 }, end: { line: 8, character: 1 } },
        selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
        children: [],
      },
      {
        name: 'broken', kind: 12,
        range: { start: { line: 10, character: 0 }, end: { line: 12, character: 1 } },
        selectionRange: { start: { line: 10, character: 4 }, end: { line: 10, character: 10 } },
        children: [],
      },
    ]);

    const stage = new LspExtractionStage();
    await stage.execute(makeContext(db, {
      layer: 'baseline',
      generation: 1,
      files: [{ path: '/tmp/mixed.cpp', language: 'cpp' }],
      sourceCache: new Map([['/tmp/mixed.cpp', 'source']]),
      scipSourcedFiles: new Set(['/tmp/mixed.cpp']),
    }), 'build');

    expect(db.prepare('SELECT name, start_line, end_line FROM symbols ORDER BY id').all()).toEqual([
      { name: 'valid', start_line: 0, end_line: 5 },
      { name: 'broken', start_line: 10, end_line: 12 },
    ]);
  });

  it('fails strict baseline supplementation instead of silently applying a file cap', async () => {
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source, layer, generation)
       VALUES (1, '/tmp/a.py', 'main', 'python', '', 'baseline', 1),
              (2, '/tmp/b.py', 'main', 'python', '', 'baseline', 1)`,
    ).run();
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      layer: 'baseline',
      files: [
        { path: '/tmp/a.py', language: 'python' },
        { path: '/tmp/b.py', language: 'python' },
      ],
      sourceCache: new Map([['/tmp/a.py', ''], ['/tmp/b.py', '']]),
      scipSourcedFiles: new Set(),
      lsp: effectiveLspSettings({
        supplementation: { maxFiles: 1, fileConcurrency: 2, strict: true },
      }),
    });

    await expect(stage.execute(ctx, 'build')).rejects.toThrow('strict maxFiles cap');
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('pipelines baseline document requests within configured file concurrency', async () => {
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source, layer, generation)
       VALUES (1, '/tmp/a.py', 'main', 'python', '', 'baseline', 1),
              (2, '/tmp/b.py', 'main', 'python', '', 'baseline', 1),
              (3, '/tmp/c.py', 'main', 'python', '', 'baseline', 1)`,
    ).run();
    let active = 0;
    let maximumActive = 0;
    mockDocumentSymbol.mockImplementation(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      return [];
    });
    const stage = new LspExtractionStage();
    await stage.execute(makeContext(db, {
      layer: 'baseline',
      files: ['/tmp/a.py', '/tmp/b.py', '/tmp/c.py'].map((path) => ({
        path,
        language: 'python',
      })),
      sourceCache: new Map([
        ['/tmp/a.py', ''],
        ['/tmp/b.py', ''],
        ['/tmp/c.py', ''],
      ]),
      scipSourcedFiles: new Set(),
      lsp: effectiveLspSettings({
        supplementation: { maxFiles: 10, fileConcurrency: 2, strict: false },
      }),
    }), 'build');

    expect(mockDocumentSymbol).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(2);
  });

  it('falls back when a SCIP-sourced document has no usable symbols', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/empty-scip.h', 'main', 'c', 'int declared(void);', 'baseline', 1)",
    ).run();
    mockDocumentSymbol.mockResolvedValue([{
      name: 'declared',
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 19 } },
      selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 12 } },
      children: [],
    }]);

    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      layer: 'baseline',
      generation: 1,
      walkerConfig: { rootDir: '/tmp' },
      files: [{ path: '/tmp/empty-scip.h', language: 'c' }],
      sourceCache: new Map([['/tmp/empty-scip.h', 'int declared(void);']]),
      scipSourcedFiles: new Set(['/tmp/empty-scip.h']),
    });

    await stage.execute(ctx, 'build');
    expect(db.prepare("SELECT name, kind FROM symbols WHERE name = 'declared'").get())
      .toEqual({ name: 'declared', kind: 'function' });
  });

  it('does not reconcile SCIP-sourced baseline files outside C and C++', async () => {
    const stage = new LspExtractionStage();
    const ctx = makeContext(db, {
      layer: 'baseline',
      files: [{ path: '/tmp/covered.ts', language: 'typescript' }],
      sourceCache: new Map([['/tmp/covered.ts', 'export const covered = 1;']]),
      scipSourcedFiles: new Set(['/tmp/covered.ts']),
    });

    await stage.execute(ctx, 'build');
    expect(mockDocumentSymbol).not.toHaveBeenCalled();
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

  it('deduplicates repeated document symbols before insertion', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/duplicate.ts', 'main', 'typescript', '', 'overlay', 0)",
    ).run();
    const duplicate = {
      name: 'same',
      kind: 12,
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
      detail: 'function same(): void',
      children: [],
    };
    mockDocumentSymbol.mockResolvedValue([duplicate, { ...duplicate }]);

    const stage = new LspExtractionStage();
    await stage.execute(makeContext(db, {
      changedFiles: ['/tmp/duplicate.ts'],
      files: [{ path: '/tmp/duplicate.ts', language: 'typescript' }],
      sourceCache: new Map([['/tmp/duplicate.ts', 'function same() {}']]),
    }), 'update');

    expect(db.prepare("SELECT COUNT(*) AS count FROM symbols WHERE name = 'same'").get())
      .toEqual({ count: 1 });
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

  it('traverses namespace children without inserting the namespace', async () => {
    db.prepare(
      "INSERT INTO files (id, path, branch, language, source, layer, generation) VALUES (1, '/tmp/namespaced.cpp', 'main', 'cpp', 'namespace codec { void run(); }', 'baseline', 1)",
    ).run();
    mockDocumentSymbol.mockResolvedValue([{
      name: 'codec',
      kind: 3,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 31 } },
      selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 15 } },
      children: [{
        name: 'run',
        kind: 12,
        range: { start: { line: 0, character: 18 }, end: { line: 0, character: 29 } },
        selectionRange: { start: { line: 0, character: 23 }, end: { line: 0, character: 26 } },
        children: [],
      }],
    }]);

    const stage = new LspExtractionStage();
    await stage.execute(makeContext(db, {
      layer: 'baseline',
      generation: 1,
      walkerConfig: { rootDir: '/tmp' },
      files: [{ path: '/tmp/namespaced.cpp', language: 'cpp' }],
      sourceCache: new Map([['/tmp/namespaced.cpp', 'namespace codec { void run(); }']]),
    }), 'build');

    expect(db.prepare('SELECT name, kind FROM symbols ORDER BY name').all())
      .toEqual([{ name: 'run', kind: 'function' }]);
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
    expect(refs.some(r => r.callee_name === 'helper' && r.resolution_method === 'unresolved')).toBe(true);
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
