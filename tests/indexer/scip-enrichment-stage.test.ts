/**
 * Tests for the ScipEnrichmentStage pipeline stage and its
 * enrichProjectRefsWithScip helper.
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
import { ScipEnrichmentStage } from '../../src/indexer/stages/scip-enrichment.js';
import { enrichProjectRefsWithScip } from '../../src/indexer/stages/scip-enrichment.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { initLogger, LogLevel } from '../../src/logger.js';
import { resolveEffectiveScipSettings } from '../../src/scip/config.js';
import { ScipEnrichmentCoordinator } from '../../src/scip/enrichment.js';

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
  symbols?: Array<{ symbol: string; documentation?: string[]; displayName?: string }>;
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

function makeContext(rootDir: string, dbPath: string, scipEnabled = true): PipelineContext {
  const db = openDb(dbPath);
  return {
    db,
    dbPath,
    walkerConfig: { rootDir },
    branch: 'HEAD',
    lsp: null,
    scip: resolveEffectiveScipSettings({}, { enabled: scipEnabled, indexDir: '.scip-indexes' }),
    embedder: null,
    log: initLogger({ level: LogLevel.SILENT }),
    files: [],
    indexDependencies: false,
    history: false,
    docsAutoNotes: false,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ScipEnrichmentStage', () => {
  it('returns early when SCIP is disabled', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-disabled-');
    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath, false);

    const stage = new ScipEnrichmentStage();
    await stage.execute(ctx, 'build');

    // No scipCoveredLanguages should be set
    expect(ctx.scipCoveredLanguages).toBeUndefined();
    ctx.db.close();
  });

  it('returns early when files list is empty', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-empty-');
    const dbPath = join(rootDir, 'test.db');
    const ctx = makeContext(rootDir, dbPath, true);
    ctx.files = [];

    const stage = new ScipEnrichmentStage();
    await stage.execute(ctx, 'build');

    expect(ctx.scipCoveredLanguages).toBeUndefined();
    ctx.db.close();
  });

  it('dispose is safe to call without prior execute', async () => {
    const stage = new ScipEnrichmentStage();
    await expect(stage.dispose()).resolves.toBeUndefined();
  });
});

describe('enrichProjectRefsWithScip', () => {
  it('enriches symbols with SCIP-derived type signatures', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-sym-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const symA = 'typescript npm @types/node 1.0 `fs`/readFile().';
    const sourceContent = 'function readFile(path: string): Buffer {\n  return Buffer.from("");\n}\n';
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        // character 0 matches what the enrichment stage queries for symbols
        { range: [0, 0, 0, 17], symbol: symA, symbolRoles: SymbolRole.Definition },
      ],
      symbols: [
        { symbol: symA, displayName: 'readFile', documentation: ['```ts\nfunction readFile(path: string): Buffer\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const db = openDb(dbPath);

    // Insert a file and symbol into the DB
    db.prepare('INSERT INTO files (path, language, branch, last_hash) VALUES (?, ?, ?, ?)').run(
      join(rootDir, 'main.ts'), 'typescript', 'HEAD', 'abc123',
    );
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(join(rootDir, 'main.ts')) as any).id;
    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(fileId, 'readFile', 'function', 0, 2, 'function readFile(path: string): Buffer');
    const symbolId = (db.prepare('SELECT id FROM symbols WHERE name = ?').get('readFile') as any).id;
    // Insert FTS row
    db.prepare('INSERT INTO symbols_fts (rowid, name, signature) VALUES (?, ?, ?)').run(symbolId, 'readFile', 'function readFile(path: string): Buffer');

    // Create coordinator with precomputed index
    const settings = resolveEffectiveScipSettings({}, { enabled: true, indexDir: '.scip-indexes' });
    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    await coordinator.start(new Set(['typescript']));

    await enrichProjectRefsWithScip(
      db, 'HEAD',
      [{ path: join(rootDir, 'main.ts'), language: 'typescript' }],
      coordinator,
    );

    const enriched = db.prepare('SELECT resolved_type_signature FROM symbols WHERE id = ?').get(symbolId) as any;
    expect(enriched.resolved_type_signature).toBeTruthy();

    await coordinator.dispose();
    db.close();
  });

  it('enriches call refs with SCIP definition location', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-callref-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const symDef = 'typescript npm test 1.0 `main`/greet().';
    const symCall = 'typescript npm test 1.0 `main`/greet().';
    const sourceContent = 'function greet() { return "hi"; }\ngreet();\n';
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 9, 0, 14], symbol: symDef, symbolRoles: SymbolRole.Definition },
        { range: [1, 0, 1, 5], symbol: symCall, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: symDef, displayName: 'greet', documentation: ['```ts\nfunction greet(): string\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const db = openDb(dbPath);

    // Insert file and two symbols (caller + callee)
    db.prepare('INSERT INTO files (path, language, branch, last_hash) VALUES (?, ?, ?, ?)').run(
      join(rootDir, 'main.ts'), 'typescript', 'HEAD', 'abc123',
    );
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(join(rootDir, 'main.ts')) as any).id;

    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'greet', 'function', 0, 0);
    const callerId = (db.prepare('SELECT id FROM symbols WHERE name = ?').get('greet') as any).id;

    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, '<module>', 'module', 0, 2);
    const moduleId = (db.prepare("SELECT id FROM symbols WHERE name = '<module>'").get() as any).id;

    // Insert FTS rows
    db.prepare('INSERT INTO symbols_fts (rowid, name, signature) VALUES (?, ?, ?)').run(callerId, 'greet', '');
    db.prepare('INSERT INTO symbols_fts (rowid, name, signature) VALUES (?, ?, ?)').run(moduleId, '<module>', '');

    // Insert a call ref from module → greet at line 1
    db.prepare(
      'INSERT INTO symbol_refs (caller_id, callee_name, call_line, call_character, resolution_method) VALUES (?, ?, ?, ?, ?)',
    ).run(moduleId, 'greet', 1, 0, 'unresolved');
    const refId = (db.prepare('SELECT id FROM symbol_refs WHERE callee_name = ?').get('greet') as any).id;

    const settings = resolveEffectiveScipSettings({}, { enabled: true, indexDir: '.scip-indexes' });
    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    await coordinator.start(new Set(['typescript']));

    await enrichProjectRefsWithScip(
      db, 'HEAD',
      [{ path: join(rootDir, 'main.ts'), language: 'typescript' }],
      coordinator,
    );

    const enrichedRef = db.prepare('SELECT definition_path, definition_line FROM symbol_refs WHERE id = ?').get(refId) as any;
    // The call ref should have been enriched with definition info
    expect(enrichedRef.definition_path).toBeTruthy();

    await coordinator.dispose();
    db.close();
  });

  it('skips files that do not exist on disk', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-nofile-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const bytes = buildScipIndexBytes([{
      relativePath: 'missing.ts',
      language: 'TypeScript',
      occurrences: [],
      symbols: [],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const db = openDb(dbPath);

    const settings = resolveEffectiveScipSettings({}, { enabled: true, indexDir: '.scip-indexes' });
    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    await coordinator.start(new Set(['typescript']));

    // Should not throw for a non-existent file
    await expect(
      enrichProjectRefsWithScip(
        db, 'HEAD',
        [{ path: join(rootDir, 'missing.ts'), language: 'typescript' }],
        coordinator,
      ),
    ).resolves.toBeUndefined();

    await coordinator.dispose();
    db.close();
  });

  it('skips files for languages not covered by SCIP', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-nolang-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    writeFileSync(join(rootDir, 'main.py'), 'def hello(): pass\n');

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [],
      symbols: [],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const db = openDb(dbPath);

    const settings = resolveEffectiveScipSettings({}, { enabled: true, indexDir: '.scip-indexes' });
    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    // Only start typescript, not python
    await coordinator.start(new Set(['typescript']));

    // python file should be skipped without error
    await expect(
      enrichProjectRefsWithScip(
        db, 'HEAD',
        [{ path: join(rootDir, 'main.py'), language: 'python' }],
        coordinator,
      ),
    ).resolves.toBeUndefined();

    await coordinator.dispose();
    db.close();
  });

  it('enriches type refs with definition metadata', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-typeref-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const typeSym = 'typescript npm test 1.0 `main`/MyType#';
    const sourceContent = 'interface MyType { x: number; }\nconst v: MyType = { x: 1 };\n';
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 10, 0, 16], symbol: typeSym, symbolRoles: SymbolRole.Definition },
        { range: [1, 9, 1, 15], symbol: typeSym, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: typeSym, displayName: 'MyType', documentation: ['```ts\ninterface MyType\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const db = openDb(dbPath);

    db.prepare('INSERT INTO files (path, language, branch, last_hash) VALUES (?, ?, ?, ?)').run(
      join(rootDir, 'main.ts'), 'typescript', 'HEAD', 'abc123',
    );
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(join(rootDir, 'main.ts')) as any).id;

    // Insert a type ref
    db.prepare(
      'INSERT INTO type_refs (file_id, type_name, type_name_bare, ref_line, ref_character) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'MyType', 'MyType', 1, 9);
    const typeRefId = (db.prepare('SELECT id FROM type_refs WHERE type_name = ?').get('MyType') as any).id;

    const settings = resolveEffectiveScipSettings({}, { enabled: true, indexDir: '.scip-indexes' });
    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    await coordinator.start(new Set(['typescript']));

    await enrichProjectRefsWithScip(
      db, 'HEAD',
      [{ path: join(rootDir, 'main.ts'), language: 'typescript' }],
      coordinator,
    );

    const enrichedTypeRef = db.prepare('SELECT definition_path, definition_line FROM type_refs WHERE id = ?').get(typeRefId) as any;
    expect(enrichedTypeRef.definition_path).toBeTruthy();

    await coordinator.dispose();
    db.close();
  });

  it('enriches symbol_relationships with definition metadata', async () => {
    const rootDir = makeTmpDir('lore-scip-enrich-rel-');
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const parentSym = 'typescript npm test 1.0 `main`/Base#';
    const childSym = 'typescript npm test 1.0 `main`/Child#';
    const sourceContent = 'class Base {}\nclass Child extends Base {}\n';
    writeFileSync(join(rootDir, 'main.ts'), sourceContent);

    const bytes = buildScipIndexBytes([{
      relativePath: 'main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [0, 6, 0, 10], symbol: parentSym, symbolRoles: SymbolRole.Definition },
        { range: [1, 6, 1, 11], symbol: childSym, symbolRoles: SymbolRole.Definition },
        { range: [1, 20, 1, 24], symbol: parentSym, symbolRoles: 0 },
      ],
      symbols: [
        { symbol: parentSym, displayName: 'Base', documentation: ['```ts\nclass Base\n```'] },
        { symbol: childSym, displayName: 'Child', documentation: ['```ts\nclass Child extends Base\n```'] },
      ],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), bytes);

    const dbPath = join(rootDir, 'test.db');
    const db = openDb(dbPath);

    db.prepare('INSERT INTO files (path, language, branch, last_hash) VALUES (?, ?, ?, ?)').run(
      join(rootDir, 'main.ts'), 'typescript', 'HEAD', 'abc123',
    );
    const fileId = (db.prepare('SELECT id FROM files WHERE path = ?').get(join(rootDir, 'main.ts')) as any).id;

    // Insert symbols
    db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    ).run(fileId, 'Child', 'class', 1, 1);
    const childId = (db.prepare('SELECT id FROM symbols WHERE name = ?').get('Child') as any).id;
    db.prepare('INSERT INTO symbols_fts (rowid, name, signature) VALUES (?, ?, ?)').run(childId, 'Child', '');

    // Insert a relationship: Child extends Base at line 1 char 20
    db.prepare(
      'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, character) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(fileId, childId, 'Base', 'extends', 1, 20);
    const relId = (db.prepare('SELECT id FROM symbol_relationships WHERE target_symbol_name = ?').get('Base') as any).id;

    const settings = resolveEffectiveScipSettings({}, { enabled: true, indexDir: '.scip-indexes' });
    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    await coordinator.start(new Set(['typescript']));

    await enrichProjectRefsWithScip(
      db, 'HEAD',
      [{ path: join(rootDir, 'main.ts'), language: 'typescript' }],
      coordinator,
    );

    const enrichedRel = db.prepare('SELECT definition_path, definition_line FROM symbol_relationships WHERE id = ?').get(relId) as any;
    expect(enrichedRel.definition_path).toBeTruthy();

    await coordinator.dispose();
    db.close();
  });
});
