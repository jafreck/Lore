/**
 * Tests for SCIP-based authoritative import resolution.
 *
 * When ScipIndexerStage processes Import-role occurrences, it should
 * pre-resolve `file_imports.resolved_id` using the SCIP symbol →
 * definition location mapping — giving compiler-precision import
 * resolution without heuristic path guessing.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  DocumentSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
  SymbolRole,
} from '../../src/scip/scip_pb.js';
import { openDb } from '../../src/db/schema.js';
import { ScipIndexerStage } from '../../src/indexer/stages/scip-indexer.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import { resolveEffectiveScipSettings } from '../../src/scip/config.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function buildScipIndexBytes(docs: Array<{
  relativePath: string;
  language: string;
  occurrences: Array<{ range: number[]; symbol: string; symbolRoles: number }>;
  symbols?: Array<{
    symbol: string;
    documentation?: string[];
    displayName?: string;
  }>;
}>): Uint8Array {
  const index = create(IndexSchema, {
    documents: docs.map(d => create(DocumentSchema, {
      relativePath: d.relativePath,
      language: d.language,
      occurrences: d.occurrences.map(o => create(OccurrenceSchema, {
        range: o.range,
        symbol: o.symbol,
        symbolRoles: o.symbolRoles,
      })),
      symbols: (d.symbols ?? []).map(s => create(SymbolInformationSchema, {
        symbol: s.symbol,
        documentation: s.documentation ?? [],
        displayName: s.displayName ?? '',
      })),
    })),
  });
  return toBinary(IndexSchema, index);
}

function makeContext(rootDir: string, dbPath: string): PipelineContext {
  const db = openDb(dbPath);
  return {
    db,
    dbPath,
    walkerConfig: { rootDir },
    branch: 'HEAD',
    lsp: null,
    scip: resolveEffectiveScipSettings({}, { enabled: true, indexDir: '.scip-indexes' }),
    embedder: null,
    log: initLogger({ level: LogLevel.SILENT }),
    files: [],
    indexDependencies: false,
    history: false,
    docsAutoNotes: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    changedDocPaths: [],
    sourceCache: new Map(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ScipIndexerStage import resolution', () => {
  it('pre-resolves internal imports via SCIP symbol definitions', async () => {
    const rootDir = makeTmpDir('lore-scip-imports-resolve-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Two files: index.ts imports foo from utils.ts
    const indexSource = [
      "import { foo } from './utils.js';",
      '',
      'export function main() { return foo(); }',
    ].join('\n');
    const utilsSource = [
      'export function foo() { return 42; }',
    ].join('\n');
    writeFileSync(join(rootDir, 'index.ts'), indexSource);
    writeFileSync(join(rootDir, 'utils.ts'), utilsSource);

    // SCIP index with both documents.
    // utils.ts defines foo; index.ts has an Import occurrence for foo.
    const fooSymbol = 'scip-typescript npm . . utils.ts/foo().';
    const mainSymbol = 'scip-typescript npm . . index.ts/main().';

    const bytes = buildScipIndexBytes([
      {
        relativePath: 'utils.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [0, 16, 0, 19], symbol: fooSymbol, symbolRoles: SymbolRole.Definition },
        ],
        symbols: [
          { symbol: fooSymbol, displayName: 'foo', documentation: ['function foo(): number'] },
        ],
      },
      {
        relativePath: 'index.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [2, 16, 2, 20], symbol: mainSymbol, symbolRoles: SymbolRole.Definition },
          // Import occurrence: foo is imported from utils
          { range: [0, 9, 0, 12], symbol: fooSymbol, symbolRoles: SymbolRole.Import },
        ],
        symbols: [
          { symbol: mainSymbol, displayName: 'main', documentation: ['function main()'] },
        ],
      },
    ]);
    writeFileSync(join(indexDir, 'index.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');

    // Check file_imports for index.ts
    const indexFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'index.ts')) as any).id;
    const utilsFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'utils.ts')) as any).id;

    const imports = ctx.db.prepare(
      'SELECT raw_import, resolved_id FROM file_imports WHERE file_id = ?',
    ).all(indexFileId) as Array<{ raw_import: string; resolved_id: number | null }>;

    // Should have one import pointing to utils.ts
    expect(imports).toHaveLength(1);
    expect(imports[0]!.raw_import).toBe('./utils.js');
    expect(imports[0]!.resolved_id).toBe(utilsFileId);

    ctx.db.close();
  });

  it('leaves resolved_id NULL for external imports', async () => {
    const rootDir = makeTmpDir('lore-scip-imports-external-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // File that imports from an external package (lodash)
    const source = [
      "import { map } from 'lodash';",
      '',
      'export const result = map([1, 2], x => x + 1);',
    ].join('\n');
    writeFileSync(join(rootDir, 'app.ts'), source);

    // SCIP: app.ts has an Import occurrence for lodash's map.
    // The symbol is external — no Definition occurrence in any document.
    const mapSymbol = 'scip-typescript npm lodash 4.17.21 index.d.ts/map().';
    const resultSymbol = 'scip-typescript npm . . app.ts/result.';

    const bytes = buildScipIndexBytes([{
      relativePath: 'app.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [2, 13, 2, 19], symbol: resultSymbol, symbolRoles: SymbolRole.Definition },
        { range: [0, 9, 0, 12], symbol: mapSymbol, symbolRoles: SymbolRole.Import },
      ],
      symbols: [
        { symbol: resultSymbol, displayName: 'result', documentation: ['const result'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'index.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');

    const appFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'app.ts')) as any).id;

    const imports = ctx.db.prepare(
      'SELECT raw_import, resolved_id FROM file_imports WHERE file_id = ?',
    ).all(appFileId) as Array<{ raw_import: string; resolved_id: number | null }>;

    // Should have one import with NULL resolved_id (external)
    expect(imports).toHaveLength(1);
    expect(imports[0]!.raw_import).toBe('lodash');
    expect(imports[0]!.resolved_id).toBeNull();

    ctx.db.close();
  });

  it('deduplicates imports from the same source line', async () => {
    const rootDir = makeTmpDir('lore-scip-imports-dedup-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // import { a, b } from './lib.js'  → two Import occurrences, same raw_import
    const source = [
      "import { a, b } from './lib.js';",
      'export function main() { return a() + b(); }',
    ].join('\n');
    const libSource = [
      'export function a() { return 1; }',
      'export function b() { return 2; }',
    ].join('\n');
    writeFileSync(join(rootDir, 'main.ts'), source);
    writeFileSync(join(rootDir, 'lib.ts'), libSource);

    const symA = 'scip-typescript npm . . lib.ts/a().';
    const symB = 'scip-typescript npm . . lib.ts/b().';
    const mainSym = 'scip-typescript npm . . main.ts/main().';

    const bytes = buildScipIndexBytes([
      {
        relativePath: 'lib.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [0, 16, 0, 17], symbol: symA, symbolRoles: SymbolRole.Definition },
          { range: [1, 16, 1, 17], symbol: symB, symbolRoles: SymbolRole.Definition },
        ],
        symbols: [
          { symbol: symA, displayName: 'a', documentation: ['function a()'] },
          { symbol: symB, displayName: 'b', documentation: ['function b()'] },
        ],
      },
      {
        relativePath: 'main.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [1, 16, 1, 20], symbol: mainSym, symbolRoles: SymbolRole.Definition },
          // Two import occurrences on the same source line
          { range: [0, 9, 0, 10], symbol: symA, symbolRoles: SymbolRole.Import },
          { range: [0, 12, 0, 13], symbol: symB, symbolRoles: SymbolRole.Import },
        ],
        symbols: [
          { symbol: mainSym, displayName: 'main', documentation: ['function main()'] },
        ],
      },
    ]);
    writeFileSync(join(indexDir, 'index.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');

    const mainFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'main.ts')) as any).id;
    const libFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'lib.ts')) as any).id;

    const imports = ctx.db.prepare(
      'SELECT raw_import, resolved_id FROM file_imports WHERE file_id = ?',
    ).all(mainFileId) as Array<{ raw_import: string; resolved_id: number | null }>;

    // Should be deduplicated to one import row, resolved to lib.ts
    expect(imports).toHaveLength(1);
    expect(imports[0]!.raw_import).toBe('./lib.js');
    expect(imports[0]!.resolved_id).toBe(libFileId);

    ctx.db.close();
  });

  it('upgrades unresolved import when later occurrence provides resolution', async () => {
    const rootDir = makeTmpDir('lore-scip-imports-upgrade-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Contrived: first Import occurrence has an external symbol (unresolved),
    // second has an internal symbol (resolvable). Same source line.
    const source = [
      "import { ext, local } from './mixed.js';",
      'export function run() { return ext() + local(); }',
    ].join('\n');
    const mixedSource = 'export function local() { return 1; }\n';
    writeFileSync(join(rootDir, 'entry.ts'), source);
    writeFileSync(join(rootDir, 'mixed.ts'), mixedSource);

    const extSym = 'scip-typescript npm some-pkg 1.0 index.d.ts/ext().';
    const localSym = 'scip-typescript npm . . mixed.ts/local().';
    const runSym = 'scip-typescript npm . . entry.ts/run().';

    const bytes = buildScipIndexBytes([
      {
        relativePath: 'mixed.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [0, 16, 0, 21], symbol: localSym, symbolRoles: SymbolRole.Definition },
        ],
        symbols: [
          { symbol: localSym, displayName: 'local', documentation: ['function local()'] },
        ],
      },
      {
        relativePath: 'entry.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [1, 16, 1, 19], symbol: runSym, symbolRoles: SymbolRole.Definition },
          // External import occurrence first (no definition in index)
          { range: [0, 9, 0, 12], symbol: extSym, symbolRoles: SymbolRole.Import },
          // Internal import occurrence second (definition exists in mixed.ts)
          { range: [0, 14, 0, 19], symbol: localSym, symbolRoles: SymbolRole.Import },
        ],
        symbols: [
          { symbol: runSym, displayName: 'run', documentation: ['function run()'] },
        ],
      },
    ]);
    writeFileSync(join(indexDir, 'index.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');

    const entryFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'entry.ts')) as any).id;
    const mixedFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'mixed.ts')) as any).id;

    const imports = ctx.db.prepare(
      'SELECT raw_import, resolved_id FROM file_imports WHERE file_id = ?',
    ).all(entryFileId) as Array<{ raw_import: string; resolved_id: number | null }>;

    // The import should have been upgraded to resolved when the second occurrence was processed
    expect(imports).toHaveLength(1);
    expect(imports[0]!.raw_import).toBe('./mixed.js');
    expect(imports[0]!.resolved_id).toBe(mixedFileId);

    ctx.db.close();
  });

  it('ImportResolutionStage skips already-resolved SCIP imports', async () => {
    const rootDir = makeTmpDir('lore-scip-imports-skip-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const source = "import { foo } from './dep.js';\nexport const x = foo();\n";
    const depSource = 'export function foo() {}\n';
    writeFileSync(join(rootDir, 'a.ts'), source);
    writeFileSync(join(rootDir, 'dep.ts'), depSource);

    const fooSym = 'scip-typescript npm . . dep.ts/foo().';
    const xSym = 'scip-typescript npm . . a.ts/x.';

    const bytes = buildScipIndexBytes([
      {
        relativePath: 'dep.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [0, 16, 0, 19], symbol: fooSym, symbolRoles: SymbolRole.Definition },
        ],
        symbols: [
          { symbol: fooSym, displayName: 'foo', documentation: ['function foo()'] },
        ],
      },
      {
        relativePath: 'a.ts',
        language: 'TypeScript',
        occurrences: [
          { range: [1, 13, 1, 14], symbol: xSym, symbolRoles: SymbolRole.Definition },
          { range: [0, 9, 0, 12], symbol: fooSym, symbolRoles: SymbolRole.Import },
        ],
        symbols: [
          { symbol: xSym, displayName: 'x', documentation: ['const x'] },
        ],
      },
    ]);
    writeFileSync(join(indexDir, 'index.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');

    // Verify import is already resolved
    const aFileId = (ctx.db.prepare('SELECT id FROM files WHERE path = ?')
      .get(join(rootDir, 'a.ts')) as any).id;

    const unresolvedCount = ctx.db.prepare(
      'SELECT COUNT(*) as cnt FROM file_imports WHERE file_id = ? AND resolved_id IS NULL',
    ).get(aFileId) as { cnt: number };

    // All imports from SCIP-covered files that point to indexed files should be resolved
    expect(unresolvedCount.cnt).toBe(0);

    ctx.db.close();
  });
});
