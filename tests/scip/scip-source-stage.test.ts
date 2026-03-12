/**
 * Integration tests for the SCIP source stage.
 *
 * Covers the full ScipSourceStage.execute path with a real SQLite DB
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
import { ScipSourceStage } from '../../src/indexer/stages/scip-source.js';
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
    docsAutoNotes: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    changedDocPaths: [],
    sourceCache: new Map(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ScipSourceStage', () => {
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

    const stage = new ScipSourceStage();
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

    const stage = new ScipSourceStage();

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
});
