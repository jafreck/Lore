import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  openReadOnly,
  getFileById,
  getFileByPath,
  listFiles,
  listFilesByPathPrefix,
  listResolvedEdges,
  semanticSearchSymbols,
  getSymbolsByName,
  listSymbolRangesByName,
  resolveSymbolRangeByName,
  getExternalSymbolsByName,
  searchExternalSymbolsByName,
  listSymbols,
  getSymbolById,
  getCommitBySha,
  listRecentCommits,
  listCommitsByFile,
  listCommitsByAuthor,
  listCommitFiles,
  listCommitRefs,
  listCommitsByRef,
  hasCommitEmbeddings,
  listCommitsBySemanticQuery,
  type FileRow,
  type SymbolRow,
} from '../../src/db/read-only.js';

const esmRequire = createRequire(import.meta.url);

// Helper: create an in-memory DB with the minimal schema needed for tests.
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT '',
      language    TEXT    NOT NULL,
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      last_hash   TEXT,
      source      TEXT    NOT NULL DEFAULT '',
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      layer       TEXT    NOT NULL DEFAULT 'baseline',
      generation  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch, layer)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      signature   TEXT,
      doc_comment TEXT,
      resolved_type_signature TEXT,
      resolved_return_type TEXT,
      definition_uri TEXT,
      definition_path TEXT,
      is_exported INTEGER NOT NULL DEFAULT 0,
      parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      layer       TEXT    NOT NULL DEFAULT 'baseline',
      generation  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE symbol_metrics (
      symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
      line_count  INTEGER NOT NULL,
      param_count INTEGER NOT NULL,
      cyclomatic  INTEGER NOT NULL,
      max_nesting INTEGER NOT NULL,
      layer       TEXT    NOT NULL DEFAULT 'baseline',
      generation  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE external_symbols (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      dependency_ecosystem TEXT    NOT NULL DEFAULT 'npm',
      source_type          TEXT    NOT NULL DEFAULT 'declaration',
      source_ref           TEXT    NOT NULL DEFAULT '',
      package_name         TEXT    NOT NULL,
      package_version      TEXT,
      symbol_name          TEXT    NOT NULL,
      symbol_kind          TEXT    NOT NULL,
      signature            TEXT    NOT NULL DEFAULT '',
      doc_comment          TEXT,
      resolved_type_signature TEXT,
      resolved_return_type TEXT,
      definition_uri       TEXT,
      definition_path      TEXT
    );
  `);
  return db;
}

function createCommitDb(withRefs = true): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE commits (
      sha          TEXT    PRIMARY KEY,
      author       TEXT    NOT NULL,
      author_email TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message      TEXT    NOT NULL,
      parents      TEXT    NOT NULL DEFAULT '[]'
    );
    CREATE TABLE commit_files (
      commit_sha  TEXT    NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
      file_path   TEXT    NOT NULL,
      change_type TEXT    NOT NULL,
      insertions  INTEGER,
      deletions   INTEGER,
      PRIMARY KEY (commit_sha, file_path)
    );
  `);
  if (withRefs) {
    db.exec(`
      CREATE TABLE commit_refs (
        commit_sha TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
        ref_name   TEXT NOT NULL,
        ref_type   TEXT NOT NULL,
        PRIMARY KEY (commit_sha, ref_name)
      );
    `);
  }
  return db;
}

function loadSymbolEmbeddingsTable(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE symbol_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);
}

function insertSymbolEmbedding(
  db: Database.Database,
  symbolId: number,
  embedding: number[],
): void {
  db.prepare(
    'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(symbolId, JSON.stringify(embedding));
}

function loadCommitEmbeddingsTable(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE commit_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);
}

function insertCommitEmbedding(
  db: Database.Database,
  commitSha: string,
  embedding: number[],
): void {
  const row = db
    .prepare('SELECT rowid FROM commits WHERE sha = ?')
    .get(commitSha) as { rowid: number } | undefined;
  if (!row) {
    throw new Error(`Missing commit row for sha ${commitSha}`);
  }
  db.prepare(
    'INSERT OR REPLACE INTO commit_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(row.rowid, JSON.stringify(embedding));
}

function insertFile(
  db: Database.Database,
  path: string,
  branch: string,
  language = 'typescript'
): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, language);
  return result.lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function',
  startLine = 1,
  endLine = 10,
): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)'
    )
    .run(fileId, name, kind, startLine, endLine);
  return result.lastInsertRowid as number;
}

function insertExternalSymbol(
  db: Database.Database,
  packageName: string,
  packageVersion: string | null,
  symbolName: string,
  symbolKind: string,
  signature: string,
  docComment: string | null,
  dependencyEcosystem = 'npm',
  sourceType = 'declaration',
  sourceRef = '',
): number {
  const result = db
    .prepare(
      `INSERT INTO external_symbols
        (dependency_ecosystem, source_type, source_ref, package_name, package_version, symbol_name, symbol_kind, signature, doc_comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      dependencyEcosystem,
      sourceType,
      sourceRef,
      packageName,
      packageVersion,
      symbolName,
      symbolKind,
      signature,
      docComment,
    );
  return result.lastInsertRowid as number;
}

// ─── listTestMappingsBySourcePath ──────────────────────────────────────────────


// ─── getSymbolsByName ─────────────────────────────────────────────────────────

describe('getSymbolsByName', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, featId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
  });

  it('should return symbols matching name across all branches when no branch filter', () => {
    const rows = getSymbolsByName(db, 'parseConfig');
    expect(rows.length).toBe(2);
  });

  it('should be case-insensitive', () => {
    const rows = getSymbolsByName(db, 'PARSECONFIG');
    expect(rows.length).toBe(2);
  });

  it('should filter by branch when provided', () => {
    const rows = getSymbolsByName(db, 'parseConfig', 'main');
    expect(rows.length).toBe(1);
  });

  it('should default to exact matching when matchMode is omitted', () => {
    expect(getSymbolsByName(db, 'parse')).toEqual([]);
    expect(getSymbolsByName(db, 'parse', { branch: 'main' })).toEqual([]);
  });

  it('should support prefix match mode', () => {
    const fileId = insertFile(db, 'src/prefix.ts', 'main');
    insertSymbol(db, fileId, 'parse');
    insertSymbol(db, fileId, 'parseHelper');

    const rows = getSymbolsByName(db, 'parse', { matchMode: 'prefix' });
    expect(rows.map((row) => row.name).sort()).toEqual([
      'parse',
      'parseConfig',
      'parseConfig',
      'parseHelper',
    ]);
  });

  it('should support contains match mode', () => {
    const fileId = insertFile(db, 'src/contains.ts', 'main');
    insertSymbol(db, fileId, 'loadConfigValue');

    const rows = getSymbolsByName(db, 'config', { matchMode: 'contains' });
    expect(rows.map((row) => row.name).sort()).toEqual([
      'loadConfigValue',
      'parseConfig',
      'parseConfig',
    ]);
  });

  it('should apply branch, kind, pathPrefix, and language filters from options', () => {
    const matchingFileId = insertFile(db, 'src/components/widget.ts', 'main', 'typescript');
    const wrongLanguageFileId = insertFile(db, 'src/components/widget.js', 'main', 'javascript');
    const wrongPathFileId = insertFile(db, 'lib/components/widget.ts', 'main', 'typescript');
    const wrongBranchFileId = insertFile(db, 'src/components/widget.ts', 'feat', 'typescript');
    insertSymbol(db, matchingFileId, 'parseConfig', 'class');
    insertSymbol(db, wrongLanguageFileId, 'parseConfig', 'class');
    insertSymbol(db, wrongPathFileId, 'parseConfig', 'class');
    insertSymbol(db, wrongBranchFileId, 'parseConfig', 'class');

    const rows = getSymbolsByName(db, 'parseConfig', {
      branch: 'main',
      kind: 'class',
      pathPrefix: 'src/',
      language: 'typescript',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file_id: matchingFileId,
      name: 'parseConfig',
      kind: 'class',
    });
  });

  it('should return empty array when name does not match', () => {
    expect(getSymbolsByName(db, 'nonexistent')).toEqual([]);
  });

  it('should return empty array when branch has no matching symbol', () => {
    expect(getSymbolsByName(db, 'parseConfig', 'nonexistent-branch')).toEqual([]);
  });
});

describe('semanticSearchSymbols', () => {
  let db: Database.Database;
  let mainAlphaId: number;
  let mainBetaId: number;
  let featGammaId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainAFileId = insertFile(db, 'src/a.ts', 'main');
    const mainBFileId = insertFile(db, 'src/b.ts', 'main');
    const featFileId = insertFile(db, 'src/c.ts', 'feat');

    mainAlphaId = insertSymbol(db, mainAFileId, 'alpha');
    mainBetaId = insertSymbol(db, mainBFileId, 'beta');
    featGammaId = insertSymbol(db, featFileId, 'gamma');

    loadSymbolEmbeddingsTable(db, 3);
    insertSymbolEmbedding(db, mainAlphaId, [1, 0, 0]);
    insertSymbolEmbedding(db, mainBetaId, [1, 0, 0]);
    insertSymbolEmbedding(db, featGammaId, [1, 0, 0]);
  });

  it('should return an empty list for an empty query vector', () => {
    expect(semanticSearchSymbols(db, { queryVector: [] })).toEqual([]);
  });

  it('should filter semantic symbol results by branch with deterministic ordering for equal scores', () => {
    const rows = semanticSearchSymbols(db, {
      queryVector: [1, 0, 0],
      branch: 'main',
      limit: 10,
    });

    expect(rows.map((row) => `${row.file_branch}:${row.file_path}:${row.id}`)).toEqual([
      `main:src/a.ts:${mainAlphaId}`,
      `main:src/b.ts:${mainBetaId}`,
    ]);
  });

  it('should include score metadata and honor the caller-provided limit', () => {
    const rows = semanticSearchSymbols(db, {
      queryVector: [1, 0, 0],
      limit: 1,
    });

    expect(rows).toHaveLength(1);
    expect(typeof rows[0]?.id).toBe('number');
    expect(typeof rows[0]?.file_path).toBe('string');
    expect(typeof rows[0]?.file_branch).toBe('string');
    expect(rows[0]).toHaveProperty('score');
    expect(typeof rows[0]?.score).toBe('number');
  });

  it('should coerce non-positive limits to at least one semantic row', () => {
    const rows = semanticSearchSymbols(db, {
      queryVector: [1, 0, 0],
      limit: 0,
    });

    expect(rows).toHaveLength(1);
  });

  it('should include symbol metric columns when the symbol_metrics table exists', () => {
    db.prepare(
      'INSERT INTO symbol_metrics(symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (?, ?, ?, ?, ?)',
    ).run(mainAlphaId, 10, 2, 3, 1);

    const rows = semanticSearchSymbols(db, {
      queryVector: [1, 0, 0],
      branch: 'main',
      limit: 10,
    });
    const alpha = rows.find((row) => row.id === mainAlphaId);

    expect(alpha?.line_count).toBe(10);
    expect(alpha?.param_count).toBe(2);
    expect(alpha?.cyclomatic).toBe(3);
    expect(alpha?.max_nesting).toBe(1);
  });
});

describe('resolveSymbolRangeByName', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const sharedMainId = insertFile(db, 'src/shared.ts', 'main');
    const sharedFeatId = insertFile(db, 'src/shared.ts', 'feat');
    const otherMainId = insertFile(db, 'src/other.ts', 'main');
    insertSymbol(db, sharedMainId, 'parseConfig', 'function', 11, 30);
    insertSymbol(db, sharedFeatId, 'parseConfig', 'function', 15, 40);
    insertSymbol(db, otherMainId, 'parseConfig', 'function', 5, 8);
    insertSymbol(db, otherMainId, 'renderPage', 'function', 50, 70);
  });

  it('should list symbol range candidates in deterministic order', () => {
    const rows = listSymbolRangesByName(db, 'parseConfig');
    expect(rows.map((row) => [row.file_path, row.branch, row.start_line, row.end_line])).toEqual([
      ['src/other.ts', 'main', 5, 8],
      ['src/shared.ts', 'feat', 15, 40],
      ['src/shared.ts', 'main', 11, 30],
    ]);
  });

  it('should scope symbol range candidates by path with deterministic ordering', () => {
    const rows = listSymbolRangesByName(db, 'parseConfig', { path: 'src/shared.ts' });
    expect(rows.map((row) => [row.file_path, row.branch, row.start_line, row.end_line])).toEqual([
      ['src/shared.ts', 'feat', 15, 40],
      ['src/shared.ts', 'main', 11, 30],
    ]);
  });

  it('should scope symbol range candidates by branch with deterministic ordering', () => {
    const rows = listSymbolRangesByName(db, 'parseConfig', { branch: 'main' });
    expect(rows.map((row) => [row.file_path, row.branch, row.start_line, row.end_line])).toEqual([
      ['src/other.ts', 'main', 5, 8],
      ['src/shared.ts', 'main', 11, 30],
    ]);
  });

  it('should resolve a unique match when path and branch filters are provided', () => {
    const resolution = resolveSymbolRangeByName(db, 'parseConfig', {
      path: 'src/shared.ts',
      branch: 'main',
    });
    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;
    expect(resolution.match).toMatchObject({
      symbol_name: 'parseConfig',
      file_path: 'src/shared.ts',
      branch: 'main',
      start_line: 11,
      end_line: 30,
    });
  });

  it('should resolve a unique match when only branch filtering is provided', () => {
    const resolution = resolveSymbolRangeByName(db, 'parseConfig', { branch: 'feat' });
    expect(resolution.outcome).toBe('resolved');
    if (resolution.outcome !== 'resolved') return;
    expect(resolution.match).toMatchObject({
      file_path: 'src/shared.ts',
      branch: 'feat',
      start_line: 15,
      end_line: 40,
    });
  });

  it('should return a missing outcome for unknown symbols', () => {
    const resolution = resolveSymbolRangeByName(db, 'doesNotExist');
    expect(resolution).toEqual({
      outcome: 'missing',
      symbol: 'doesNotExist',
      path: undefined,
      branch: undefined,
    });
  });

  it('should return a missing outcome that includes requested scope filters', () => {
    const resolution = resolveSymbolRangeByName(db, 'doesNotExist', {
      path: 'src/shared.ts',
      branch: 'main',
    });
    expect(resolution).toEqual({
      outcome: 'missing',
      symbol: 'doesNotExist',
      path: 'src/shared.ts',
      branch: 'main',
    });
  });

  it('should return an ambiguous outcome with deterministic candidates', () => {
    const resolution = resolveSymbolRangeByName(db, 'parseConfig');
    expect(resolution.outcome).toBe('ambiguous');
    if (resolution.outcome !== 'ambiguous') return;
    expect(resolution.candidates.map((row) => [row.file_path, row.branch, row.start_line, row.end_line])).toEqual([
      ['src/other.ts', 'main', 5, 8],
      ['src/shared.ts', 'feat', 15, 40],
      ['src/shared.ts', 'main', 11, 30],
    ]);
  });
});

// ─── external symbol helpers ───────────────────────────────────────────────────

describe('external symbol helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertExternalSymbol(
      db,
      'left-pad',
      '1.3.0',
      'leftPad',
      'function',
      'function leftPad(input: string): string;',
      '/** Left-pad a string */',
    );
    insertExternalSymbol(
      db,
      'dep-utils',
      '2.0.0',
      'leftPad',
      'function',
      'function leftPad(value: string, size: number): string;',
      null,
    );
    insertExternalSymbol(
      db,
      'dep-utils',
      '2.0.0',
      'mapValues',
      'function',
      'function mapValues<T, U>(values: T[]): U[];',
      '/** Map values */',
    );
  });

  it('should return exact external symbol name matches with metadata', () => {
    const rows = getExternalSymbolsByName(db, 'leftpad');
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({
      package_name: 'dep-utils',
      package_version: '2.0.0',
      symbol_name: 'leftPad',
      symbol_kind: 'function',
      dependency_ecosystem: 'npm',
      source_type: 'declaration',
      source_ref: '',
    });
    expect(rows[0]).toHaveProperty('signature');
    expect(rows[0]).toHaveProperty('doc_comment');
    expect(rows[0]).toMatchObject({
      resolved_type_signature: null,
      resolved_return_type: null,
      definition_uri: null,
      definition_path: null,
    });
  });

  it('should return filtered external symbol name matches and respect limit', () => {
    const rows = searchExternalSymbolsByName(db, 'pad', 1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.symbol_name).toBe('leftPad');
    expect(rows[0]).toHaveProperty('package_name');
    expect(rows[0]).toHaveProperty('package_version');
    expect(rows[0]).toHaveProperty('dependency_ecosystem');
    expect(rows[0]).toHaveProperty('source_type');
    expect(rows[0]).toHaveProperty('source_ref');
    expect(rows[0]).toMatchObject({
      resolved_type_signature: null,
      resolved_return_type: null,
      definition_uri: null,
      definition_path: null,
    });
  });

  it('should return persisted enrichment metadata when external symbol columns exist', () => {
    const id = insertExternalSymbol(
      db,
      'typed-lib',
      '3.1.0',
      'render',
      'function',
      'function render(): string;',
      null,
    );
    db.prepare(
      `UPDATE external_symbols
       SET resolved_type_signature = ?,
           resolved_return_type = ?,
           definition_uri = ?,
           definition_path = ?
       WHERE id = ?`,
    ).run(
      'function render(props: Props): JSX.Element',
      'JSX.Element',
      'file:///deps/typed-lib/index.d.ts',
      '/deps/typed-lib/index.d.ts',
      id,
    );

    const exactRows = getExternalSymbolsByName(db, 'render');
    expect(exactRows).toHaveLength(1);
    expect(exactRows[0]).toMatchObject({
      resolved_type_signature: 'function render(props: Props): JSX.Element',
      resolved_return_type: 'JSX.Element',
      definition_uri: 'file:///deps/typed-lib/index.d.ts',
      definition_path: '/deps/typed-lib/index.d.ts',
    });

    const filteredRows = searchExternalSymbolsByName(db, 'rend');
    expect(filteredRows).toHaveLength(1);
    expect(filteredRows[0]).toMatchObject({
      resolved_type_signature: 'function render(props: Props): JSX.Element',
      resolved_return_type: 'JSX.Element',
      definition_uri: 'file:///deps/typed-lib/index.d.ts',
      definition_path: '/deps/typed-lib/index.d.ts',
    });
  });

  it('should order exact external symbol matches by ecosystem and package and preserve source metadata', () => {
    insertExternalSymbol(
      db,
      'zeta-tools',
      '0.9.0',
      'leftPad',
      'function',
      'def leftPad(value: str) -> str;',
      null,
      'pypi',
      'manifest',
      'requirements.txt',
    );

    const rows = getExternalSymbolsByName(db, 'leftPad');
    expect(rows.map((row) => `${row.dependency_ecosystem}:${row.package_name}`)).toEqual([
      'npm:dep-utils',
      'npm:left-pad',
      'pypi:zeta-tools',
    ]);
    expect(rows[2]).toMatchObject({
      dependency_ecosystem: 'pypi',
      source_type: 'manifest',
      source_ref: 'requirements.txt',
    });
  });

  it('should return an empty array when an exact external symbol name is not found', () => {
    expect(getExternalSymbolsByName(db, 'doesNotExist')).toEqual([]);
  });

  it('should perform case-insensitive filtered external symbol search', () => {
    const rows = searchExternalSymbolsByName(db, 'PAD');
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.symbol_name)).toEqual(['leftPad', 'leftPad']);
  });

  it('should apply the default limit of 100 for filtered external symbol searches', () => {
    for (let index = 0; index < 120; index += 1) {
      insertExternalSymbol(
        db,
        `pkg-${index}`,
        '1.0.0',
        `padSymbol${index}`,
        'function',
        `function padSymbol${index}(): void;`,
        null,
      );
    }

    const rows = searchExternalSymbolsByName(db, 'pad');
    expect(rows.length).toBe(100);
    expect(rows.every((row) => row.symbol_name.toLowerCase().includes('pad'))).toBe(true);
  });
});

// ─── listSymbols ──────────────────────────────────────────────────────────────

describe('listSymbols', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    insertSymbol(db, mainId, 'foo');
    insertSymbol(db, mainId, 'bar');
    insertSymbol(db, featId, 'baz');
  });

  it('should return all symbols when no branch filter', () => {
    const rows = listSymbols(db);
    expect(rows.length).toBe(3);
  });

  it('should filter by branch when provided', () => {
    const rows = listSymbols(db, 100, 'main');
    expect(rows.length).toBe(2);
  });

  it('should respect the default limit of 100', () => {
    const rows = listSymbols(db);
    expect(rows.length).toBeLessThanOrEqual(100);
  });

  it('should respect a custom limit', () => {
    const rows = listSymbols(db, 1);
    expect(rows.length).toBe(1);
  });

  it('should return empty array when branch has no symbols', () => {
    expect(listSymbols(db, 100, 'nonexistent')).toEqual([]);
  });

  it('should support options object branch filtering', () => {
    const rows = listSymbols(db, { branch: 'feat', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('baz');
  });

  it('should apply kind, pathPrefix, and language filters from options', () => {
    const matchingFileId = insertFile(db, 'src/components/widget.ts', 'main', 'typescript');
    const wrongLanguageFileId = insertFile(db, 'src/components/widget.js', 'main', 'javascript');
    const wrongPathFileId = insertFile(db, 'lib/components/widget.ts', 'main', 'typescript');
    insertSymbol(db, matchingFileId, 'widgetController', 'class');
    insertSymbol(db, wrongLanguageFileId, 'widgetController', 'class');
    insertSymbol(db, wrongPathFileId, 'widgetController', 'class');

    const rows = listSymbols(db, {
      kind: 'class',
      pathPrefix: 'src/',
      language: 'typescript',
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file_id: matchingFileId,
      name: 'widgetController',
      kind: 'class',
    });
  });

  it('should apply limit and offset from options for pagination', () => {
    const allRows = listSymbols(db, { limit: 10 });
    const pagedRows = listSymbols(db, { limit: 1, offset: 1 });
    expect(pagedRows).toHaveLength(1);
    expect(pagedRows[0]?.id).toBe(allRows[1]?.id);
  });

  it('should return empty array when offset is beyond available rows', () => {
    expect(listSymbols(db, { limit: 10, offset: 999 })).toEqual([]);
  });
});

// ─── getSymbolById ────────────────────────────────────────────────────────────

describe('getSymbolById', () => {
  let db: Database.Database;
  let symbolId: number;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertFile(db, 'src/a.ts', 'main');
    symbolId = insertSymbol(db, fileId, 'myFunc');
  });

  it('should return the symbol row when id exists', () => {
    const row = getSymbolById(db, symbolId);
    expect(row).toBeDefined();
    expect(row!.name).toBe('myFunc');
  });

  it('should return undefined when id does not exist', () => {
    expect(getSymbolById(db, 9999)).toBeUndefined();
  });

  it('should include is_exported in the returned SymbolRow when column exists', () => {
    const dbWithExported = new Database(':memory:');
    dbWithExported.pragma('foreign_keys = ON');
    dbWithExported.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        last_hash TEXT,
        indexed_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(path, branch)
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        doc_comment TEXT,
        is_exported INTEGER NOT NULL DEFAULT 0,
        parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
      );
      CREATE TABLE symbol_metrics (
        symbol_id   INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
        line_count  INTEGER NOT NULL,
        param_count INTEGER NOT NULL,
        cyclomatic  INTEGER NOT NULL,
        max_nesting INTEGER NOT NULL
      );
    `);
    const fileResult = dbWithExported
      .prepare("INSERT INTO files (path, branch, language) VALUES ('src/a.ts', 'main', 'typescript')")
      .run();
    const symResult = dbWithExported
      .prepare(
        'INSERT INTO symbols (file_id, name, kind, start_line, end_line, is_exported) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(fileResult.lastInsertRowid, 'exportedFn', 'function', 1, 10, 1);
    const row = getSymbolById(dbWithExported, symResult.lastInsertRowid as number);
    expect(row).toBeDefined();
    expect(row!.is_exported).toBe(1);
    dbWithExported.close();
  });
});

describe('openReadOnly', () => {
  it('should open an existing database in readonly mode', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-db-'));
    const dbPath = path.join(tempDir, 'lore.sqlite');
    const writable = new Database(dbPath);
    writable.exec('CREATE TABLE demo (id INTEGER PRIMARY KEY);');
    writable.close();

    try {
      const readOnly = openReadOnly(dbPath);
      expect(() => readOnly.prepare('INSERT INTO demo (id) VALUES (1)').run()).toThrow();
      readOnly.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('commit helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createCommitDb();
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('aaa111', 'Alice', 'alice@example.com', 1700000001, 'first');
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('bbb222', 'Bob', 'bob@example.com', 1700000003, 'second');
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('ccc333', 'Alice', 'alice@example.com', 1700000002, 'third');

    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
       VALUES (?, ?, ?, 5, 2)`,
    ).run('aaa111', 'src/{old-name.ts => new-name.ts}', 'renamed');
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
       VALUES (?, ?, ?, 3, 1)`,
    ).run('bbb222', 'src/new-name.ts', 'modified');
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions)
       VALUES (?, ?, ?, 2, 1)`,
    ).run('ccc333', 'src/old-two.ts => src/new-two.ts', 'renamed');

    db.prepare(
      `INSERT INTO commit_refs (commit_sha, ref_name, ref_type)
       VALUES (?, ?, ?)`,
    ).run('aaa111', 'refs/tags/v1.0.0', 'tag');
    db.prepare(
      `INSERT INTO commit_refs (commit_sha, ref_name, ref_type)
       VALUES (?, ?, ?)`,
    ).run('bbb222', 'refs/heads/main', 'branch');
    db.prepare(
      `INSERT INTO commit_refs (commit_sha, ref_name, ref_type)
       VALUES (?, ?, ?)`,
    ).run('bbb222', 'refs/remotes/origin/main', 'branch');
  });

  it('should find a commit by full or partial sha', () => {
    expect(getCommitBySha(db, 'bbb222')?.sha).toBe('bbb222');
    expect(getCommitBySha(db, 'bbb')?.sha).toBe('bbb222');
  });

  it('should list recent commits sorted by timestamp descending', () => {
    const rows = listRecentCommits(db, 2);
    expect(rows.map((r) => r.sha)).toEqual(['bbb222', 'ccc333']);
  });

  it('should list commits by file including brace-rename variants', () => {
    const rows = listCommitsByFile(db, 'src/new-name.ts', 10);
    expect(rows.map((r) => r.sha)).toEqual(['bbb222', 'aaa111']);
  });

  it('should list commits by file including arrow-rename variants', () => {
    const rows = listCommitsByFile(db, 'src/old-two.ts', 10);
    expect(rows.map((r) => r.sha)).toEqual(['ccc333']);
  });

  it('should return an empty list when no commits touched the file', () => {
    expect(listCommitsByFile(db, 'src/missing.ts', 10)).toEqual([]);
  });

  it('should list commits by author name or email substring', () => {
    expect(listCommitsByAuthor(db, 'Alice', 10).map((r) => r.sha)).toEqual(['ccc333', 'aaa111']);
    expect(listCommitsByAuthor(db, 'bob@', 10).map((r) => r.sha)).toEqual(['bbb222']);
  });

  it('should return files touched by a commit', () => {
    const rows = listCommitFiles(db, 'aaa111');
    expect(rows.length).toBe(1);
    expect(rows[0].file_path).toContain('old-name.ts');
  });

  it('should return refs for a commit ordered by type then name', () => {
    const rows = listCommitRefs(db, 'bbb222');
    expect(rows.map((r) => r.ref_name)).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
  });

  it('should return commits for ref queries and only current commit_refs mappings', () => {
    db.prepare('INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES (?, ?, ?)')
      .run('aaa111', 'refs/heads/feature/demo', 'branch');
    db.prepare('DELETE FROM commit_refs WHERE commit_sha = ? AND ref_name = ?')
      .run('aaa111', 'refs/heads/feature/demo');
    db.prepare('INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES (?, ?, ?)')
      .run('ccc333', 'refs/heads/feature/demo', 'branch');

    const rows = listCommitsByRef(db, 'feature/demo', 10);
    expect(rows.map((r) => r.sha)).toEqual(['ccc333']);
  });

  it('should return referenced commits when ref query is empty', () => {
    const rows = listCommitsByRef(db, '', 10);
    expect(rows.map((r) => r.sha)).toEqual(['bbb222', 'aaa111']);
  });

  it('should list semantic commit matches ordered by vector distance', () => {
    loadCommitEmbeddingsTable(db, 3);
    insertCommitEmbedding(db, 'aaa111', [0, 1, 0]);
    insertCommitEmbedding(db, 'bbb222', [1, 0, 0]);
    insertCommitEmbedding(db, 'ccc333', [0.8, 0.2, 0]);

    const rows = listCommitsBySemanticQuery(db, [1, 0, 0], 3);
    expect(rows.map((row) => row.sha)).toEqual(['bbb222', 'ccc333', 'aaa111']);
  });

  it('should return an empty array for semantic commit search when vectors are unavailable', () => {
    expect(listCommitsBySemanticQuery(db, [1, 0, 0], 10)).toEqual([]);
  });

  it('should return an empty array for semantic commit search when vectors table has no rows', () => {
    loadCommitEmbeddingsTable(db, 3);
    expect(listCommitsBySemanticQuery(db, [1, 0, 0], 10)).toEqual([]);
  });

  it('should report commit embeddings availability only when rows exist', () => {
    expect(hasCommitEmbeddings(db)).toBe(false);

    loadCommitEmbeddingsTable(db, 3);
    expect(hasCommitEmbeddings(db)).toBe(false);

    insertCommitEmbedding(db, 'bbb222', [1, 0, 0]);
    expect(hasCommitEmbeddings(db)).toBe(true);
  });

  it('should return an empty array for semantic commit search with an empty query vector', () => {
    loadCommitEmbeddingsTable(db, 3);
    insertCommitEmbedding(db, 'bbb222', [1, 0, 0]);
    expect(listCommitsBySemanticQuery(db, [], 10)).toEqual([]);
  });
});
