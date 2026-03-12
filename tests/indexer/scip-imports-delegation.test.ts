/**
 * Integration test: verifies that tree-sitter is the authoritative source
 * for `file_imports` even when files are indexed via SCIP.
 *
 * After ScipSourceStage → SourceIndexStage, SCIP-sourced files should have
 * their imports extracted by tree-sitter (not the old regex fallback).
 * This covers static imports, dynamic imports, and re-exports.
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
import { ScipSourceStage } from '../../src/indexer/stages/scip-source.js';
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

describe('SCIP → tree-sitter import delegation', () => {
  it('tree-sitter extracts static imports for SCIP-sourced files', async () => {
    const rootDir = makeTmpDir('lore-scip-ts-imports-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Source file with a static import
    const source = [
      "import { something } from './other.js';",
      "import fs from 'node:fs';",
      '',
      'export function main() { return something(); }',
    ].join('\n');
    writeFileSync(join(rootDir, 'index.ts'), source);
    writeFileSync(join(rootDir, 'other.ts'), 'export function something() {}');

    // SCIP covers index.ts with a definition occurrence for `main`
    const bytes = buildScipIndexBytes([{
      relativePath: 'index.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [3, 16, 3, 20], symbol: 'npm . 0.0.0 index.ts/main().', symbolRoles: SymbolRole.Definition },
      ],
      symbols: [
        { symbol: 'npm . 0.0.0 index.ts/main().', displayName: 'main', documentation: ['function main()'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'ts.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    // Run ScipSourceStage first (populates symbols, NOT imports)
    const scipStage = new ScipSourceStage();
    await scipStage.execute(ctx, 'build');

    // Verify SCIP did NOT insert imports
    const importsAfterScip = ctx.db.prepare('SELECT * FROM file_imports').all();
    expect(importsAfterScip).toHaveLength(0);

    // Run SourceIndexStage (extracts imports via tree-sitter for SCIP files)
    const sourceStage = new SourceIndexStage();
    await sourceStage.execute(ctx, 'build');
    await sourceStage.dispose();

    // Tree-sitter should have extracted both imports
    const imports = ctx.db.prepare(
      'SELECT fi.raw_import FROM file_imports fi JOIN files f ON fi.file_id = f.id WHERE f.path = ?',
    ).all(join(rootDir, 'index.ts')) as Array<{ raw_import: string }>;

    const rawImports = imports.map(r => r.raw_import).sort();
    expect(rawImports).toContain('./other.js');
    expect(rawImports).toContain('node:fs');
  });

  it('tree-sitter extracts dynamic imports for SCIP-sourced files', async () => {
    const rootDir = makeTmpDir('lore-scip-dynamic-import-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const source = [
      'export async function loadConfig() {',
      "  const mod = await import('./config.js');",
      '  return mod.default;',
      '}',
    ].join('\n');
    writeFileSync(join(rootDir, 'loader.ts'), source);
    writeFileSync(join(rootDir, 'config.ts'), 'export default { key: "value" };');

    const bytes = buildScipIndexBytes([{
      relativePath: 'loader.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 22, 0, 32], symbol: 'npm . 0.0.0 loader.ts/loadConfig().', symbolRoles: SymbolRole.Definition },
      ],
      symbols: [
        { symbol: 'npm . 0.0.0 loader.ts/loadConfig().', displayName: 'loadConfig', documentation: ['async function loadConfig()'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'ts.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const scipStage = new ScipSourceStage();
    await scipStage.execute(ctx, 'build');

    const sourceStage = new SourceIndexStage();
    await sourceStage.execute(ctx, 'build');
    await sourceStage.dispose();

    const imports = ctx.db.prepare(
      'SELECT fi.raw_import FROM file_imports fi JOIN files f ON fi.file_id = f.id WHERE f.path = ?',
    ).all(join(rootDir, 'loader.ts')) as Array<{ raw_import: string }>;

    expect(imports.map(r => r.raw_import)).toContain('./config.js');
  });

  it('ScipSourceStage does not insert file_imports', async () => {
    const rootDir = makeTmpDir('lore-scip-no-imports-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Source with an import AND a SymbolRole.Import occurrence in SCIP
    const source = "import { foo } from './bar.js';\nexport const x = foo();";
    writeFileSync(join(rootDir, 'a.ts'), source);

    const bytes = buildScipIndexBytes([{
      relativePath: 'a.ts',
      language: 'TypeScript',
      occurrences: [
        // Import occurrence — previously this would trigger regex extraction
        { range: [0, 9, 0, 12], symbol: 'npm . 0.0.0 bar.ts/foo().', symbolRoles: SymbolRole.Import },
        { range: [1, 18, 1, 21], symbol: 'npm . 0.0.0 bar.ts/foo().', symbolRoles: 0 },
      ],
      symbols: [
        { symbol: 'npm . 0.0.0 bar.ts/foo().', displayName: 'foo' },
      ],
    }]);
    writeFileSync(join(indexDir, 'ts.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath);

    const scipStage = new ScipSourceStage();
    await scipStage.execute(ctx, 'build');

    // ScipSourceStage should NOT have inserted any file_imports
    const imports = ctx.db.prepare('SELECT * FROM file_imports').all();
    expect(imports).toHaveLength(0);
  });
});
