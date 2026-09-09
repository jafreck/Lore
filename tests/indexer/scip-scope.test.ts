import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexBuilder, type IndexBuilderOptions } from '../../src/indexer/index.js';
import { validateIndex, IndexValidationError } from '../../src/validation/index-health.js';
import { openDb } from '../../src/db/schema.js';
import { buildScipIndexBuffer, SymbolRole } from '../helpers/scipFixture.js';

let rootDir: string;
let dbPath: string;
const scope = { languages: ['c'], includeGlobs: ['lib/**/*.{c,h}'] };
const lines = ['int helper(void) { return 1; }', 'int main(void) { return helper(); }'];
const helperSymbol = 'scip-clang local fixture 1 lib/main.c/helper().';
const mainSymbol = 'scip-clang local fixture 1 lib/main.c/main().';

beforeEach(() => {
  rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'lore-scoped-build-')));
  dbPath = join(rootDir, 'lore.db');
  mkdirSync(join(rootDir, 'lib'));
  mkdirSync(join(rootDir, '.scip'));
  writeFileSync(join(rootDir, 'lib/main.c'), `${lines.join('\n')}\n`);
  writeFileSync(join(rootDir, 'helper.py'), 'def ancillary():\n    pass\n');
  writeFileSync(join(rootDir, '.scip/index.scip'), buildScipIndexBuffer([
    {
      relativePath: 'lib/main.c', language: 'c',
      occurrences: [
        { symbol: helperSymbol, symbolRoles: SymbolRole.Definition, range: [0, 4, 10], enclosingRange: [0, 0, 0, lines[0]!.length] },
        { symbol: mainSymbol, symbolRoles: SymbolRole.Definition, range: [1, 4, 8], enclosingRange: [1, 0, 1, lines[1]!.length] },
        { symbol: helperSymbol, symbolRoles: 0, range: [1, lines[1]!.indexOf('helper'), lines[1]!.indexOf('helper') + 6] },
      ],
      symbols: [{ symbol: helperSymbol, displayName: 'helper' }, { symbol: mainSymbol, displayName: 'main' }],
    },
    { relativePath: 'helper.py', language: 'python' },
  ]));
});

afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

function builder(overrides: IndexBuilderOptions = {}): IndexBuilder {
  return new IndexBuilder(dbPath, { rootDir, branch: 'main' }, undefined, {
    scip: { indexDir: '.scip' }, scipScope: scope, lsp: false, embeddings: false,
    validation: { profile: 'migration-grade', thresholds: { minCallRefs: 1 } },
    ...overrides,
  });
}

describe('scoped baseline validation', () => {
  it('rechecks recorded semantic requirements when validating a persisted baseline', async () => {
    const index = builder({ validation: {
      profile: 'migration-grade',
      requiredCalls: [{ caller: { name: 'main' }, callee: { name: 'helper' }, resolutionMethod: 'scip_definition' }],
    } });
    await index.build();
    expect(index.validate('migration-grade').ok).toBe(true);
    const db = openDb(dbPath);
    db.prepare('DELETE FROM symbol_refs').run();
    db.close();
    expect(index.validate('migration-grade').errors)
      .toContainEqual(expect.objectContaining({ code: 'REQUIRED_CALL_MISSING' }));
  });

  it('blocks promotion when a required call is missing even when aggregate call coverage passes', async () => {
    await builder().build();
    writeFileSync(join(rootDir, '.lore.config'), JSON.stringify({ validation: { requiredCalls: [] } }));
    const index = builder({ validation: {
      profile: 'migration-grade', thresholds: { minCallRefs: 1 },
      requiredSymbols: [{ name: 'main', path: 'lib/main.c', kind: 'function' }],
      requiredCalls: [{ caller: { name: 'helper' }, callee: { name: 'main' } }],
    } });
    await expect(index.baselineRebuild()).rejects.toBeInstanceOf(IndexValidationError);
    expect(index.lastValidationReport!.coverage.overall.calls.total).toBe(1);
    expect(index.lastValidationReport!.errors).toContainEqual(expect.objectContaining({ code: 'REQUIRED_CALL_MISSING' }));
    const db = openDb(dbPath);
    expect(db.prepare('SELECT generation FROM baseline_generations WHERE branch = ?').get('main')).toEqual({ generation: 1 });
    db.close();
  });

  it('never promotes an exit-zero compiler failure over a healthy baseline and persists the diagnostics', async () => {
    await builder().build();
    writeFileSync(join(rootDir, 'compile_commands.json'), JSON.stringify([{
      directory: rootDir, file: 'lib/main.c', arguments: ['cc', '-c', 'lib/main.c'],
    }]));
    const index = builder({
      scip: { indexers: { c: {
        command: process.execPath,
        args: ['--eval', 'require("node:fs").copyFileSync(process.argv[1], process.argv[3]); process.stderr.write("lib/main.c:1:1: fatal error: missing header\\n");', '.scip/index.scip', '{compdb}', '{output}'],
      } } },
      execution: { allowCustomIndexerCommands: true },
    });
    await expect(index.baselineRebuild()).rejects.toBeInstanceOf(IndexValidationError);
    expect(index.lastValidationReport!.errors).toContainEqual(expect.objectContaining({ code: 'SCIP_COMPILER_ERRORS' }));
    expect(index.lastValidationReport!.provenance.indexers).toContainEqual(expect.objectContaining({
      provider: 'scip', status: 'failed',
      details: expect.objectContaining({ compilerDiagnostics: expect.objectContaining({
        complete: true, summary: expect.objectContaining({ errors: 1, fatalErrors: 1 }),
      }) }),
    }));
    const db = openDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS count FROM effective_symbols').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT generation FROM baseline_generations WHERE branch = ?').get('main')).toEqual({ generation: 1 });
    db.close();
  });

  it('ignores ancillary files during refresh and rejects scoped overlays as baseline coverage', async () => {
    const index = builder();
    await index.build();
    writeFileSync(join(rootDir, 'helper.py'), 'print("changed ancillary file")\n');
    expect(await index.refresh()).toEqual([]);
    expect(index.validate('migration-grade').ok).toBe(true);
    writeFileSync(join(rootDir, 'lib/main.c'), `${lines.join('\n')}\nint added(void);\n`);
    await expect(index.refresh()).rejects.toBeInstanceOf(IndexValidationError);
    expect(index.lastValidationReport!.errors).toContainEqual(expect.objectContaining({
      code: 'SCIP_SCOPE_UNCOVERED_FILES', paths: ['lib/main.c'],
    }));
  });

  it('rejects falsified scope hashes and fabricated coverage manifests', async () => {
    await builder().build();
    const db = openDb(dbPath);
    const run = db.prepare("SELECT id, config_json FROM index_runs WHERE layer = 'baseline'").get() as {
      id: string; config_json: string;
    };
    const config = JSON.parse(run.config_json);
    config.scipScope.scopeHash = '0'.repeat(64);
    db.prepare('UPDATE index_runs SET config_json = ? WHERE id = ?').run(JSON.stringify(config), run.id);
    expect(validateIndex(db, { rootDir, scipScope: scope }).errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_MISMATCH' }));
    db.prepare("UPDATE indexer_runs SET details_json = '{}' WHERE provider = 'scip'").run();
    expect(validateIndex(db, { rootDir, scipScope: scope }).errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_UNCOVERED_FILES', paths: ['lib/main.c'] }));
    db.close();
  });

  it('certifies deterministic filtered-compdb provenance and rejects later compdb changes', async () => {
    const compdbPath = join(rootDir, 'compile_commands.json');
    writeFileSync(compdbPath, JSON.stringify([{
      directory: rootDir, file: 'lib/main.c', arguments: ['cc', '-c', 'lib/main.c'],
    }, {
      directory: '/not-approved', file: '/not-approved/ancillary.c', arguments: ['cc', '@missing', '-c', 'ancillary.c'],
    }]));
    const index = builder({
      scip: { indexers: { c: {
        command: process.execPath,
        args: ['--eval', 'require("node:fs").copyFileSync(process.argv[1], process.argv[3])', '.scip/index.scip', '{compdb}', '{output}'],
      } } },
      execution: { allowCustomIndexerCommands: true },
    });
    await index.build();
    const report = index.validate('migration-grade');
    expect(report.ok).toBe(true);
    expect(report.provenance.compilationDatabases[0]!.details).toMatchObject({
      filtered: {
        scopeHash: report.provenance.scipScope!.scopeHash,
        entries: 1, translationUnits: ['lib/main.c'],
      },
    });
    await index.baselineRebuild();
    const rebuilt = index.validate('migration-grade');
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.provenance.scipScope).toEqual(report.provenance.scipScope);
    expect(rebuilt.provenance.compilationDatabases[0]!.details)
      .toMatchObject({ filtered: (report.provenance.compilationDatabases[0]!.details as { filtered: unknown }).filtered });
    writeFileSync(compdbPath, JSON.stringify([{
      directory: rootDir, file: 'lib/main.c', arguments: ['cc', '-DCHANGED', '-c', 'lib/main.c'],
    }]));
    expect(index.validate('migration-grade').errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_COMPDB_MISMATCH' }));
  });

  it.each(['failed', 'unavailable'])('rejects an in-scope %s indexer', async (status) => {
    writeFileSync(join(rootDir, 'compile_commands.json'), JSON.stringify([{
      directory: rootDir, file: 'lib/main.c', arguments: ['cc', '-c', 'lib/main.c'],
    }]));
    const index = builder({
      scip: { indexers: { c: {
        command: status === 'failed' ? process.execPath : join(rootDir, 'missing-scip-clang'),
        args: ['--eval', 'process.exit(7)', '{compdb}', '{output}'],
      } } },
      execution: { allowCustomIndexerCommands: true },
    });
    await expect(index.build()).rejects.toBeInstanceOf(IndexValidationError);
    expect(index.lastValidationReport!.provenance.indexers)
      .toContainEqual(expect.objectContaining({ provider: 'scip', languages: ['c'], status }));
    expect(index.lastValidationReport!.errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_INDEXER_MISSING' }));
  });

  it('imports and validates only scoped files without fallback degradation or LSP launches', async () => {
    const index = builder();
    await index.build();
    const report = index.lastValidationReport!;
    expect(report.ok).toBe(true);
    expect(report.coverage.overall).toMatchObject({ files: 1, symbols: 2, calls: { resolved: 1 } });
    expect(report.provenance.latestBaselineRun).toMatchObject({ fallbackDegraded: false, status: 'succeeded' });
    expect(report.provenance.indexers.filter(row => row.provider === 'scip')).toMatchObject([
      { languages: ['c'], files: 1, status: 'succeeded', details: { coveredFiles: ['lib/main.c'] } },
    ]);
    expect(report.provenance.indexers.filter(row => row.provider === 'lsp').every(row => !row.attempted)).toBe(true);
    expect(index.validate('migration-grade').ok).toBe(true);
  });

  it('fails for every uncovered in-scope file even if another file in that language succeeded', async () => {
    writeFileSync(join(rootDir, 'lib/uncovered.c'), 'int uncovered(void) { return 2; }\n');
    const index = builder();
    await expect(index.build()).rejects.toBeInstanceOf(IndexValidationError);
    expect(index.lastValidationReport!.errors).toContainEqual(expect.objectContaining({
      code: 'SCIP_SCOPE_UNCOVERED_FILES', paths: ['lib/uncovered.c'],
    }));
  });

  it('ignores repository scope and validation settings at the trusted scoped boundary', async () => {
    writeFileSync(join(rootDir, '.lore.config'), JSON.stringify({
      scipScope: { languages: ['python'], includeGlobs: ['helper.py'], effectiveFiles: [] },
      validation: { profile: 'standard', excludeGlobs: ['**/*'], requireStructuralIndex: false },
    }));
    const index = builder();
    await index.build();
    expect(index.lastValidationReport!.ok).toBe(true);
    expect(index.lastValidationReport!.provenance.scipScope!.requested).toEqual({ ...scope, excludeGlobs: [] });
    writeFileSync(join(rootDir, 'lib/uncovered.c'), 'int uncovered(void);\n');
    await expect(builder().build()).rejects.toBeInstanceOf(IndexValidationError);
  });

  it('detects changed requests, walker selection, missing rows, and newly selected files', async () => {
    await builder().build();
    expect(validateIndex(dbPath, { rootDir, profile: 'migration-grade' }).errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_REQUIRED' }));
    expect(validateIndex(dbPath, { rootDir, scipScope: { ...scope, includeGlobs: ['lib/main.c'] } }).errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_MISMATCH' }));
    expect(validateIndex(dbPath, { rootDir, scipScope: scope, walkerConfig: { rootDir, excludeGlobs: ['lib/**'] } }).errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_MISMATCH' }));
    writeFileSync(join(rootDir, 'lib/new.c'), 'int new_function(void);\n');
    expect(validateIndex(dbPath, { rootDir, scipScope: scope }).errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_UNCOVERED_FILES', paths: ['lib/new.c'] }));
    const db = openDb(dbPath);
    db.prepare('DELETE FROM files WHERE path = ?').run(join(rootDir, 'lib/main.c'));
    db.close();
    expect(validateIndex(dbPath, { rootDir, scipScope: scope }).errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_UNCOVERED_FILES', paths: ['lib/main.c', 'lib/new.c'] }));
  });

  it('preserves denied execution and rejects a missing required SCIP provider', async () => {
    rmSync(join(rootDir, '.scip'), { recursive: true });
    const index = builder({ scip: true });
    await expect(index.build()).rejects.toBeInstanceOf(IndexValidationError);
    expect(index.lastValidationReport!.provenance.indexers
      .filter(row => ['scip', 'lsp', 'compdb'].includes(row.provider)).every(row => !row.attempted)).toBe(true);
    expect(index.lastValidationReport!.errors)
      .toContainEqual(expect.objectContaining({ code: 'SCIP_SCOPE_INDEXER_MISSING' }));
  });
});