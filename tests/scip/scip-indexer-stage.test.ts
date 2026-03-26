/**
 * Integration tests for the SCIP indexer stage.
 *
 * Covers the full ScipIndexerStage.execute path with a real SQLite DB
 * to catch schema-level bugs like NOT NULL violations.
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
import { ScipIndexerStage, ScipRefStage } from '../../src/indexer/stages/scip-indexer.js';
import { SourceIndexStage } from '../../src/indexer/stages/source-index.js';
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
  occurrences: Array<{ range: number[]; symbol: string; symbolRoles: number; enclosingRange?: number[] }>;
  symbols?: Array<{
    symbol: string;
    documentation?: string[];
    displayName?: string;
    relationships?: Array<{ symbol: string; isImplementation?: boolean; isTypeDefinition?: boolean; isDefinition?: boolean }>;
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
        enclosingRange: o.enclosingRange ?? [],
      })),
      symbols: (d.symbols ?? []).map(s => create(SymbolInformationSchema, {
        symbol: s.symbol,
        documentation: s.documentation ?? [],
        displayName: s.displayName ?? '',
        relationships: (s.relationships ?? []).map(r => create(RelationshipSchema, {
          symbol: r.symbol,
          isImplementation: r.isImplementation ?? false,
          isTypeDefinition: r.isTypeDefinition ?? false,
          isDefinition: r.isDefinition ?? false,
        })),
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
    staleSymbolIds: [],
    changedSourcePaths: [],
    sourceCache: new Map(),
    layer: 'baseline',
    generation: 1,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ScipIndexerStage', () => {
  it('populates enrichment columns for symbols inline', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-sym-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const symGreet = 'typescript npm test 1.0 `main`/greet().';
    const symMain = 'typescript npm test 1.0 `main`/main().';
    const sourceContent = 'function greet(name: string): string {\n  return "hi " + name;\n}\nfunction main() {\n  greet("world");\n}\n';
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 9, 0, 14], symbol: symGreet, symbolRoles: SymbolRole.Definition, enclosingRange: [0, 0, 2, 1] },
        { range: [3, 9, 3, 13], symbol: symMain, symbolRoles: SymbolRole.Definition, enclosingRange: [3, 0, 5, 1] },
        // Call to greet inside main()
        { range: [4, 2, 4, 7], symbol: symGreet, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: symGreet, displayName: 'greet', documentation: ['```ts\nfunction greet(name: string): string\n```'] },
        { symbol: symMain, displayName: 'main', documentation: ['```ts\nfunction main(): void\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');
    await new ScipRefStage().execute(ctx, 'build');

    // Symbol should have enrichment columns populated
    const sym = ctx.db.prepare('SELECT resolved_type_signature, resolved_return_type, definition_uri, definition_path FROM symbols WHERE name = ?').get('greet') as any;
    expect(sym.resolved_type_signature).toBeTruthy();
    expect(sym.resolved_return_type).toBe('string');
    expect(sym.definition_uri).toContain('main.ts');
    expect(sym.definition_path).toBe(join(rootDir, 'main.ts'));

    // Call ref (main calling greet) should have enrichment columns populated
    const ref = ctx.db.prepare('SELECT resolved_type_signature, resolved_return_type, definition_path, definition_line FROM symbol_refs WHERE callee_name = ?').get('greet') as any;
    expect(ref).toBeTruthy();
    expect(ref.resolved_type_signature).toBeTruthy();
    expect(ref.resolved_return_type).toBe('string');
    expect(ref.definition_path).toBe(join(rootDir, 'main.ts'));
    expect(ref.definition_line).toBe(0);

    // scipCoveredLanguages should be set
    expect(ctx.scipCoveredLanguages).toBeDefined();
    expect(ctx.scipCoveredLanguages!.has('typescript')).toBe(true);

    ctx.db.close();
  });

  it('populates enrichment columns for type refs inline', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-typeref-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const typeSym = 'typescript npm test 1.0 `main`/MyType#';
    const fnSym = 'typescript npm test 1.0 `main`/doStuff().';
    const sourceContent = 'interface MyType { x: number; }\nfunction doStuff(v: MyType) {}\n';
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 10, 0, 16], symbol: typeSym, symbolRoles: SymbolRole.Definition },
        { range: [1, 9, 1, 16], symbol: fnSym, symbolRoles: SymbolRole.Definition },
        // Type reference to MyType in doStuff's parameter
        { range: [1, 20, 1, 26], symbol: typeSym, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: typeSym, displayName: 'MyType', documentation: ['```ts\ninterface MyType\n```'] },
        { symbol: fnSym, displayName: 'doStuff', documentation: ['```ts\nfunction doStuff(v: MyType): void\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');
    await new ScipRefStage().execute(ctx, 'build');

    // Type ref should have enrichment columns populated
    const typeRef = ctx.db.prepare('SELECT resolved_type_signature, definition_path, definition_line FROM type_refs LIMIT 1').get() as any;
    expect(typeRef).toBeTruthy();
    expect(typeRef.definition_path).toBe(join(rootDir, 'main.ts'));
    expect(typeRef.definition_line).toBe(0);

    ctx.db.close();
  });

  it('populates enrichment columns for relationships', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-rel-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const symBase = 'go . example.com/pkg 1.0 `main`/Animal#';
    const symChild = 'go . example.com/pkg 1.0 `main`/Dog#';
    const sourceContent = 'package main\ntype Animal struct{}\ntype Dog struct{}';
    writeFileSync(join(rootDir, 'main.go'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.go',
      language: 'Go',
      occurrences: [
        { range: [1, 5, 1, 11], symbol: symBase, symbolRoles: SymbolRole.Definition },
        { range: [2, 5, 2, 8], symbol: symChild, symbolRoles: SymbolRole.Definition },
      ],
      symbols: [
        { symbol: symBase, displayName: 'Animal', documentation: ['type Animal struct'] },
        {
          symbol: symChild,
          displayName: 'Dog',
          documentation: ['type Dog struct'],
          relationships: [{ symbol: symBase, isImplementation: true }],
        },
      ],
    }]);
    writeFileSync(join(indexDir, 'go.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');

    const rel = ctx.db.prepare('SELECT definition_path, definition_line, definition_uri FROM symbol_relationships LIMIT 1').get() as any;
    expect(rel).toBeTruthy();
    // Target is Animal, defined at line 1
    expect(rel.definition_path).toBe(join(rootDir, 'main.go'));
    expect(rel.definition_line).toBe(1);
    expect(rel.definition_uri).toContain('main.go');

    ctx.db.close();
  });

  it('inserts relationships when definition location is known', async () => {
    const rootDir = makeTmpDir('lore-scip-rel-known-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Symbol A defines at line 5; symbol B is related to A
    const symA = 'go . example.com/pkg 1.0 `main`/Animal#';
    const symB = 'go . example.com/pkg 1.0 `main`/Dog#';

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.go',
      language: 'Go',
      occurrences: [
        { range: [5, 0, 5, 6], symbol: symA, symbolRoles: SymbolRole.Definition },
        { range: [10, 0, 10, 3], symbol: symB, symbolRoles: SymbolRole.Definition },
      ],
      symbols: [
        { symbol: symA, displayName: 'Animal', documentation: ['type Animal struct'] },
        {
          symbol: symB,
          displayName: 'Dog',
          documentation: ['type Dog struct'],
          relationships: [{ symbol: symA, isImplementation: true }],
        },
      ],
    }]);
    writeFileSync(join(indexDir, 'go.scip'), bytes);

    // Create a source file so the walker picks it up
    writeFileSync(join(rootDir, 'main.go'), 'package main\ntype Animal struct{}\ntype Dog struct{}');

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();
    await stage.execute(ctx, 'build');

    const rels = ctx.db.prepare('SELECT * FROM symbol_relationships').all() as any[];
    expect(rels.length).toBeGreaterThan(0);

    const rel = rels[0];
    expect(rel.relationship_type).toBe('implements');
    expect(rel.target_symbol_name).toBe('Animal');
    // Definition was found → line should be populated
    expect(rel.line).toBe(10);

    ctx.db.close();
  });

  it('inserts relationships with NULL line when definition location is unknown', async () => {
    const rootDir = makeTmpDir('lore-scip-rel-null-line-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // symA: external type — no definition occurrence in our index
    const symA = 'go . stdlib 1.0 `io`/Reader#';
    // symB: local type that implements symA, BUT symB has no definition
    // occurrence either (simulates a SymbolInformation-only entry).
    const symB = 'go . example.com/pkg 1.0 `main`/MyReader#';

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.go',
      language: 'Go',
      occurrences: [
        // Only a reference to symB, not a definition — so symbolDefinitions
        // won't have an entry and defLoc will be undefined.
        { range: [20, 4, 20, 12], symbol: symB, symbolRoles: 0 },
      ],
      symbols: [
        {
          symbol: symB,
          displayName: 'MyReader',
          documentation: ['type MyReader struct'],
          relationships: [{ symbol: symA, isImplementation: true }],
        },
      ],
    }]);
    writeFileSync(join(indexDir, 'go.scip'), bytes);

    writeFileSync(join(rootDir, 'main.go'), 'package main\ntype MyReader struct{}');

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const stage = new ScipIndexerStage();

    // Before the fix this threw: SqliteError: NOT NULL constraint failed:
    // symbol_relationships.line
    await stage.execute(ctx, 'build');

    const rels = ctx.db.prepare('SELECT * FROM symbol_relationships').all() as any[];
    expect(rels.length).toBeGreaterThan(0);

    const rel = rels[0];
    expect(rel.target_symbol_name).toBe('Reader');
    // No definition location → line should be NULL
    expect(rel.line).toBeNull();

    ctx.db.close();
  });

  it('tree-sitter patches symbol end_line when SCIP provides no enclosingRange (Go methods)', async () => {
    const rootDir = makeTmpDir('lore-scip-endline-patch-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Go source with a method receiver — tree-sitter correctly sees lines 6-10
    // but scip-go provides no enclosingRange, so SCIP stage stores end_line = start_line.
    const goSource = [
      'package main',                                                            // 0
      '',                                                                        // 1
      'type Server struct {',                                                    // 2
      '    port int',                                                            // 3
      '}',                                                                       // 4
      '',                                                                        // 5
      'func (s *Server) HandleRequest(id int, data map[string]interface{}) {',   // 6
      '    doWork(id)',                                                           // 7
      '    doWork(id)',                                                           // 8
      '    return',                                                              // 9
      '}',                                                                       // 10
      '',                                                                        // 11
    ].join('\n');
    const goFilePath = join(rootDir, 'main.go');
    writeFileSync(goFilePath, goSource);

    const symHandleRequest = 'scip-go gomod example.com/test 1.0 main/Server#HandleRequest().';
    const symDoWork = 'scip-go gomod example.com/test 1.0 main/doWork().';

    // SCIP index with NO enclosingRange (empty arrays) — exactly what scip-go emits
    const bytes = buildScipIndexBytes([{
      relativePath: 'main.go',
      language: 'Go',
      occurrences: [
        // Definition of HandleRequest — range points to the identifier only
        { range: [6, 18, 31], symbol: symHandleRequest, symbolRoles: SymbolRole.Definition },
        // Call to doWork inside HandleRequest
        { range: [7, 4, 10], symbol: symDoWork, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: symHandleRequest, displayName: 'HandleRequest', documentation: ['func (s *Server) HandleRequest(id int, data map[string]interface{})'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'go.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    // Step 1: Run SCIP stage — should store end_line = start_line (the bug)
    const scipStage = new ScipIndexerStage();
    await scipStage.execute(ctx, 'build');

    const beforePatch = ctx.db.prepare(
      'SELECT start_line, end_line FROM symbols WHERE name = ?',
    ).get('HandleRequest') as { start_line: number; end_line: number } | undefined;
    expect(beforePatch).toBeDefined();
    expect(beforePatch!.start_line).toBe(6);
    // With estimateSymbolEndLine now returning defLine (tree-sitter
    // patches accurate spans via SourceIndexStage), the initial end_line
    // equals the definition line when no enclosingRange is provided.
    expect(beforePatch!.end_line).toBe(6);

    // Step 2: Run SourceIndexStage — tree-sitter should patch end_line
    // ScipIndexerStage sets ctx.scipSourcedFiles; verify it was set
    expect(ctx.scipSourcedFiles).toBeDefined();
    expect(ctx.scipSourcedFiles!.has(goFilePath)).toBe(true);

    const sourceStage = new SourceIndexStage();
    await sourceStage.execute(ctx, 'build');

    const afterPatch = ctx.db.prepare(
      'SELECT start_line, end_line FROM symbols WHERE name = ?',
    ).get('HandleRequest') as { start_line: number; end_line: number } | undefined;
    expect(afterPatch).toBeDefined();
    expect(afterPatch!.start_line).toBe(6);
    // Tree-sitter sees the full method body ending at the closing brace
    expect(afterPatch!.end_line).toBe(10);

    ctx.db.close();
  });

  it('upgrades SCIP term refs into call edges from cached tree-sitter data', async () => {
    const rootDir = makeTmpDir('lore-scip-term-call-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const fnSym = 'typescript npm test 1.0 `main`/fn.';
    const runSym = 'typescript npm test 1.0 `main`/run().';
    const sourceContent = [
      'const fn = () => 1;',
      'export function run(): number {',
      '  return fn();',
      '}',
      '',
    ].join('\n');
    const filePath = join(rootDir, 'main.ts');
    writeFileSync(filePath, sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 6, 0, 8], symbol: fnSym, symbolRoles: SymbolRole.Definition, enclosingRange: [0, 0, 0, 18] },
        { range: [1, 16, 1, 19], symbol: runSym, symbolRoles: SymbolRole.Definition, enclosingRange: [1, 0, 3, 1] },
        { range: [2, 9, 2, 11], symbol: fnSym, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: fnSym, displayName: 'fn', documentation: ['```ts\nconst fn: () => number\n```'] },
        { symbol: runSym, displayName: 'run', documentation: ['```ts\nfunction run(): number\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const ctx = makeContext(rootDir, join(rootDir, 'test.db'));
    const scipStage = new ScipIndexerStage();
    await scipStage.execute(ctx, 'build');

    const sourceStage = new SourceIndexStage();
    await sourceStage.execute(ctx, 'build');
    expect(ctx.scipTreeSitterData?.has(filePath)).toBe(true);

    ctx.sourceCache.clear();
    await new ScipRefStage().execute(ctx, 'build');

    const ref = ctx.db.prepare(
      `SELECT sr.call_kind, sr.call_line, callee.name AS callee_name
       FROM symbol_refs sr
       JOIN symbols caller ON caller.id = sr.caller_id
       JOIN symbols callee ON callee.id = sr.callee_id
       WHERE caller.name = 'run'`,
    ).get() as { call_kind: string; call_line: number; callee_name: string } | undefined;
    expect(ref).toBeDefined();
    expect(ref).toEqual({
      call_kind: 'direct',
      call_line: 2,
      callee_name: 'fn',
    });
    expect(ctx.scipTreeSitterData).toBeUndefined();

    ctx.db.close();
  });

  it('falls back to AST call detection when cached tree-sitter data is unavailable', async () => {
    const rootDir = makeTmpDir('lore-scip-term-ast-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const fnSym = 'typescript npm test 1.0 `main`/fn.';
    const runSym = 'typescript npm test 1.0 `main`/run().';
    const sourceContent = [
      'const fn = () => 1;',
      'export function run(): number {',
      '  return fn();',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 6, 0, 8], symbol: fnSym, symbolRoles: SymbolRole.Definition, enclosingRange: [0, 0, 0, 18] },
        { range: [1, 16, 1, 19], symbol: runSym, symbolRoles: SymbolRole.Definition, enclosingRange: [1, 0, 3, 1] },
        { range: [2, 9, 2, 11], symbol: fnSym, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: fnSym, displayName: 'fn', documentation: ['```ts\nconst fn: () => number\n```'] },
        { symbol: runSym, displayName: 'run', documentation: ['```ts\nfunction run(): number\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const ctx = makeContext(rootDir, join(rootDir, 'test.db'));
    const scipStage = new ScipIndexerStage();
    await scipStage.execute(ctx, 'build');
    expect(ctx.scipTreeSitterData).toBeUndefined();

    await new ScipRefStage().execute(ctx, 'build');

    const refCount = (ctx.db.prepare(
      `SELECT COUNT(*) AS count
       FROM symbol_refs sr
       JOIN symbols caller ON caller.id = sr.caller_id
       JOIN symbols callee ON callee.id = sr.callee_id
       WHERE caller.name = 'run' AND callee.name = 'fn'`,
    ).get() as { count: number }).count;
    expect(refCount).toBe(1);

    ctx.db.close();
  });

  it('reuses cached tree-sitter call and type metadata during SCIP ref insertion', async () => {
    const rootDir = makeTmpDir('lore-scip-tree-data-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const payloadSym = 'typescript npm test 1.0 `main`/Payload#';
    const clientSym = 'typescript npm test 1.0 `main`/Client#';
    const fetchSym = 'typescript npm test 1.0 `main`/Client#fetch().';
    const runSym = 'typescript npm test 1.0 `main`/run().';
    const sourceContent = [
      'type Payload = { value: string };',
      'const helper = (payload: Payload): Payload => payload;',
      'class Client {',
      '  fetch(payload: Payload): Payload {',
      '    return payload;',
      '  }',
      '}',
      'export function run(client: Client, payload: Payload): Payload {',
      '  helper(payload); return client.fetch(payload);',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 5, 0, 12], symbol: payloadSym, symbolRoles: SymbolRole.Definition, enclosingRange: [0, 0, 0, 32] },
        { range: [2, 6, 2, 12], symbol: clientSym, symbolRoles: SymbolRole.Definition, enclosingRange: [2, 0, 6, 1] },
        { range: [3, 2, 3, 7], symbol: fetchSym, symbolRoles: SymbolRole.Definition, enclosingRange: [3, 2, 5, 3] },
        { range: [3, 17, 3, 24], symbol: payloadSym, symbolRoles: 0 },
        { range: [3, 27, 3, 34], symbol: payloadSym, symbolRoles: 0 },
        { range: [7, 16, 7, 19], symbol: runSym, symbolRoles: SymbolRole.Definition, enclosingRange: [7, 0, 9, 1] },
        { range: [7, 28, 7, 34], symbol: clientSym, symbolRoles: 0 },
        { range: [7, 45, 7, 52], symbol: payloadSym, symbolRoles: 0 },
        { range: [7, 55, 7, 62], symbol: payloadSym, symbolRoles: 0 },
        { range: [8, 26, 8, 31], symbol: fetchSym, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: payloadSym, displayName: 'Payload', documentation: ['```ts\ntype Payload = { value: string }\n```'] },
        { symbol: clientSym, displayName: 'Client', documentation: ['```ts\nclass Client\n```'] },
        { symbol: fetchSym, displayName: 'fetch', documentation: ['```ts\nfetch(payload: Payload): Payload\n```'] },
        { symbol: runSym, displayName: 'run', documentation: ['```ts\nfunction run(client: Client, payload: Payload): Payload\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const ctx = makeContext(rootDir, join(rootDir, 'test.db'));
    const scipStage = new ScipIndexerStage();
    await scipStage.execute(ctx, 'build');

    const sourceStage = new SourceIndexStage();
    await sourceStage.execute(ctx, 'build');
    expect(ctx.scipTreeSitterData?.size).toBe(1);

    ctx.sourceCache.clear();
    await new ScipRefStage().execute(ctx, 'build');

    const callRef = ctx.db.prepare(
      `SELECT sr.callee_name, sr.call_line
       FROM symbol_refs sr
       JOIN symbols caller ON caller.id = sr.caller_id
       JOIN symbols callee ON callee.id = sr.callee_id
       WHERE caller.name = 'run' AND callee.name = 'fetch'`,
    ).get() as { callee_name: string; call_line: number } | undefined;
    expect(callRef).toBeDefined();
    expect(callRef!.callee_name).toBe('client.fetch');
    expect(callRef!.call_line).toBe(8);

    const runTypeRefs = ctx.db.prepare(
      `SELECT tr.type_name_bare, tr.ref_kind, tr.ref_line
       FROM type_refs tr
       JOIN symbols caller ON caller.id = tr.symbol_id
       WHERE caller.name = 'run'
       ORDER BY tr.ref_line, tr.type_name_bare`,
    ).all() as Array<{ type_name_bare: string; ref_kind: string; ref_line: number }>;
    expect(runTypeRefs).toEqual([
      { type_name_bare: 'Client', ref_kind: 'parameter', ref_line: 7 },
      { type_name_bare: 'Payload', ref_kind: 'parameter', ref_line: 7 },
      { type_name_bare: 'Payload', ref_kind: 'return', ref_line: 7 },
    ]);
    expect(ctx.scipTreeSitterData).toBeUndefined();

    ctx.db.close();
  });
});
