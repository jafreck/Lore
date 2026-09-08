import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  beginIndexRun,
  CURRENT_LORE_SCHEMA_VERSION,
  finishIndexRun,
  openDb,
  recordIndexerRun,
} from '../../src/db/schema.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import { resolveEffectiveLspSettings } from '../../src/lsp/config.js';
import { resolveEffectiveScipSettings } from '../../src/scip/config.js';
import {
  IndexValidationError,
  validateIndex,
} from '../../src/validation/index-health.js';
import { runDoctorCommand } from '../../src/cli/commands/doctor-cmd.js';
import { runMigrateCommand } from '../../src/cli/commands/migrate-cmd.js';
import { runIndexCommand } from '../../src/cli/commands/index-cmd.js';
import { getLogger } from '../../src/logger.js';
import {
  dropStagingEffectiveViews,
  installStagingEffectiveViews,
} from '../../src/indexer/staging-views.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function addFile(
  db: ReturnType<typeof openDb>,
  filePath: string,
  source: string,
  options: { layer?: 'baseline' | 'overlay'; generation?: number } = {},
): number {
  return Number(db.prepare(
    `INSERT INTO files
       (path, branch, language, source, size_bytes, layer, generation)
     VALUES (?, 'main', 'typescript', ?, ?, ?, ?)`,
  ).run(
    filePath,
    source,
    Buffer.byteLength(source),
    options.layer ?? 'baseline',
    options.generation ?? 1,
  ).lastInsertRowid);
}

function addSymbol(
  db: ReturnType<typeof openDb>,
  fileId: number,
  name: string,
  line = 0,
  options: { layer?: 'baseline' | 'overlay'; startCharacter?: number; endCharacter?: number } = {},
): number {
  return Number(db.prepare(
    `INSERT INTO symbols
       (file_id, name, kind, start_line, start_character, end_line, end_character,
        selection_line, selection_character, layer, generation)
     VALUES (?, ?, 'function', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fileId,
    name,
    line,
    options.startCharacter ?? 0,
    line,
    options.endCharacter ?? 5,
    line,
    options.startCharacter ?? 0,
    options.layer ?? 'baseline',
    options.layer === 'overlay' ? 0 : 1,
  ).lastInsertRowid);
}

function addSuccessfulRun(db: ReturnType<typeof openDb>, rootDir = '/repo'): string {
  const runId = beginIndexRun(db, {
    mode: 'build',
    rootDir,
    branch: 'main',
    layer: 'baseline',
    generation: 1,
  });
  recordIndexerRun(db, {
    runId,
    provider: 'scip',
    indexer: 'generic-scip-indexer',
    languages: ['typescript'],
    status: 'succeeded',
    attempted: true,
    files: 1,
    symbols: 2,
  });
  finishIndexRun(db, runId, { status: 'succeeded' });
  db.prepare(
    `INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)
     ON CONFLICT(branch) DO UPDATE SET generation = excluded.generation`,
  ).run();
  return runId;
}

function createGoodDatabase(dbPath = ':memory:'): ReturnType<typeof openDb> {
  const db = openDb(dbPath);
  const source = 'function caller() { return target(); }\nfunction target() { return 1; }\n';
  const fileId = addFile(db, '/repo/src/main.ts', source);
  const callerId = addSymbol(db, fileId, 'caller', 0, { endCharacter: 38 });
  const targetId = addSymbol(db, fileId, 'target', 1, { endCharacter: 31 });
  db.prepare(
    `INSERT INTO symbol_refs
       (caller_id, file_id, callee_id, callee_name, call_line, call_character,
        resolution_method, layer, generation)
     VALUES (?, ?, ?, 'target', 0, 27, 'scip_definition', 'baseline', 1)`,
  ).run(callerId, fileId, targetId);
  db.prepare(
    `INSERT INTO type_refs
       (file_id, symbol_id, type_id, type_name, type_name_bare, ref_line,
        ref_character, resolution_method, layer, generation)
     VALUES (?, ?, ?, 'target', 'target', 0, 9, 'scip_definition', 'baseline', 1)`,
  ).run(fileId, callerId, targetId);
  db.prepare(
    `INSERT INTO file_imports (file_id, raw_import, resolved_id, layer, generation)
     VALUES (?, './main', ?, 'baseline', 1)`,
  ).run(fileId, fileId);
  addSuccessfulRun(db);
  return db;
}

describe('validateIndex', () => {
  it('reports complete coverage and resolution by language and extension', () => {
    const db = createGoodDatabase();
    try {
      const report = validateIndex(db, { rootDir: '/repo' });
      expect(report.ok).toBe(true);
      expect(report.status).toBe('healthy');
      expect(report.coverage.overall).toMatchObject({
        files: 1,
        filesWithSymbols: 1,
        symbols: 2,
        symbolCoverage: 1,
      });
      expect(report.coverage.overall.calls).toMatchObject({ total: 1, resolved: 1, resolutionRate: 1 });
      expect(report.coverage.overall.types).toMatchObject({ total: 1, resolved: 1, resolutionRate: 1 });
      expect(report.coverage.overall.imports).toMatchObject({ total: 1, resolved: 1, resolutionRate: 1 });
      expect(report.coverage.byLanguage.typescript?.files).toBe(1);
      expect(report.coverage.byExtension['.ts']?.symbols).toBe(2);
      expect(report.resolution.methods).toContainEqual(expect.objectContaining({
        entity: 'call', method: 'scip_definition', count: 1,
      }));
      expect(report.provenance.indexers).toContainEqual(expect.objectContaining({
        indexer: 'generic-scip-indexer', status: 'succeeded', attempted: true,
      }));
    } finally {
      db.close();
    }
  });

  it('does not count non-null IDs that point to hidden targets as resolved', () => {
    const db = openDb(':memory:');
    try {
      const sourceFile = addFile(db, '/repo/src/source.ts', 'function caller() {}\nclass Child {}\n');
      const targetFile = addFile(db, '/repo/src/target.ts', 'function target() {}\nclass Base {}\n');
      const caller = addSymbol(db, sourceFile, 'caller', 0);
      const child = addSymbol(db, sourceFile, 'Child', 1);
      const target = addSymbol(db, targetFile, 'target', 0);
      const base = addSymbol(db, targetFile, 'Base', 1);
      addSuccessfulRun(db);
      const overlayTargetFile = addFile(
        db,
        '/repo/src/target.ts',
        'function replacement() {}\n',
        { layer: 'overlay', generation: 0 },
      );
      addSymbol(db, overlayTargetFile, 'replacement', 0, { layer: 'overlay' });

      db.prepare(
        `INSERT INTO symbol_refs
           (caller_id, file_id, callee_id, callee_name, call_line, resolution_method, layer, generation)
         VALUES (?, ?, ?, 'target', 0, 'scip_definition', 'baseline', 1)`,
      ).run(caller, sourceFile, target);
      db.prepare(
        `INSERT INTO type_refs
           (file_id, symbol_id, type_id, type_name, type_name_bare, ref_line,
            resolution_method, layer, generation)
         VALUES (?, ?, ?, 'Base', 'Base', 0, 'scip_definition', 'baseline', 1)`,
      ).run(sourceFile, caller, base);
      db.prepare(
        `INSERT INTO symbol_relationships
           (file_id, source_symbol_id, target_symbol_id, target_symbol_name,
            relationship_type, line, resolution_method, layer, generation)
         VALUES (?, ?, ?, 'Base', 'extends', 1, 'scip_definition', 'baseline', 1)`,
      ).run(sourceFile, child, base);
      db.prepare(
        `INSERT INTO file_imports
           (file_id, raw_import, resolved_id, resolution_method, layer, generation)
         VALUES (?, './target', ?, 'filesystem_exact', 'baseline', 1)`,
      ).run(sourceFile, targetFile);
      db.prepare(
        `INSERT INTO dirty_files (path, branch, overlay_gen)
         VALUES ('/repo/src/target.ts', 'main', 0)`,
      ).run();

      // Simulate a legacy/pre-reconciliation database that retained raw IDs.
      db.prepare(
        "UPDATE symbol_refs SET callee_id = ?, resolution_method = 'scip_definition' WHERE caller_id = ?",
      ).run(target, caller);
      db.prepare(
        "UPDATE type_refs SET type_id = ?, resolution_method = 'scip_definition' WHERE symbol_id = ?",
      ).run(base, caller);
      db.prepare(
        "UPDATE symbol_relationships SET target_symbol_id = ?, resolution_method = 'scip_definition' WHERE source_symbol_id = ?",
      ).run(base, child);
      db.prepare(
        "UPDATE file_imports SET resolved_id = ?, resolution_method = 'filesystem_exact' WHERE file_id = ?",
      ).run(targetFile, sourceFile);

      const report = validateIndex(db, { rootDir: '/repo' });
      expect(report.coverage.overall.calls).toMatchObject({ total: 1, resolved: 0 });
      expect(report.coverage.overall.types).toMatchObject({ total: 1, resolved: 0 });
      expect(report.coverage.overall.imports).toMatchObject({ total: 1, resolved: 0 });
      expect(report.resolution.relationships).toMatchObject({ total: 1, resolved: 0 });
    } finally {
      db.close();
    }
  });

  it('reports symbol-less files, invalid spans, duplicates, failed indexers, and internal unresolved refs', () => {
    const db = createGoodDatabase();
    try {
      addFile(db, '/repo/src/empty.ts', '// no declarations\n');
      const main = db.prepare("SELECT id FROM files WHERE path = '/repo/src/main.ts'").get() as { id: number };
      const caller = db.prepare("SELECT id FROM symbols WHERE name = 'caller'").get() as { id: number };
      addSymbol(db, main.id, 'duplicate', 0);
      addSymbol(db, main.id, 'duplicate', 0);
      addSymbol(db, main.id, 'outside', 99);
      db.prepare(
        `INSERT INTO symbol_refs
           (caller_id, file_id, callee_name, call_line, call_character, resolution_method, layer, generation)
         VALUES (?, ?, 'target', 0, 5, 'unresolved', 'baseline', 1)`,
      ).run(caller.id, main.id);
      const run = db.prepare('SELECT id FROM index_runs LIMIT 1').get() as { id: string };
      recordIndexerRun(db, {
        runId: run.id,
        provider: 'scip',
        indexer: 'secondary-indexer',
        languages: ['typescript'],
        status: 'failed',
        attempted: true,
        message: 'fixture failure',
      });

      const report = validateIndex(db, { rootDir: '/repo' });
      expect(report.ok).toBe(true);
      expect(report.status).toBe('degraded');
      expect(report.symbolLessFiles.files).toContainEqual(expect.objectContaining({ relativePath: 'src/empty.ts' }));
      expect(report.spans.invalid).toBeGreaterThan(0);
      expect(report.duplicates.symbols.excessRows).toBe(1);
      expect(report.unresolvedInternal.samples).toContainEqual(expect.objectContaining({
        entity: 'call', target: 'target', reason: 'indexed-symbol-name',
      }));
      expect(report.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
        'SYMBOL_LESS_FILES',
        'INVALID_SPANS',
        'DUPLICATE_SYMBOLS',
        'UNRESOLVED_INTERNAL_REFS',
        'INDEXER_DEGRADED',
      ]));
    } finally {
      db.close();
    }
  });

  it('validates start, end, and selection characters against UTF-16 line lengths and span containment', () => {
    const db = openDb(':memory:');
    try {
      const fileId = addFile(db, '/repo/src/unicode.ts', '😀abc\nsecond\n');
      const insert = db.prepare(
        `INSERT INTO symbols
           (file_id, name, kind, start_line, start_character, end_line, end_character,
            selection_line, selection_character, layer, generation)
         VALUES (?, ?, 'variable', 0, ?, 0, ?, 0, ?, 'baseline', 1)`,
      );
      // The first line is five UTF-16 code units: surrogate pair + "abc".
      insert.run(fileId, 'valid', 0, 5, 2);
      insert.run(fileId, 'badStart', 6, 6, 6);
      insert.run(fileId, 'badEnd', 0, 6, 1);
      insert.run(fileId, 'badSelectionLength', 0, 5, 6);
      insert.run(fileId, 'selectionBefore', 2, 4, 1);
      insert.run(fileId, 'selectionAfter', 1, 3, 4);
      addSuccessfulRun(db);

      const report = validateIndex(db, {
        rootDir: '/repo',
        policy: { profile: 'strict' },
        maxSamples: 20,
      });
      expect(report.ok).toBe(false);
      expect(report.spans.invalid).toBe(5);
      expect(report.spans.samples.map((sample) => sample.reason)).toEqual(expect.arrayContaining([
        'start character is outside the UTF-16 line length',
        'end character is outside the UTF-16 line length',
        'selection character is outside the UTF-16 line length',
        'selection character precedes the symbol span',
        'selection character follows the symbol span',
      ]));
    } finally {
      db.close();
    }
  });

  it('fails strict and migration-grade policies when completeness requirements are not met', () => {
    const db = createGoodDatabase();
    try {
      addFile(db, '/repo/core/required.ts', '// missing symbols\n');
      const strict = validateIndex(db, {
        rootDir: '/repo',
        policy: {
          profile: 'strict',
          requiredGlobs: ['core/**'],
          languages: { typescript: { minSymbolCoverage: 1 } },
        },
      });
      expect(strict.ok).toBe(false);
      expect(strict.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
        'REQUIRED_FILE_SYMBOL_LESS',
        'THRESHOLD_MAX_SYMBOL_LESS_FILES',
        'THRESHOLD_MIN_SYMBOL_COVERAGE',
      ]));

      db.exec('DELETE FROM indexer_runs; DELETE FROM index_runs');
      const migration = validateIndex(db, {
        rootDir: '/repo',
        policy: { profile: 'migration-grade', thresholds: { maxSymbolLessFiles: 1 } },
      });
      expect(migration.ok).toBe(false);
      expect(migration.errors.map((error) => error.code)).toContain('PROVENANCE_MISSING');
    } finally {
      db.close();
    }
  });

  it('uses overlay rows in coverage while retaining baseline and overlay provenance', () => {
    const db = openDb(':memory:');
    try {
      const filePath = '/repo/src/live.ts';
      const baselineFile = addFile(db, filePath, 'function oldName() {}\n');
      addSymbol(db, baselineFile, 'oldName');
      const baselineRun = addSuccessfulRun(db);

      const overlayFile = addFile(db, filePath, 'function newName() {}\n', { layer: 'overlay', generation: 0 });
      addSymbol(db, overlayFile, 'newName', 0, { layer: 'overlay' });
      db.prepare(
        `INSERT INTO dirty_files (path, branch, dirty_since, overlay_gen)
         VALUES (?, 'main', unixepoch(), 0)`,
      ).run(filePath);
      const updateRun = beginIndexRun(db, {
        mode: 'update', rootDir: '/repo', branch: 'main', layer: 'overlay', generation: 0,
      });
      recordIndexerRun(db, {
        runId: updateRun,
        provider: 'lsp',
        indexer: 'generic-language-server',
        languages: ['typescript'],
        status: 'succeeded',
        attempted: true,
        files: 1,
        symbols: 1,
      });
      finishIndexRun(db, updateRun, { status: 'succeeded' });

      const report = validateIndex(db, { rootDir: '/repo', branch: 'main' });
      expect(report.coverage.overall).toMatchObject({ files: 1, symbols: 1 });
      expect(report.symbolLessFiles.total).toBe(0);
      expect(report.freshness).toMatchObject({ source: 'mixed', dirtyFiles: 1, overlayFiles: 1, overlaySymbols: 1 });
      expect(report.provenance.latestRun?.id).toBe(updateRun);
      expect(report.provenance.latestBaselineRun?.id).toBe(baselineRun);
      expect(report.provenance.indexers.map((row) => row.provider)).toEqual(expect.arrayContaining(['scip', 'lsp']));
    } finally {
      db.close();
    }
  });

  it('uses only the promoted generation for freshness unless validating an explicit candidate', () => {
    const db = createGoodDatabase();
    try {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        "UPDATE files SET indexed_at = ? WHERE layer = 'baseline' AND generation = 1",
      ).run(now - 1_000);
      db.prepare(
        `INSERT INTO files
           (path, branch, language, source, indexed_at, layer, generation)
         VALUES ('/repo/src/candidate.ts', 'main', 'typescript',
                 'export const candidate = true;', ?, 'baseline', 2)`,
      ).run(now);

      const promoted = validateIndex(db, { rootDir: '/repo', branch: 'main' });
      expect(promoted.freshness.baselineAgeSeconds).toBeGreaterThanOrEqual(900);
      expect(promoted.freshness.latestIndexedAt).toBe(now - 1_000);

      installStagingEffectiveViews(db, 'main', 2);
      try {
        const candidate = validateIndex(db, {
          rootDir: '/repo',
          branch: 'main',
          candidateGeneration: 2,
        });
        expect(candidate.freshness.baselineAgeSeconds).toBeLessThan(10);
        expect(candidate.freshness.latestIndexedAt).toBe(now);
      } finally {
        dropStagingEffectiveViews(db);
      }
    } finally {
      db.close();
    }
  });

  it('rejects failed and in-progress latest baseline attempts for migration-grade validation', () => {
    for (const status of ['failed', 'running'] as const) {
      const db = createGoodDatabase();
      try {
        const runId = beginIndexRun(db, {
          mode: 'rebuild', rootDir: '/repo', branch: 'main', layer: 'baseline', generation: 2,
        });
        if (status === 'failed') finishIndexRun(db, runId, { status: 'failed', error: 'fixture failure' });

        const report = validateIndex(db, {
          rootDir: '/repo',
          policy: { profile: 'migration-grade' },
        });
        expect(report.ok).toBe(false);
        expect(report.errors.map((error) => error.code)).toContain('BASELINE_RUN_NOT_SUCCESSFUL');
        expect(report.errors.map((error) => error.code)).toContain('BASELINE_GENERATION_MISMATCH');
        if (status === 'running') {
          expect(report.errors.map((error) => error.code)).toContain('BASELINE_RUN_INCOMPLETE');
        }
      } finally {
        db.close();
      }
    }
  });

  it('rejects stale generation and root provenance even when the latest run succeeded', () => {
    const db = createGoodDatabase();
    try {
      const runId = beginIndexRun(db, {
        mode: 'rebuild', rootDir: '/sibling/repo', branch: 'main', layer: 'baseline', generation: 2,
      });
      recordIndexerRun(db, {
        runId,
        provider: 'scip',
        indexer: 'generic-scip-indexer',
        languages: ['typescript'],
        status: 'succeeded',
        attempted: true,
      });
      finishIndexRun(db, runId, { status: 'succeeded' });

      const report = validateIndex(db, {
        rootDir: '/repo',
        branch: 'main',
        policy: { profile: 'migration-grade' },
      });
      expect(report.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
        'BASELINE_GENERATION_MISMATCH',
        'BASELINE_ROOT_MISMATCH',
      ]));
    } finally {
      db.close();
    }
  });

  it('requires a successful latest-baseline structural provider for each selected language', () => {
    const db = createGoodDatabase();
    try {
      db.exec('DELETE FROM indexer_runs');
      const run = db.prepare('SELECT id FROM index_runs LIMIT 1').get() as { id: string };
      recordIndexerRun(db, {
        runId: run.id,
        provider: 'scip',
        indexer: 'wrong-language-indexer',
        languages: ['python'],
        status: 'succeeded',
        attempted: true,
      });

      const report = validateIndex(db, {
        rootDir: '/repo',
        policy: { profile: 'migration-grade' },
      });
      expect(report.errors).toContainEqual(expect.objectContaining({
        code: 'STRUCTURAL_PROVIDER_MISSING',
        scope: 'typescript',
      }));
    } finally {
      db.close();
    }
  });

  it('reports exact internal, external, heuristic, and unresolved imports separately', () => {
    const db = createGoodDatabase();
    try {
      const file = db.prepare("SELECT id FROM files WHERE path = '/repo/src/main.ts'").get() as { id: number };
      db.prepare(
        `INSERT INTO file_imports (file_id, raw_import, resolution_method, layer, generation)
         VALUES (?, 'lodash', 'external_dependency', 'baseline', 1)`,
      ).run(file.id);
      db.prepare(
        `INSERT INTO file_imports (file_id, raw_import, resolved_id, resolution_method, layer, generation)
         VALUES (?, 'main.ts', ?, 'include_suffix_unique', 'baseline', 1)`,
      ).run(file.id, file.id);
      db.prepare(
        `INSERT INTO file_imports (file_id, raw_import, resolution_method, layer, generation)
         VALUES (?, './missing', 'unresolved', 'baseline', 1)`,
      ).run(file.id);

      expect(validateIndex(db, { rootDir: '/repo' }).coverage.overall.imports).toEqual({
        total: 4,
        internalResolved: 1,
        externalResolved: 1,
        heuristic: 1,
        resolved: 3,
        unresolved: 1,
        resolutionRate: 0.75,
      });
    } finally {
      db.close();
    }
  });

  it('reports position-conversion and supplementation degradation details', () => {
    const db = createGoodDatabase();
    try {
      const run = db.prepare('SELECT id FROM index_runs LIMIT 1').get() as { id: string };
      recordIndexerRun(db, {
        runId: run.id,
        provider: 'scip',
        indexer: 'position-aware-indexer',
        languages: ['typescript'],
        status: 'succeeded',
        attempted: true,
        details: {
          positionConversion: {
            conversionRequired: 2,
            converted: 1,
            skippedMissingSource: 1,
          },
        },
      });
      recordIndexerRun(db, {
        runId: run.id,
        provider: 'lsp',
        indexer: 'lsp-supplementation-cap',
        languages: ['typescript'],
        status: 'degraded',
        attempted: false,
        fallback: true,
        details: { supplementation: { skippedByCap: 3, complete: false } },
      });

      const report = validateIndex(db, { rootDir: '/repo' });
      expect(report.provenance.diagnostics.positionConversions).toContainEqual(
        expect.objectContaining({ indexer: 'position-aware-indexer', status: 'succeeded' }),
      );
      expect(report.provenance.diagnostics.supplementation).toContainEqual(
        expect.objectContaining({ indexer: 'lsp-supplementation-cap', status: 'degraded' }),
      );
    } finally {
      db.close();
    }
  });

  it('inspects an older schema read-only and returns SCHEMA_OUTDATED guidance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-old-schema-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'old.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL);
      INSERT INTO files VALUES (1, '/repo/old.ts', 'typescript', 'const old = 1;');
      INSERT INTO symbols VALUES (1, 1, 'old', 'variable', 0, 0);
    `);
    legacy.close();
    const before = fs.readFileSync(dbPath);

    const direct = validateIndex(dbPath, { rootDir: '/repo' });
    expect(direct.ok).toBe(false);
    expect(direct.databaseSchema.status).toBe('outdated');
    expect(direct.errors).toContainEqual(expect.objectContaining({
      code: 'SCHEMA_OUTDATED',
      guidance: expect.stringContaining('lore migrate'),
    }));

    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const cli = await runDoctorCommand(['doctor', '--db', dbPath, '--json'], getLogger());
    expect(cli.errors[0]?.code).toBe('SCHEMA_OUTDATED');
    expect(JSON.parse(output).errors[0].guidance).toContain('lore migrate');
    expect(fs.readFileSync(dbPath)).toEqual(before);

    const migrated = await runMigrateCommand(['migrate', '--db', dbPath, '--json'], getLogger());
    expect(migrated.status).toBe('current');
    expect(validateIndex(dbPath, { rootDir: '/repo' }).databaseSchema.status).toBe('current');
  });

  it('rejects a newer schema read-only without suggesting a downgrade migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-newer-validation-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'newer.db');
    const newer = new Database(dbPath);
    newer.pragma(`user_version = ${CURRENT_LORE_SCHEMA_VERSION + 1}`);
    newer.close();
    const before = fs.readFileSync(dbPath);

    const report = validateIndex(dbPath);
    expect(report.databaseSchema.status).toBe('newer');
    expect(report.errors[0]).toMatchObject({ code: 'SCHEMA_NEWER' });
    expect(report.errors[0]?.guidance).not.toContain('lore migrate');
    expect(fs.readFileSync(dbPath)).toEqual(before);
  });
});

describe('CLI and IndexBuilder validation behavior', () => {
  it('emits machine-readable doctor JSON and sets a failing exit code for strict validation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-doctor-cli-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'lore.db');
    const db = openDb(dbPath);
    addFile(db, path.join(dir, 'src', 'empty.ts'), '// no symbols\n');
    addSuccessfulRun(db, dir);
    db.close();

    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    const report = await runDoctorCommand([
      'doctor', '--db', dbPath, '--root', dir, '--validation-profile', 'strict', '--json',
    ], getLogger());

    expect(report.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, ok: false, profile: 'strict' });
  });

  it('makes a programmatic build reject when its strict policy finds source-only fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-strict-builder-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'main.ts'), 'export function main() {}\n');
    const dbPath = path.join(dir, 'lore.db');
    const builder = new IndexBuilder(dbPath, { rootDir: dir }, undefined, {
      scip: resolveEffectiveScipSettings({}, { enabled: false }),
      lsp: resolveEffectiveLspSettings({}, { enabled: false }),
      validation: { profile: 'strict' },
    });

    await expect(builder.build()).rejects.toBeInstanceOf(IndexValidationError);
    expect(builder.lastValidationReport?.ok).toBe(false);
    const db = openDb(dbPath);
    try {
      expect(db.prepare('SELECT status, fallback_degraded FROM index_runs ORDER BY started_at DESC, rowid DESC LIMIT 1').get())
        .toEqual({ status: 'failed', fallback_degraded: 1 });
    } finally {
      db.close();
    }
  });

  it('makes the index command reject when --validation-profile strict is not satisfied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-strict-cli-index-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'main.ts'), 'export function main() {}\n');
    fs.writeFileSync(path.join(dir, '.lore.config'), JSON.stringify({ lsp: { enabled: false } }));
    const dbPath = path.join(dir, 'lore.db');

    await expect(runIndexCommand([
      'index', '--root', dir, '--db', dbPath, '--no-scip',
      '--validation-profile', 'strict',
    ], getLogger())).rejects.toBeInstanceOf(IndexValidationError);
  });
});