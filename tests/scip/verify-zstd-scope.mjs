import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IndexBuilder, IndexValidationError, loadCompilationDatabase, openReadOnly, validateIndex } from '../../dist/index.js';

assert(process.argv[2] && process.argv[3], 'Usage: node tests/scip/verify-zstd-scope.mjs <isolated-zstd-root> <db-path>');
const rootDir = realpathSync(resolve(process.argv[2]));
const dbPath = resolve(process.argv[3]);
const sdkArguments = process.platform === 'darwin'
  ? [`-DCMAKE_OSX_SYSROOT=${execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim()}`]
  : [];
execFileSync('cmake', [
  '-S', join(rootDir, 'build/cmake'), '-B', join(rootDir, '.lore-compdb'), '-G', 'Ninja',
  '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON', '-DCMAKE_BUILD_TYPE=Debug',
  '-DZSTD_BUILD_COMPRESSION=ON', '-DZSTD_BUILD_DECOMPRESSION=ON',
  '-DZSTD_BUILD_DICTBUILDER=ON', '-DZSTD_BUILD_DEPRECATED=ON',
  '-DZSTD_BUILD_PROGRAMS=ON', '-DZSTD_BUILD_TESTS=ON', '-DZSTD_BUILD_CONTRIB=ON',
  '-DZSTD_BUILD_SHARED=ON', '-DZSTD_BUILD_STATIC=ON',
  '-DZSTD_LEGACY_SUPPORT=ON', '-DZSTD_MULTITHREAD_SUPPORT=ON',
  ...sdkArguments,
], { cwd: rootDir, stdio: 'inherit' });
const generatedCompdbPath = join(rootDir, '.lore-compdb/compile_commands.json');
const generatedCompdb = loadCompilationDatabase(generatedCompdbPath, undefined, rootDir).database;
assert(generatedCompdb?.validation.valid, 'CMake must generate a usable in-root compilation database');
const headerCheck = generatedCompdb.entries.find(entry => entry.filePath === join(rootDir, 'programs/lorem.c'));
assert(headerCheck, 'CMake must include the lorem.c translation unit');
const compilationCommands = JSON.parse(readFileSync(generatedCompdbPath, 'utf8'));
compilationCommands.push({
  directory: headerCheck.workingDirectory,
  file: headerCheck.filePath,
  arguments: [...headerCheck.arguments, '-include', join(rootDir, 'programs/windres/verrsrc.h')],
});
writeFileSync(join(rootDir, 'compile_commands.json'), `${JSON.stringify(compilationCommands, null, 2)}\n`);

const walkerConfig = { rootDir, branch: 'main' };
const scipScope = {
  languages: ['c', 'cpp'],
  includeGlobs: ['lib/**/*.{c,h}', 'programs/**/*.{c,h}'],
};
const createContext = { name: 'ZSTD_createCCtx', path: 'lib/compress/zstd_compress.c', kind: 'function' };
const createContextAdvanced = { name: 'ZSTD_createCCtx_advanced', path: 'lib/compress/zstd_compress.c', kind: 'function' };
const validation = {
  profile: 'migration-grade',
  thresholds: { minCallRefs: 1 },
  requiredSymbols: [createContext, createContextAdvanced],
  requiredCalls: [{ caller: createContext, callee: createContextAdvanced, resolutionMethod: 'scip_definition' }],
};
const builder = new IndexBuilder(dbPath, walkerConfig, undefined, {
  scip: true, scipScope, lsp: false, embeddings: false,
  execution: { allowSubprocessExecution: true }, validation,
});
assert.equal((await builder.resolveConfiguration()).lsp, null);
try {
  await builder.build();
} catch (error) {
  if (error instanceof IndexValidationError) {
    writeFileSync(`${dbPath}.report.json`, `${JSON.stringify(error.report, null, 2)}\n`);
    console.error(JSON.stringify({
      errors: error.report.errors,
      indexers: error.report.provenance.indexers.map(({ provider, indexer, status, message }) => ({ provider, indexer, status, message })),
    }, null, 2));
    throw new Error(error.message);
  }
  throw error;
}
const report = validateIndex(dbPath, { rootDir, walkerConfig, scipScope, ...validation });
writeFileSync(`${dbPath}.report.json`, `${JSON.stringify(report, null, 2)}\n`);
assert.equal(report.ok, true, JSON.stringify(report.errors));
assert.equal(report.provenance.latestBaselineRun.fallbackDegraded, false);
assert.equal(report.provenance.scipScope.scopeHash, builder.lastValidationReport.provenance.scipScope.scopeHash);
assert(report.provenance.indexers.filter(row => row.provider === 'lsp').every(row => !row.attempted));
assert(report.provenance.indexers.some(row => row.provider === 'scip' && row.indexer.includes('scip-clang') && row.status === 'succeeded'));
assert(!report.provenance.indexers.some(row => row.indexer.includes('scip-python') && row.attempted));
for (const row of report.provenance.indexers.filter(row => row.provider === 'scip' && row.attempted)) {
  const diagnostics = row.details.compilerDiagnostics;
  assert.equal(diagnostics.requested, true, 'Compiler diagnostics must be enabled');
  assert.equal(diagnostics.complete, true, 'Compiler output capture must complete');
  assert.equal(diagnostics.summary.errors, 0, 'Compiler errors must reject certification');
  assert.equal(diagnostics.summary.failedTranslationUnits, 0);
  assert.equal(diagnostics.summary.skippedTranslationUnits, 0);
}

const db = openReadOnly(dbPath);
try {
  const nonMacroCSymbols = db.prepare(`
    SELECT COUNT(*) AS count FROM effective_symbols symbols
    JOIN effective_files files ON files.id = symbols.file_id
    WHERE files.language = 'c' AND symbols.kind <> 'macro'
  `).get().count;
  const resolvedCalls = db.prepare('SELECT COUNT(*) AS count FROM effective_symbol_refs WHERE callee_id IS NOT NULL').get().count;
  const requiredEdge = db.prepare(`
    SELECT DISTINCT caller.name AS caller, callee.name AS callee, refs.resolution_method AS method
    FROM effective_symbol_refs refs
    JOIN effective_symbols caller ON caller.id = refs.caller_id
    JOIN effective_symbols callee ON callee.id = refs.callee_id
    WHERE caller.name = 'ZSTD_createCCtx' AND callee.name = 'ZSTD_createCCtx_advanced'
      AND refs.resolution_method = 'scip_definition'
  `).all();
  assert(nonMacroCSymbols > 0);
  assert(resolvedCalls > 0);
  assert(requiredEdge.length > 0, 'ZSTD_createCCtx must resolve to ZSTD_createCCtx_advanced');
  console.log(JSON.stringify({
    rootDir, dbPath, validation: { ok: report.ok, profile: report.profile, warnings: report.warnings },
    coverage: report.coverage.overall, nonMacroCSymbols, resolvedCalls, requiredEdge,
    scopeHash: report.provenance.scipScope.scopeHash,
    languageCounts: report.provenance.scipScope.languageCounts,
    compdb: report.provenance.compilationDatabases.map(row => row.details.filtered),
    indexers: report.provenance.indexers.map(({ provider, indexer, languages, status, attempted, files, details }) =>
      ({ provider, indexer, languages, status, attempted, files,
        compilerDiagnostics: details?.compilerDiagnostics,
        declarationRecovery: details?.declarationRecovery })),
  }, null, 2));
} finally {
  db.close();
}