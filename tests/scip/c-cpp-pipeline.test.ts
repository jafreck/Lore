import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, type Database } from '../../src/db/schema.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';
import { resolveEffectiveLspSettings } from '../../src/lsp/config.js';
import { IndexSchema, SymbolRole, type Index as ScipIndex } from '../../src/scip/scip_pb.js';
import {
  discoverCompilationDatabase,
  loadCompilationDatabase,
} from '../../src/scip/compdb.js';
import { handler as dependentsHandler } from '../../src/server/tools/dependents.js';
import { handler as graphHandler } from '../../src/server/tools/graph.js';
import { handler as lookupHandler } from '../../src/server/tools/lookup.js';
import { handler as searchHandler } from '../../src/server/tools/search.js';
import { handler as snippetHandler } from '../../src/server/tools/snippet.js';
import { handler as traceHandler } from '../../src/server/tools/trace.js';
import { validateIndex } from '../../src/validation/index-health.js';

const PROJECTS_DIR = path.resolve(__dirname, '../fixtures/scip-projects');
const INDEXES_DIR = path.join(PROJECTS_DIR, 'scip-indexes');
const MAX_FIXTURE_INDEX_BYTES = 128 * 1024;

type FixtureLanguage = 'c' | 'cpp';

interface BuiltFixture {
  language: FixtureLanguage;
  rootDir: string;
  dbPath: string;
  db: Database.Database;
}

const built = new Map<FixtureLanguage, BuiltFixture>();
let temporaryDirectory: string;

function readFixtureIndex(language: FixtureLanguage): ScipIndex {
  return fromBinary(
    IndexSchema,
    fs.readFileSync(path.join(INDEXES_DIR, `${language}.scip`)),
  );
}

function relativePath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/');
}

async function buildFixture(language: FixtureLanguage): Promise<BuiltFixture> {
  const rootDir = path.join(PROJECTS_DIR, language);
  const indexDirectory = path.join(temporaryDirectory, `${language}-indexes`);
  const dbPath = path.join(temporaryDirectory, `${language}.db`);
  fs.mkdirSync(indexDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(INDEXES_DIR, `${language}.scip`),
    path.join(indexDirectory, `${language}.scip`),
  );

  const builder = new IndexBuilder(dbPath, { rootDir }, undefined, {
    scip: {
      enabled: true,
      timeoutMs: 5_000,
      allowBuildExecution: false,
      indexers: {},
      indexDir: path.relative(rootDir, indexDirectory),
    },
    execution: { allowedCwdRoots: [indexDirectory] },
    lsp: resolveEffectiveLspSettings({}, { enabled: false }),
    maxWorkers: 0,
    validation: false,
  });
  await builder.build();

  return { language, rootDir, dbPath, db: openDb(dbPath) };
}

beforeAll(async () => {
  resetLogger();
  initLogger({ level: LogLevel.SILENT });
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-c-cpp-fixtures-'));
  built.set('c', await buildFixture('c'));
  built.set('cpp', await buildFixture('cpp'));
});

afterAll(() => {
  for (const fixture of built.values()) fixture.db.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  resetLogger();
});

describe('committed scip-clang fixture indexes', () => {
  it.each<FixtureLanguage>(['c', 'cpp'])('%s index is compact, canonical, and relocatable', (language) => {
    const indexPath = path.join(INDEXES_DIR, `${language}.scip`);
    const index = readFixtureIndex(language);

    expect(fs.statSync(indexPath).size).toBeLessThan(MAX_FIXTURE_INDEX_BYTES);
    expect(index.metadata?.projectRoot).toBe('.');
    expect(index.metadata?.toolInfo?.name).toBe('scip-clang');
    expect(index.metadata?.toolInfo?.version).toMatch(/^0\.4\./u);
    expect(index.metadata?.toolInfo?.arguments).toEqual([]);
    expect(index.documents.length).toBeGreaterThan(1);
    expect(index.documents.every((document) => (
      !path.isAbsolute(document.relativePath) && !document.relativePath.includes('..')
    ))).toBe(true);
  });

  it('C index distinguishes declarations from implementations and preserves both configurations', () => {
    const index = readFixtureIndex('c');
    const occurrences = index.documents.flatMap((document) => (
      document.occurrences.map((occurrence) => ({ document, occurrence }))
    ));
    const byName = (name: string) => occurrences.filter(({ occurrence }) => (
      occurrence.symbol.includes(`${name}(`)
    ));

    const addOccurrences = byName('lore_add');
    expect(addOccurrences.some(({ document, occurrence }) => (
      document.relativePath.endsWith('api.h')
      && (occurrence.symbolRoles & SymbolRole.Definition) === 0
    ))).toBe(true);
    expect(addOccurrences.some(({ document, occurrence }) => (
      document.relativePath === 'src/api.c'
      && (occurrence.symbolRoles & SymbolRole.Definition) !== 0
    ))).toBe(true);
    expect(byName('lore_declared_only').some(({ occurrence }) => (
      (occurrence.symbolRoles & SymbolRole.Definition) !== 0
    ))).toBe(false);
    expect(index.documents.filter((document) => document.relativePath === 'src/configured.c').length)
      .toBeGreaterThan(1);
  });

  it('C++ index contains namespace, template, overload, and inheritance facts', () => {
    const index = readFixtureIndex('cpp');
    const symbols = index.documents.flatMap((document) => document.symbols);

    expect(symbols.some((symbol) => symbol.symbol.includes('lore_fixture/'))).toBe(true);
    expect(symbols.some((symbol) => symbol.symbol.includes('/doubled('))).toBe(true);
    expect(symbols.filter((symbol) => symbol.symbol.includes('/Derived#compute(')).length)
      .toBeGreaterThan(1);
    expect(symbols.some((symbol) => (
      symbol.symbol.includes('/Derived#')
      && symbol.relationships.some((relationship) => relationship.symbol.includes('/Base#'))
    ))).toBe(true);
    expect(index.documents.filter((document) => document.relativePath === 'src/configured.cpp').length)
      .toBeGreaterThan(1);
  });
});

describe('C fixture ingestion regressions', () => {
  it('handles duplicate header basenames using per-TU include paths', () => {
    const fixture = built.get('c')!;
    const rows = fixture.db.prepare(
      `SELECT source.path AS source_path, target.path AS target_path
       FROM file_imports fi
       JOIN files source ON source.id = fi.file_id
       JOIN files target ON target.id = fi.resolved_id
       WHERE fi.raw_import = 'config.h'
       ORDER BY source.path`,
    ).all() as Array<{ source_path: string; target_path: string }>;

    expect(rows.map((row) => [
      relativePath(fixture.rootDir, row.source_path),
      relativePath(fixture.rootDir, row.target_path),
    ])).toEqual([
      ['src/alpha_mode.c', 'include/alpha/config.h'],
      ['src/beta_mode.c', 'include/beta/config.h'],
    ]);
  });

  it('indexes generated translation units, C types, typedefs, macros, and cross-file calls', () => {
    const fixture = built.get('c')!;
    const symbolNames = new Set(
      (fixture.db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>).map((row) => row.name),
    );
    const generated = fixture.db.prepare(
      `SELECT s.name
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE f.path LIKE '%/generated/record_generated.c'`,
    ).all() as Array<{ name: string }>;
    const typeNames = new Set(
      (fixture.db.prepare('SELECT type_name FROM type_refs').all() as Array<{ type_name: string }>).map((row) => row.type_name),
    );
    const runCalls = new Set(
      (fixture.db.prepare(
        `SELECT sr.callee_name
         FROM symbol_refs sr JOIN symbols caller ON caller.id = sr.caller_id
         WHERE caller.name = 'lore_run'`,
      ).all() as Array<{ callee_name: string }>).map((row) => row.callee_name),
    );

    expect(generated.map((row) => row.name)).toContain('lore_generated_record');
    expect([...symbolNames]).toEqual(expect.arrayContaining([
      'LoreRecord',
      'lore_id_t',
      'LORE_FIXTURE_SCALE',
      'LORE_FIXTURE_MAGIC',
    ]));
    expect([...typeNames]).toEqual(expect.arrayContaining(['LoreRecord', 'lore_id_t']));
    expect([...runCalls]).toEqual(expect.arrayContaining(['lore_add', 'lore_make_record']));
  });

  it('merges mutually exclusive duplicate configurations without duplicate active rows', () => {
    const fixture = built.get('c')!;
    const symbols = fixture.db.prepare(
      "SELECT id FROM symbols WHERE name = 'lore_configured_value'",
    ).all() as Array<{ id: number }>;
    expect(symbols).toHaveLength(1);

    const calls = fixture.db.prepare(
      'SELECT callee_name FROM symbol_refs WHERE caller_id = ?',
    ).all(symbols[0]!.id) as Array<{ callee_name: string }>;
    expect(calls.map((row) => row.callee_name)).toEqual(expect.arrayContaining([
      'lore_fast_path',
      'lore_safe_path',
    ]));
    expect(fixture.db.prepare(
      'SELECT path, branch, count(*) AS count FROM files GROUP BY path, branch HAVING count(*) > 1',
    ).all()).toEqual([]);
  });

  it('classifies plain C headers from project evidence instead of scip-clang CPP tags', () => {
    const fixture = built.get('c')!;
    const headers = fixture.db.prepare(
      "SELECT language FROM files WHERE path LIKE '%.h'",
    ).all() as Array<{ language: string }>;
    expect(headers.length).toBeGreaterThan(0);
    expect(new Set(headers.map((header) => header.language))).toEqual(new Set(['c']));
  });
});

describe('C++ fixture ingestion regressions', () => {
  it('retains class, overload, template, inheritance, generated, and configured facts', () => {
    const fixture = built.get('cpp')!;
    const symbolNames = (fixture.db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>).map((row) => row.name);
    expect(symbolNames).toEqual(expect.arrayContaining([
      'Base',
      'Derived',
      'Calculator',
      'LegacyFlag',
      'doubled',
      'LORE_CPP_BIAS',
      'generated_packet',
    ]));
    expect(symbolNames.filter((name) => name === 'compute').length).toBeGreaterThan(1);
    expect(symbolNames.filter((name) => name === 'combine').length).toBeGreaterThan(1);

    const inheritance = fixture.db.prepare(
      `SELECT source.name AS source_name, rel.target_symbol_name
       FROM symbol_relationships rel
       JOIN symbols source ON source.id = rel.source_symbol_id
       WHERE rel.relationship_type = 'extends'`,
    ).all() as Array<{ source_name: string; target_symbol_name: string }>;
    expect(inheritance).toContainEqual({ source_name: 'Derived', target_symbol_name: 'Base' });

    const configured = fixture.db.prepare(
      "SELECT id FROM symbols WHERE name = 'cpp_configured_value'",
    ).get() as { id: number };
    const configuredCalls = fixture.db.prepare(
      'SELECT callee_name FROM symbol_refs WHERE caller_id = ?',
    ).all(configured.id) as Array<{ callee_name: string }>;
    expect(configuredCalls.map((row) => row.callee_name)).toEqual(expect.arrayContaining([
      'cpp_fast_path',
      'cpp_safe_path',
    ]));
  });

  it('classifies a .h file used by C++ as cpp', () => {
    const fixture = built.get('cpp')!;
    expect(fixture.db.prepare(
      "SELECT language FROM files WHERE path LIKE '%/include/lore_fixture/compat.h'",
    ).get()).toEqual({ language: 'cpp' });
  });
});

describe('C/C++ position and health guarantees', () => {
  it.each([
    ['c', 'lore_unicode_value'],
    ['cpp', 'cpp_run'],
  ] as const)('normalizes real scip-clang Unicode byte offsets for %s', (language, symbolName) => {
    const fixture = built.get(language)!;
    const row = fixture.db.prepare(
      `SELECT s.selection_line, s.selection_character, f.source
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.name = ?`,
    ).get(symbolName) as { selection_line: number; selection_character: number; source: string };
    const line = row.source.split('\n')[row.selection_line]!;
    expect(row.selection_character).toBe(line.indexOf(symbolName));
    expect(line.slice(row.selection_character, row.selection_character + symbolName.length)).toBe(symbolName);
  });

  it.each<FixtureLanguage>(['c', 'cpp'])('%s fixture passes migration-grade index validation', (language) => {
    const fixture = built.get(language)!;
    const report = validateIndex(fixture.db, {
      rootDir: fixture.rootDir,
      policy: {
        profile: 'migration-grade',
        thresholds: {
          minFiles: 1,
          minSymbols: 1,
          minCallRefs: 1,
          minTypeRefs: 1,
          minImports: 1,
          minSymbolCoverage: 1,
          maxSymbolLessFiles: 0,
          maxInvalidSpans: 0,
          maxDuplicateSymbols: 0,
        },
      },
    });

    expect(report.ok, report.errors.map((error) => error.message).join('\n')).toBe(true);
    expect(report.profile).toBe('migration-grade');
    expect(report.spans.invalid).toBe(0);
    expect(report.duplicates.paths.excessRows).toBe(0);
    expect(report.provenance.indexers).toContainEqual(expect.objectContaining({
      provider: 'scip',
      status: 'succeeded',
    }));
  });
});

describe.each([
  { language: 'c' as const, entry: 'lore_run', target: 'lore_add', source: 'src/main.c' },
  { language: 'cpp' as const, entry: 'cpp_run', target: 'invoke', source: 'src/main.cpp' },
])('$language real tool-handler end to end', ({ language, entry, target, source }) => {
  it('serves lookup, search, graph, dependents, snippet, and trace from one real index', async () => {
    const fixture = built.get(language)!;
    const entryLookup = await lookupHandler(fixture.db, { kind: 'symbol', query: entry });
    const targetLookup = await lookupHandler(fixture.db, { kind: 'symbol', query: target });
    expect(entryLookup.results).toHaveLength(1);
    expect(targetLookup.results).toHaveLength(1);
    const entryRow = entryLookup.results[0] as { id: number };
    const targetRow = targetLookup.results[0] as { id: number };

    const search = await searchHandler(fixture.db, { query: entry, mode: 'structural' });
    expect(search.results.some((result) => result.name === entry)).toBe(true);

    const graph = graphHandler(fixture.db, { kind: 'call', source_id: entryRow.id });
    expect(graph.edges.some((edge) => edge.target_name === target)).toBe(true);

    const dependents = dependentsHandler(fixture.db, { kind: 'symbol', query: target });
    expect(dependents.dependents.callers.some((caller) => caller.caller_name === entry)).toBe(true);

    const snippet = snippetHandler(fixture.db, {
      path: path.join(fixture.rootDir, source),
      symbol: entry,
    });
    expect(snippet.text).toContain(entry);
    expect(snippet.containing_symbol?.name).toBe(entry);

    const trace = traceHandler(fixture.db, {
      from: entryRow.id,
      to: targetRow.id,
      depth: 3,
    });
    expect(trace.steps.map((step) => step.name)).toEqual([entry, target]);
    expect(trace.steps.every((step) => step.source.length > 0)).toBe(true);
  });
});

describe('compilation database regressions', () => {
  it.each<FixtureLanguage>(['c', 'cpp'])('%s fixture compdb is relative, valid, and includes duplicate configurations', (language) => {
    const rootDir = path.join(PROJECTS_DIR, language);
    const compdbPath = path.join(rootDir, 'compile_commands.json');
    const raw = fs.readFileSync(compdbPath, 'utf8');
    const loaded = loadCompilationDatabase(compdbPath, undefined, rootDir);

    expect(raw).not.toContain(rootDir);
    expect(loaded.validation.status).toBe('valid');
    expect(loaded.database?.entries.every((entry) => entry.filePath.startsWith(`${rootDir}${path.sep}`)))
      .toBe(true);
    const filePaths = loaded.database!.entries.map((entry) => entry.filePath);
    expect(new Set(filePaths).size).toBeLessThan(filePaths.length);
  });

  it('ignores a relocated top-level compdb and selects a healthy build candidate', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-relocated-compdb-'));
    try {
      const sourcePath = path.join(rootDir, 'src', 'main.c');
      const buildDir = path.join(rootDir, 'build');
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(sourcePath, 'int main(void) { return 0; }\n');
      fs.writeFileSync(path.join(rootDir, 'compile_commands.json'), JSON.stringify([{
        directory: '/relocated/build',
        file: '/relocated/src/main.c',
        arguments: ['clang', '-c', '/relocated/src/main.c'],
      }]));
      fs.writeFileSync(path.join(buildDir, 'compile_commands.json'), JSON.stringify([{
        directory: buildDir,
        file: sourcePath,
        arguments: ['clang', '-c', sourcePath],
      }]));

      const discovery = discoverCompilationDatabase(rootDir);
      expect(discovery.candidates[0]?.validation.status).toBe('relocated');
      expect(discovery.database?.path).toBe(path.join(buildDir, 'compile_commands.json'));
      expect(discovery.database?.validation.status).toBe('valid');
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});