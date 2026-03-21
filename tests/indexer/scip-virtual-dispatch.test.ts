/**
 * Tests for virtual dispatch edge materialization in the SCIP indexer.
 *
 * When a concrete type implements an interface, callers of the interface
 * method should also appear as callers of the concrete method via
 * `call_kind = 'virtual_dispatch'` edges.
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
  RelationshipSchema,
  SymbolRole,
} from '../../src/scip/scip_pb.js';
import { openDb } from '../../src/db/schema.js';
import { ScipIndexerStage } from '../../src/indexer/stages/scip-indexer.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import { resolveEffectiveScipSettings } from '../../src/scip/config.js';
import {
  _extractParentTypeSymbol,
  _extractMethodDescriptor,
} from '../../src/indexer/stages/scip-indexer.js';

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
    layer: 'baseline',
    generation: 1,
  };
}

// ─── Helper unit tests ────────────────────────────────────────────────────────

describe('extractParentTypeSymbol', () => {
  it('extracts type symbol from a method SCIP symbol', () => {
    expect(_extractParentTypeSymbol(
      'scip-go gomod example.com/pkg v1.0 api/Builder#Build().',
    )).toBe('scip-go gomod example.com/pkg v1.0 api/Builder#');
  });

  it('returns null for a function (no type)', () => {
    expect(_extractParentTypeSymbol(
      'scip-go gomod example.com/pkg v1.0 api/Build().',
    )).toBeNull();
  });

  it('returns null for a type symbol', () => {
    expect(_extractParentTypeSymbol(
      'scip-go gomod example.com/pkg v1.0 api/Builder#',
    )).toBeNull();
  });
});

describe('extractMethodDescriptor', () => {
  it('extracts method descriptor from SCIP symbol', () => {
    expect(_extractMethodDescriptor(
      'scip-go gomod example.com/pkg v1.0 api/Builder#Build().',
    )).toBe('Build().');
  });

  it('handles disambiguated methods', () => {
    expect(_extractMethodDescriptor(
      'scip-go gomod example.com/pkg v1.0 api/Builder#Build(+1).',
    )).toBe('Build(+1).');
  });

  it('returns null for non-method symbols', () => {
    expect(_extractMethodDescriptor(
      'scip-go gomod example.com/pkg v1.0 api/Build().',
    )).toBeNull();
  });
});

// ─── Integration test ─────────────────────────────────────────────────────────

describe('ScipIndexerStage virtual dispatch materialization', () => {
  it('materializes virtual_dispatch edges for interface method callers', async () => {
    const rootDir = makeTmpDir('lore-scip-vdispatch-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Simulate a Go codebase with an interface and implementation:
    //
    // api.go:
    //   type Builder interface { Build() error }
    //   func RunBuild(b Builder) { b.Build() }
    //
    // impl.go:
    //   type myBuilder struct {}
    //   func (m *myBuilder) Build() error { return rebuildImpl() }
    //   func rebuildImpl() error { return nil }

    const apiSource = [
      'package api',
      '',
      'type Builder interface {',
      '    Build() error',
      '}',
      '',
      'func RunBuild(b Builder) error {',
      '    return b.Build()',
      '}',
    ].join('\n');

    const implSource = [
      'package api',
      '',
      'type myBuilder struct {}',
      '',
      'func (m *myBuilder) Build() error {',
      '    return rebuildImpl()',
      '}',
      '',
      'func rebuildImpl() error {',
      '    return nil',
      '}',
    ].join('\n');

    writeFileSync(join(rootDir, 'api.go'), apiSource);
    writeFileSync(join(rootDir, 'impl.go'), implSource);
    // Need a go.mod for SCIP to detect Go
    writeFileSync(join(rootDir, 'go.mod'), 'module example.com/api\ngo 1.21\n');

    // SCIP symbols
    const builderType = 'scip-go gomod example.com/api v1 api/Builder#';
    const builderBuild = 'scip-go gomod example.com/api v1 api/Builder#Build().';
    const runBuild = 'scip-go gomod example.com/api v1 api/RunBuild().';
    const myBuilderType = 'scip-go gomod example.com/api v1 api/myBuilder#';
    const myBuilderBuild = 'scip-go gomod example.com/api v1 api/myBuilder#Build().';
    const rebuildImpl = 'scip-go gomod example.com/api v1 api/rebuildImpl().';

    const bytes = toBinary(IndexSchema, create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: 'api.go',
          language: 'Go',
          occurrences: [
            // Builder interface definition
            create(OccurrenceSchema, {
              range: [2, 5, 2, 12],
              symbol: builderType,
              symbolRoles: SymbolRole.Definition,
              enclosingRange: [2, 0, 4, 1],
            }),
            // Builder.Build() method definition (interface method)
            create(OccurrenceSchema, {
              range: [3, 4, 3, 9],
              symbol: builderBuild,
              symbolRoles: SymbolRole.Definition,
              enclosingRange: [3, 0, 3, 22],
            }),
            // RunBuild function definition
            create(OccurrenceSchema, {
              range: [6, 5, 6, 13],
              symbol: runBuild,
              symbolRoles: SymbolRole.Definition,
              enclosingRange: [6, 0, 8, 1],
            }),
            // Reference: b.Build() inside RunBuild — calls the interface method
            create(OccurrenceSchema, {
              range: [7, 13, 7, 18],
              symbol: builderBuild,
              symbolRoles: 0, // reference, not definition
            }),
          ],
          symbols: [
            create(SymbolInformationSchema, {
              symbol: builderType,
              displayName: 'Builder',
              documentation: ['interface Builder'],
            }),
            create(SymbolInformationSchema, {
              symbol: builderBuild,
              displayName: 'Build',
              documentation: ['func Build() error'],
            }),
            create(SymbolInformationSchema, {
              symbol: runBuild,
              displayName: 'RunBuild',
              documentation: ['func RunBuild(b Builder) error'],
            }),
          ],
        }),
        create(DocumentSchema, {
          relativePath: 'impl.go',
          language: 'Go',
          occurrences: [
            // myBuilder struct definition
            create(OccurrenceSchema, {
              range: [2, 5, 2, 14],
              symbol: myBuilderType,
              symbolRoles: SymbolRole.Definition,
              enclosingRange: [2, 0, 2, 23],
            }),
            // myBuilder.Build() method definition
            create(OccurrenceSchema, {
              range: [4, 22, 4, 27],
              symbol: myBuilderBuild,
              symbolRoles: SymbolRole.Definition,
              enclosingRange: [4, 0, 6, 1],
            }),
            // Reference: rebuildImpl() call inside myBuilder.Build()
            create(OccurrenceSchema, {
              range: [5, 11, 5, 23],
              symbol: rebuildImpl,
              symbolRoles: 0,
            }),
            // rebuildImpl function definition
            create(OccurrenceSchema, {
              range: [8, 5, 8, 17],
              symbol: rebuildImpl,
              symbolRoles: SymbolRole.Definition,
              enclosingRange: [8, 0, 10, 1],
            }),
          ],
          symbols: [
            create(SymbolInformationSchema, {
              symbol: myBuilderType,
              displayName: 'myBuilder',
              documentation: ['type myBuilder struct'],
              // Type-level: myBuilder implements Builder
              relationships: [
                create(RelationshipSchema, {
                  symbol: builderType,
                  isImplementation: true,
                }),
              ],
            }),
            create(SymbolInformationSchema, {
              symbol: myBuilderBuild,
              displayName: 'Build',
              documentation: ['func (m *myBuilder) Build() error'],
              // Method-level: myBuilder.Build implements Builder.Build
              relationships: [
                create(RelationshipSchema, {
                  symbol: builderBuild,
                  isImplementation: true,
                }),
              ],
            }),
            create(SymbolInformationSchema, {
              symbol: rebuildImpl,
              displayName: 'rebuildImpl',
              documentation: ['func rebuildImpl() error'],
            }),
          ],
        }),
      ],
    }));

    writeFileSync(join(indexDir, 'go.scip'), bytes);

    const ctx = makeContext(rootDir, ':memory:');
    // Override loadScipIndexes to use our pre-built index
    const stage = new ScipIndexerStage();
    (stage as any).loadScipIndexes = async () => [bytes];

    await stage.execute(ctx, 'build');

    const db = ctx.db;

    // Verify: RunBuild has a direct call edge to Builder.Build (interface method)
    const runBuildId = (db.prepare(
      "SELECT id FROM symbols WHERE name = 'RunBuild'",
    ).get() as { id: number })?.id;
    expect(runBuildId).toBeDefined();

    const builderBuildId = (db.prepare(
      "SELECT id FROM symbols WHERE name = 'Build' AND kind = 'method'",
    ).all() as Array<{ id: number }>);
    expect(builderBuildId.length).toBeGreaterThanOrEqual(1);

    // Find the interface method and concrete method IDs
    const allBuildSymbols = db.prepare(
      "SELECT s.id, s.name, s.kind, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = 'Build'",
    ).all() as Array<{ id: number; name: string; kind: string; path: string }>;

    const interfaceBuildId = allBuildSymbols.find(s => s.path.endsWith('api.go'))?.id;
    const concreteBuildId = allBuildSymbols.find(s => s.path.endsWith('impl.go'))?.id;
    expect(interfaceBuildId).toBeDefined();
    expect(concreteBuildId).toBeDefined();

    // Verify: there should be a direct call edge RunBuild → Builder.Build
    const directEdge = db.prepare(
      "SELECT call_kind FROM symbol_refs WHERE caller_id = ? AND callee_id = ?",
    ).get(runBuildId, interfaceBuildId) as { call_kind: string } | undefined;
    expect(directEdge).toBeDefined();
    expect(directEdge!.call_kind).toBe('direct');

    // KEY ASSERTION: there should be a virtual_dispatch edge RunBuild → myBuilder.Build
    const virtualEdge = db.prepare(
      "SELECT call_kind, resolution_method, definition_path, definition_line, definition_character FROM symbol_refs WHERE caller_id = ? AND callee_id = ?",
    ).get(runBuildId, concreteBuildId) as {
      call_kind: string;
      resolution_method: string;
      definition_path: string | null;
      definition_line: number | null;
      definition_character: number | null;
    } | undefined;
    expect(virtualEdge).toBeDefined();
    expect(virtualEdge!.call_kind).toBe('virtual_dispatch');
    expect(virtualEdge!.resolution_method).toBe('scip_definition');
    expect(virtualEdge!.definition_path).toMatch(/impl\.go$/);
    expect(virtualEdge!.definition_line).toBe(4);
    expect(virtualEdge!.definition_character).toBe(22);

    // Verify: querying callers of myBuilder.Build should now return RunBuild
    const callers = db.prepare(
      "SELECT s.name, sr.call_kind FROM symbol_refs sr JOIN symbols s ON s.id = sr.caller_id WHERE sr.callee_id = ?",
    ).all(concreteBuildId) as Array<{ name: string; call_kind: string }>;

    const callerNames = callers.map(c => c.name);
    expect(callerNames).toContain('RunBuild');

    // Verify the virtual_dispatch edge is among them
    const vdCallers = callers.filter(c => c.call_kind === 'virtual_dispatch');
    expect(vdCallers.length).toBeGreaterThanOrEqual(1);
    expect(vdCallers.some(c => c.name === 'RunBuild')).toBe(true);

    db.close();
  });

  it('preserves distinct direct and virtual call sites to the same concrete method', async () => {
    const rootDir = makeTmpDir('lore-scip-vdispatch-nodup-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Simplified case: caller directly calls both interface and concrete method
    const source = [
      'package api',
      '',
      'type Iface interface { Do() }',
      'type Impl struct {}',
      'func (i *Impl) Do() {}',
      'func caller() {',
      '    var x Iface',
      '    x.Do()',
      '    var y Impl',
      '    y.Do()',
      '}',
    ].join('\n');

    writeFileSync(join(rootDir, 'main.go'), source);
    writeFileSync(join(rootDir, 'go.mod'), 'module example.com/api\ngo 1.21\n');

    const ifaceType = 'scip-go gomod example.com/api v1 api/Iface#';
    const ifaceDo = 'scip-go gomod example.com/api v1 api/Iface#Do().';
    const implType = 'scip-go gomod example.com/api v1 api/Impl#';
    const implDo = 'scip-go gomod example.com/api v1 api/Impl#Do().';
    const callerSym = 'scip-go gomod example.com/api v1 api/caller().';

    const bytes = toBinary(IndexSchema, create(IndexSchema, {
      documents: [
        create(DocumentSchema, {
          relativePath: 'main.go',
          language: 'Go',
          occurrences: [
            create(OccurrenceSchema, { range: [2, 5, 2, 10], symbol: ifaceType, symbolRoles: SymbolRole.Definition, enclosingRange: [2, 0, 2, 28] }),
            create(OccurrenceSchema, { range: [2, 23, 2, 25], symbol: ifaceDo, symbolRoles: SymbolRole.Definition, enclosingRange: [2, 23, 2, 28] }),
            create(OccurrenceSchema, { range: [3, 5, 3, 9], symbol: implType, symbolRoles: SymbolRole.Definition, enclosingRange: [3, 0, 3, 19] }),
            create(OccurrenceSchema, { range: [4, 15, 4, 17], symbol: implDo, symbolRoles: SymbolRole.Definition, enclosingRange: [4, 0, 4, 22] }),
            create(OccurrenceSchema, { range: [5, 5, 5, 11], symbol: callerSym, symbolRoles: SymbolRole.Definition, enclosingRange: [5, 0, 10, 1] }),
            // x.Do() — calls interface method
            create(OccurrenceSchema, { range: [7, 6, 7, 8], symbol: ifaceDo, symbolRoles: 0 }),
            // y.Do() — calls concrete method directly
            create(OccurrenceSchema, { range: [9, 6, 9, 8], symbol: implDo, symbolRoles: 0 }),
          ],
          symbols: [
            create(SymbolInformationSchema, { symbol: ifaceType, displayName: 'Iface', documentation: ['interface Iface'] }),
            create(SymbolInformationSchema, { symbol: ifaceDo, displayName: 'Do', documentation: ['func Do()'] }),
            create(SymbolInformationSchema, { symbol: implType, displayName: 'Impl', documentation: ['type Impl struct'] }),
            create(SymbolInformationSchema, {
              symbol: implDo,
              displayName: 'Do',
              documentation: ['func (i *Impl) Do()'],
              relationships: [create(RelationshipSchema, { symbol: ifaceDo, isImplementation: true })],
            }),
            create(SymbolInformationSchema, {
              symbol: implType,
              documentation: ['type Impl struct'],
              relationships: [create(RelationshipSchema, { symbol: ifaceType, isImplementation: true })],
            }),
            create(SymbolInformationSchema, { symbol: callerSym, displayName: 'caller', documentation: ['func caller()'] }),
          ],
        }),
      ],
    }));

    writeFileSync(join(indexDir, 'go.scip'), bytes);

    const ctx = makeContext(rootDir, ':memory:');
    const stage = new ScipIndexerStage();
    (stage as any).loadScipIndexes = async () => [bytes];

    await stage.execute(ctx, 'build');

    const db = ctx.db;

    const implDoId = (db.prepare(
      "SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = 'Do' AND f.path LIKE '%main.go' AND s.start_line = 4",
    ).get() as { id: number })?.id;

    // There should be 2 edges to Impl.Do:
    // - a virtual_dispatch edge for x.Do() via the interface call site
    // - a direct edge for y.Do() at its distinct concrete call site
    const edges = db.prepare(
      "SELECT caller_id, call_kind, call_line FROM symbol_refs WHERE callee_id = ? ORDER BY call_line",
    ).all(implDoId) as Array<{ caller_id: number; call_kind: string; call_line: number }>;

    expect(edges.length).toBe(2);
    expect(edges).toEqual([
      { caller_id: edges[0]!.caller_id, call_kind: 'virtual_dispatch', call_line: 7 },
      { caller_id: edges[1]!.caller_id, call_kind: 'direct', call_line: 9 },
    ]);

    db.close();
  });
});
