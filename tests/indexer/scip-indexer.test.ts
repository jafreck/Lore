import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb } from '../../src/db/schema.js';
import {
  ScipIndexerStage,
  ScipRefStage,
  createLoreScipTsconfig,
  buildInternalPrefixes,
  isExternalSymbol,
  buildSymbolDefinitionMap,
  buildContainmentIndex,
  findContainingSymbol,
} from '../../src/indexer/stages/scip-indexer.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { getLogger } from '../../src/logger.js';
import { buildScipIndexBuffer, SymbolRole } from '../helpers/scipFixture.js';

// ── Mock loadScipIndexes ────────────────────────────────────────────────────

const { loadScipIndexesMock } = vi.hoisted(() => {
  const loadScipIndexesMock = vi.fn().mockResolvedValue([] as Uint8Array[]);
  return { loadScipIndexesMock };
});

vi.mock('../../src/indexer/stages/scip-helpers/process.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/indexer/stages/scip-helpers/process.js')>();
  return {
    ...mod,
    loadScipIndexes: loadScipIndexesMock,
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scip-test-'));
}

function makeMinimalContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const db = openDb(':memory:');
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: {
      rootDir: tmpDir,
      include: ['**/*'],
      exclude: [],
    } as any,
    branch: 'main',
    lsp: null,
    scip: null,
    embedder: null,
    log: getLogger(),
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

/**
 * Write a source file to disk and pre-populate the sourceCache.
 */
function writeSource(relativePath: string, content: string, cache: Map<string, string>): string {
  const absPath = path.resolve(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  cache.set(absPath, content);
  return absPath;
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = makeTmpDir();
  loadScipIndexesMock.mockReset();
  loadScipIndexesMock.mockResolvedValue([]);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── ScipIndexerStage ────────────────────────────────────────────────────────

describe('ScipIndexerStage', () => {
  it('returns early when scip is null', async () => {
    const stage = new ScipIndexerStage();
    const ctx = makeMinimalContext({ scip: null });
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('returns early when scip is disabled', async () => {
    const stage = new ScipIndexerStage();
    const ctx = makeMinimalContext({ scip: { enabled: false } as any });
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('returns early when layer is overlay', async () => {
    const stage = new ScipIndexerStage();
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      layer: 'overlay',
    });
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('has correct stage name', () => {
    expect(new ScipIndexerStage().name).toBe('scip-indexer');
  });

  it('returns early when loadScipIndexes returns empty', async () => {
    const stage = new ScipIndexerStage();
    loadScipIndexesMock.mockResolvedValue([]);
    const ctx = makeMinimalContext({ scip: { enabled: true } as any });
    await stage.execute(ctx, 'build');
    const count = ctx.db.prepare('SELECT count(*) as c FROM files').get() as any;
    expect(count.c).toBe(0);
    ctx.db.close();
  });

  it('returns early when index has zero documents', async () => {
    const stage = new ScipIndexerStage();
    const buf = buildScipIndexBuffer([]);
    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({ scip: { enabled: true } as any });
    await stage.execute(ctx, 'build');
    const count = ctx.db.prepare('SELECT count(*) as c FROM files').get() as any;
    expect(count.c).toBe(0);
    ctx.db.close();
  });

  it('processes a single document with definition symbols', async () => {
    const stage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();
    const sourceCode = 'function greet(name: string): string {\n  return "Hello " + name;\n}\n';
    writeSource('src/main.ts', sourceCode, sourceCache);

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/main.ts',
      language: 'typescript',
      occurrences: [{
        range: [0, 9, 14],
        symbol: 'scip-typescript npm test-pkg 1.0.0 src/main.ts/greet().',
        symbolRoles: SymbolRole.Definition,
        enclosingRange: [0, 0, 2, 1],
      }],
      symbols: [{
        symbol: 'scip-typescript npm test-pkg 1.0.0 src/main.ts/greet().',
        documentation: ['function greet(name: string): string', 'Greets a person'],
        displayName: 'greet',
      }],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await stage.execute(ctx, 'build');

    // Verify files table
    const files = ctx.db.prepare('SELECT * FROM files').all() as any[];
    expect(files.length).toBe(1);
    expect(files[0].language).toBe('typescript');
    expect(files[0].path).toContain('src/main.ts');

    // Verify symbols table
    const symbols = ctx.db.prepare('SELECT * FROM symbols').all() as any[];
    expect(symbols.length).toBe(1);
    expect(symbols[0].name).toBe('greet');
    expect(symbols[0].kind).toBe('function');
    expect(symbols[0].start_line).toBe(0);
    expect(symbols[0].end_line).toBe(2);
    expect(symbols[0].doc_comment).toBe('Greets a person');

    // Verify enrichment columns populated inline
    expect(symbols[0].resolved_type_signature).toBe('function greet(name: string): string');
    expect(symbols[0].definition_uri).toContain('src/main.ts');
    expect(symbols[0].definition_path).toContain('src/main.ts');

    // Verify context was updated
    expect(ctx.scipSourcedLanguages).toBeDefined();
    expect(ctx.scipSourcedLanguages!.has('typescript')).toBe(true);
    expect(ctx.scipSourcedFiles).toBeDefined();
    expect(ctx.files.length).toBe(1);

    // Verify scipRefData stashed for ScipRefStage
    expect(ctx.scipRefData).toBeDefined();
    expect(ctx.scipRefData!.scipToLoreId.size).toBe(1);

    ctx.db.close();
  });

  it('processes Import-role occurrences into file_imports', async () => {
    const stage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();
    const sourceCode = 'import { helper } from "./helper";\nconsole.log(helper());\n';
    writeSource('src/app.ts', sourceCode, sourceCache);

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/app.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [0, 9, 15],
          symbol: 'scip-typescript npm test-pkg 1.0.0 src/helper.ts/helper().',
          symbolRoles: SymbolRole.Import,
        },
      ],
      symbols: [],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await stage.execute(ctx, 'build');

    const imports = ctx.db.prepare('SELECT * FROM file_imports').all() as any[];
    expect(imports.length).toBe(1);
    expect(imports[0].raw_import).toBeTruthy();

    ctx.db.close();
  });

  it('processes symbol relationships', async () => {
    const stage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();
    const sourceCode = [
      'interface Greeter { greet(): void; }',
      'class FriendlyGreeter implements Greeter {',
      '  greet() { console.log("hi"); }',
      '}',
    ].join('\n');
    writeSource('src/greeter.ts', sourceCode, sourceCache);

    const interfaceSymbol = 'scip-typescript npm test-pkg 1.0.0 src/greeter.ts/Greeter#';
    const classSymbol = 'scip-typescript npm test-pkg 1.0.0 src/greeter.ts/FriendlyGreeter#';

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/greeter.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [0, 10, 17],
          symbol: interfaceSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [0, 0, 0, 36],
        },
        {
          range: [1, 6, 21],
          symbol: classSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [1, 0, 3, 1],
        },
      ],
      symbols: [
        {
          symbol: interfaceSymbol,
          documentation: ['interface Greeter'],
          displayName: 'Greeter',
        },
        {
          symbol: classSymbol,
          documentation: ['class FriendlyGreeter'],
          displayName: 'FriendlyGreeter',
          relationships: [{
            symbol: interfaceSymbol,
            isImplementation: true,
          }],
        },
      ],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await stage.execute(ctx, 'build');

    const rels = ctx.db.prepare('SELECT * FROM symbol_relationships').all() as any[];
    expect(rels.length).toBe(1);
    expect(rels[0].target_symbol_name).toBe('Greeter');
    expect(rels[0].relationship_type).toBe('implements');

    ctx.db.close();
  });

  it('handles multiple documents in one index', async () => {
    const stage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();
    writeSource('src/a.ts', 'export const A = 1;\n', sourceCache);
    writeSource('src/b.ts', 'export const B = 2;\n', sourceCache);

    const buf = buildScipIndexBuffer([
      {
        relativePath: 'src/a.ts',
        language: 'typescript',
        occurrences: [{
          range: [0, 13, 14],
          symbol: 'scip-typescript npm test-pkg 1.0.0 src/a.ts/A.',
          symbolRoles: SymbolRole.Definition,
        }],
        symbols: [{
          symbol: 'scip-typescript npm test-pkg 1.0.0 src/a.ts/A.',
          documentation: ['const A: number'],
          displayName: 'A',
        }],
      },
      {
        relativePath: 'src/b.ts',
        language: 'typescript',
        occurrences: [{
          range: [0, 13, 14],
          symbol: 'scip-typescript npm test-pkg 1.0.0 src/b.ts/B.',
          symbolRoles: SymbolRole.Definition,
        }],
        symbols: [{
          symbol: 'scip-typescript npm test-pkg 1.0.0 src/b.ts/B.',
          documentation: ['const B: number'],
          displayName: 'B',
        }],
      },
    ]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await stage.execute(ctx, 'build');

    const fileCount = (ctx.db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(fileCount).toBe(2);
    const symCount = (ctx.db.prepare('SELECT count(*) as c FROM symbols').get() as any).c;
    expect(symCount).toBe(2);
    expect(ctx.files.length).toBe(2);

    ctx.db.close();
  });

  it('in update mode skips when no SCIP-supported languages changed', async () => {
    const stage = new ScipIndexerStage();
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      changedFiles: ['README.md'],
    });
    await stage.execute(ctx, 'update');
    expect(loadScipIndexesMock).not.toHaveBeenCalled();
    ctx.db.close();
  });

  it('in update mode processes stale SCIP-supported languages', async () => {
    const stage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();
    writeSource('src/main.ts', 'const x = 1;\n', sourceCache);

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/main.ts',
      language: 'typescript',
      occurrences: [{
        range: [0, 6, 7],
        symbol: 'scip-typescript npm test-pkg 1.0.0 src/main.ts/x.',
        symbolRoles: SymbolRole.Definition,
      }],
      symbols: [{
        symbol: 'scip-typescript npm test-pkg 1.0.0 src/main.ts/x.',
        displayName: 'x',
      }],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
      changedFiles: ['src/main.ts'],
    });
    await stage.execute(ctx, 'update');
    expect(loadScipIndexesMock).toHaveBeenCalled();
    const callArgs = loadScipIndexesMock.mock.calls[0];
    expect(callArgs[2]).toBeInstanceOf(Set);
    expect(callArgs[2].has('typescript')).toBe(true);

    ctx.db.close();
  });

  it('resolves parent_symbol_id from SCIP descriptor chain', async () => {
    const stage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();
    writeSource('src/cls.ts', 'class Foo {\n  bar() {}\n}\n', sourceCache);

    const classSymbol = 'scip-typescript npm test-pkg 1.0.0 src/cls.ts/Foo#';
    const methodSymbol = 'scip-typescript npm test-pkg 1.0.0 src/cls.ts/Foo#bar().';

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/cls.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [0, 6, 9],
          symbol: classSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [0, 0, 2, 1],
        },
        {
          range: [1, 2, 5],
          symbol: methodSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [1, 2, 1, 12],
        },
      ],
      symbols: [
        { symbol: classSymbol, documentation: ['class Foo'], displayName: 'Foo' },
        { symbol: methodSymbol, documentation: ['method bar(): void'], displayName: 'bar' },
      ],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await stage.execute(ctx, 'build');

    const symbols = ctx.db.prepare('SELECT id, name, parent_symbol_id FROM symbols ORDER BY start_line').all() as any[];
    expect(symbols.length).toBe(2);
    const fooSym = symbols.find((s: any) => s.name === 'Foo');
    const barSym = symbols.find((s: any) => s.name === 'bar');
    expect(fooSym.parent_symbol_id).toBeNull();
    expect(barSym.parent_symbol_id).toBe(fooSym.id);

    ctx.db.close();
  });

  it('skips documents whose files cannot be read', async () => {
    const stage = new ScipIndexerStage();
    const buf = buildScipIndexBuffer([{
      relativePath: 'src/missing.ts',
      language: 'typescript',
      occurrences: [{
        range: [0, 0, 5],
        symbol: 'scip-typescript npm test-pkg 1.0.0 src/missing.ts/x.',
        symbolRoles: SymbolRole.Definition,
      }],
      symbols: [{
        symbol: 'scip-typescript npm test-pkg 1.0.0 src/missing.ts/x.',
        displayName: 'x',
      }],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({ scip: { enabled: true } as any });
    await stage.execute(ctx, 'build');
    const count = (ctx.db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(count).toBe(0);
    ctx.db.close();
  });

  it('skips occurrences with local symbols', async () => {
    const stage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();
    writeSource('src/loc.ts', 'let x = 1;\n', sourceCache);

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/loc.ts',
      language: 'typescript',
      occurrences: [{
        range: [0, 4, 5],
        symbol: 'local 0',
        symbolRoles: SymbolRole.Definition,
      }],
      symbols: [],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await stage.execute(ctx, 'build');

    const fileCount = (ctx.db.prepare('SELECT count(*) as c FROM files').get() as any).c;
    expect(fileCount).toBe(1);
    const symCount = (ctx.db.prepare('SELECT count(*) as c FROM symbols').get() as any).c;
    expect(symCount).toBe(0);

    ctx.db.close();
  });

  it('dispose does not throw', async () => {
    const stage = new ScipIndexerStage();
    await expect(stage.dispose()).resolves.toBeUndefined();
  });
});

// ── ScipRefStage ────────────────────────────────────────────────────────────

describe('ScipRefStage', () => {
  it('returns early when scipRefData is undefined', async () => {
    const stage = new ScipRefStage();
    const ctx = makeMinimalContext();
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('has correct stage name', () => {
    expect(new ScipRefStage().name).toBe('ScipRefStage');
  });

  it('dispose does not throw', async () => {
    const stage = new ScipRefStage();
    await expect(stage.dispose()).resolves.toBeUndefined();
  });

  it('inserts call refs from SCIP reference occurrences', async () => {
    const indexerStage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();

    const sourceCode = [
      'function caller() {',
      '  callee();',
      '}',
      'function callee() {',
      '  return 42;',
      '}',
    ].join('\n');
    writeSource('src/refs.ts', sourceCode, sourceCache);

    const callerSymbol = 'scip-typescript npm test-pkg 1.0.0 src/refs.ts/caller().';
    const calleeSymbol = 'scip-typescript npm test-pkg 1.0.0 src/refs.ts/callee().';

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/refs.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [0, 9, 15],
          symbol: callerSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [0, 0, 2, 1],
        },
        {
          range: [3, 9, 15],
          symbol: calleeSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [3, 0, 5, 1],
        },
        {
          range: [1, 2, 8],
          symbol: calleeSymbol,
          symbolRoles: 0,
        },
      ],
      symbols: [
        {
          symbol: callerSymbol,
          documentation: ['function caller(): void'],
          displayName: 'caller',
        },
        {
          symbol: calleeSymbol,
          documentation: ['function callee(): number'],
          displayName: 'callee',
        },
      ],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await indexerStage.execute(ctx, 'build');
    expect(ctx.scipRefData).toBeDefined();

    const refStage = new ScipRefStage();
    await refStage.execute(ctx, 'build');

    const refs = ctx.db.prepare('SELECT * FROM symbol_refs').all() as any[];
    expect(refs.length).toBeGreaterThanOrEqual(1);

    const callRef = refs.find((r: any) => r.callee_name === 'callee' || r.callee_name?.includes('callee'));
    if (callRef) {
      expect(callRef.caller_id).toBeTruthy();
      expect(callRef.resolution_method).toBeTruthy();
    }

    expect(ctx.scipRefData).toBeUndefined();

    ctx.db.close();
  });

  it('inserts type refs from SCIP type reference occurrences', async () => {
    const indexerStage = new ScipIndexerStage();
    const sourceCache = new Map<string, string>();

    const sourceCode = [
      'class MyType {}',
      'function use(x: MyType) {',
      '  return x;',
      '}',
    ].join('\n');
    writeSource('src/types.ts', sourceCode, sourceCache);

    const typeSymbol = 'scip-typescript npm test-pkg 1.0.0 src/types.ts/MyType#';
    const funcSymbol = 'scip-typescript npm test-pkg 1.0.0 src/types.ts/use().';

    const buf = buildScipIndexBuffer([{
      relativePath: 'src/types.ts',
      language: 'typescript',
      occurrences: [
        {
          range: [0, 6, 12],
          symbol: typeSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [0, 0, 0, 15],
        },
        {
          range: [1, 9, 12],
          symbol: funcSymbol,
          symbolRoles: SymbolRole.Definition,
          enclosingRange: [1, 0, 3, 1],
        },
        {
          range: [1, 16, 22],
          symbol: typeSymbol,
          symbolRoles: 0,
        },
      ],
      symbols: [
        { symbol: typeSymbol, documentation: ['class MyType'], displayName: 'MyType' },
        { symbol: funcSymbol, documentation: ['function use(x: MyType): MyType'], displayName: 'use' },
      ],
    }]);

    loadScipIndexesMock.mockResolvedValue([buf]);
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      sourceCache,
    });
    await indexerStage.execute(ctx, 'build');

    const refStage = new ScipRefStage();
    await refStage.execute(ctx, 'build');

    const typeRefs = ctx.db.prepare('SELECT * FROM type_refs').all() as any[];
    expect(typeRefs.length).toBeGreaterThanOrEqual(1);
    const myTypeRef = typeRefs.find((r: any) => r.type_name === 'MyType');
    if (myTypeRef) {
      expect(myTypeRef.type_name_bare).toBe('MyType');
    }

    ctx.db.close();
  });
});

// ── createLoreScipTsconfig ──────────────────────────────────────────────────

describe('createLoreScipTsconfig', () => {
  let tsconfigDir: string;

  beforeEach(() => {
    tsconfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-scip-test-'));
  });

  afterEach(() => {
    fs.rmSync(tsconfigDir, { recursive: true, force: true });
  });

  it('returns null when no tsconfig.json exists', () => {
    const result = createLoreScipTsconfig(path.join(os.tmpdir(), 'nonexistent-' + Date.now()));
    expect(result).toBeNull();
  });

  it('generates a temp tsconfig when tsconfig.json exists', () => {
    const tsconfig = {
      compilerOptions: {
        strict: true,
        outDir: './dist',
        rootDir: './src',
        declaration: true,
        target: 'es2020',
      },
      exclude: ['node_modules', 'dist'],
    };
    fs.writeFileSync(path.join(tsconfigDir, 'tsconfig.json'), JSON.stringify(tsconfig));

    const result = createLoreScipTsconfig(tsconfigDir);
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);

    const generated = JSON.parse(fs.readFileSync(result!, 'utf8'));
    expect(generated.compilerOptions.outDir).toBeUndefined();
    expect(generated.compilerOptions.rootDir).toBeUndefined();
    expect(generated.compilerOptions.declaration).toBeUndefined();
    expect(generated.compilerOptions.strict).toBe(true);
    expect(generated.compilerOptions.target).toBe('es2020');
    expect(generated.include).toBeDefined();
    expect(generated.exclude).toBeDefined();

    fs.unlinkSync(result!);
  });

  it('handles tsconfig.json with no compilerOptions', () => {
    fs.writeFileSync(path.join(tsconfigDir, 'tsconfig.json'), JSON.stringify({}));
    const result = createLoreScipTsconfig(tsconfigDir);
    expect(result).not.toBeNull();
    const generated = JSON.parse(fs.readFileSync(result!, 'utf8'));
    expect(generated.compilerOptions).toBeDefined();
    fs.unlinkSync(result!);
  });

  it('returns null for malformed tsconfig.json', () => {
    fs.writeFileSync(path.join(tsconfigDir, 'tsconfig.json'), 'not json!!!');
    const result = createLoreScipTsconfig(tsconfigDir);
    expect(result).toBeNull();
  });
});

// ── Pure utility function tests ─────────────────────────────────────────────

describe('buildInternalPrefixes', () => {
  it('extracts prefixes from parsed indexes', () => {
    const indexes = [{
      documents: [{
        symbols: [
          { symbol: 'scip-typescript npm test-pkg 1.0.0 src/foo.ts/Foo#' },
        ],
      }],
    }];
    const prefixes = buildInternalPrefixes(indexes);
    expect(prefixes.size).toBe(1);
    expect(prefixes.has('scip-typescript npm test-pkg 1.0.0')).toBe(true);
  });

  it('returns empty set for empty indexes', () => {
    const prefixes = buildInternalPrefixes([]);
    expect(prefixes.size).toBe(0);
  });

  it('skips local symbols', () => {
    const indexes = [{
      documents: [{
        symbols: [{ symbol: 'local 0' }],
      }],
    }];
    const prefixes = buildInternalPrefixes(indexes);
    expect(prefixes.size).toBe(0);
  });
});

describe('isExternalSymbol', () => {
  it('returns false when internal prefix matches', () => {
    const internals = new Set(['scip-typescript npm test-pkg 1.0.0']);
    expect(isExternalSymbol('scip-typescript npm test-pkg 1.0.0 src/a.ts/x.', internals)).toBe(false);
  });

  it('returns true when no internal prefix matches', () => {
    const internals = new Set(['scip-typescript npm test-pkg 1.0.0']);
    expect(isExternalSymbol('scip-typescript npm @types/node 20.0.0 fs/readFile().', internals)).toBe(true);
  });

  it('returns false when internal prefixes set is empty', () => {
    expect(isExternalSymbol('anything', new Set())).toBe(false);
  });
});

describe('buildSymbolDefinitionMap', () => {
  it('builds map from definition occurrences', () => {
    const indexes = [{
      documents: [{
        relativePath: 'src/main.ts',
        occurrences: [
          { symbolRoles: SymbolRole.Definition, symbol: 'ts . main . Foo#', range: [10, 5, 10, 8] },
          { symbolRoles: 0, symbol: 'ts . main . Bar#', range: [20, 0, 20, 3] },
        ],
      }],
    }];
    const map = buildSymbolDefinitionMap(indexes, '/project');
    expect(map.size).toBe(1);
    expect(map.has('ts . main . Foo#')).toBe(true);
    const loc = map.get('ts . main . Foo#')!;
    expect(loc.filePath).toBe(path.resolve('/project', 'src/main.ts'));
    expect(loc.line).toBe(10);
  });

  it('skips local symbols', () => {
    const indexes = [{
      documents: [{
        relativePath: 'src/main.ts',
        occurrences: [
          { symbolRoles: SymbolRole.Definition, symbol: 'local 0', range: [0, 0, 5] },
        ],
      }],
    }];
    const map = buildSymbolDefinitionMap(indexes, '/project');
    expect(map.size).toBe(0);
  });
});

describe('buildContainmentIndex', () => {
  it('groups rows by file_id', () => {
    const rows = [
      { id: 1, file_id: 100, start_line: 0, end_line: 10 },
      { id: 2, file_id: 100, start_line: 5, end_line: 8 },
      { id: 3, file_id: 200, start_line: 0, end_line: 20 },
    ];
    const index = buildContainmentIndex(rows);
    expect(index.size).toBe(2);
    expect(index.get(100)!.length).toBe(2);
    expect(index.get(200)!.length).toBe(1);
  });
});

describe('findContainingSymbol', () => {
  it('finds the symbol span containing a line', () => {
    const index = new Map<number, Array<{ id: number; startLine: number; endLine: number }>>();
    index.set(100, [
      { id: 1, startLine: 0, endLine: 10 },
      { id: 2, startLine: 5, endLine: 8 },
    ]);
    const result = findContainingSymbol(index, 100, 6);
    expect(result).toBe(1);
  });

  it('returns null when no span contains the line', () => {
    const index = new Map<number, Array<{ id: number; startLine: number; endLine: number }>>();
    index.set(100, [{ id: 1, startLine: 0, endLine: 5 }]);
    expect(findContainingSymbol(index, 100, 20)).toBeNull();
  });

  it('returns null for unknown file_id', () => {
    const index = new Map<number, Array<{ id: number; startLine: number; endLine: number }>>();
    expect(findContainingSymbol(index, 999, 0)).toBeNull();
  });
});
