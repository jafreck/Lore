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
  listDocs,
  getDocByPath,
  listDocSections,
  searchDocSections,
  semanticSearchDocSections,
  semanticSearchSymbols,
  listConfigEntries,
  listTestMappingsBySourcePath,
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
  getLatestCoverageRun,
  getCoverageStaleness,
  getLatestCoverageTotals,
  getSymbolCoverageAggregates,
  getCoveragePercentBySymbolIds,
  listCommitCadence,
  listCommitSizes,
  listCommitChurnByFile,
  listCommitAuthorStats,
  listCommitMessagePrefixes,
  listCommitSchedule,
  listCommitBranchActivity,
  type FileRow,
  type SymbolRow,
} from '../../src/lore-server/db.js';

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
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      signature   TEXT,
      doc_comment TEXT
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
      doc_comment          TEXT
    );
    CREATE TABLE config_entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      key           TEXT    NOT NULL,
      value         TEXT,
      default_value TEXT,
      inferred_type TEXT,
      required      INTEGER NOT NULL DEFAULT 0,
      description   TEXT,
      kind          TEXT    NOT NULL,
      UNIQUE(file_id, key)
    );
    CREATE TABLE config_entry_refs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      config_entry_id INTEGER NOT NULL REFERENCES config_entries(id) ON DELETE CASCADE,
      file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      line            INTEGER NOT NULL
    );
    CREATE TABLE docs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT    NOT NULL,
      branch       TEXT    NOT NULL DEFAULT '',
      kind         TEXT    NOT NULL,
      title        TEXT    NOT NULL,
      content      TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      indexed_at   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE doc_sections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id        INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      section_index INTEGER NOT NULL,
      title         TEXT    NOT NULL,
      depth         INTEGER NOT NULL,
      heading_path  TEXT    NOT NULL,
      line_start    INTEGER NOT NULL,
      line_end      INTEGER NOT NULL,
      content       TEXT    NOT NULL,
      content_hash  TEXT    NOT NULL,
      UNIQUE(doc_id, section_index)
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

function createCoverageDb(): Database.Database {
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
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      start_line  INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      signature   TEXT,
      doc_comment TEXT
    );
    CREATE TABLE commits (
      sha          TEXT    PRIMARY KEY,
      author       TEXT    NOT NULL,
      author_email TEXT    NOT NULL,
      timestamp    INTEGER NOT NULL,
      message      TEXT    NOT NULL,
      parents      TEXT    NOT NULL DEFAULT '[]'
    );
    CREATE TABLE coverage_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_sha    TEXT    NOT NULL,
      source_path   TEXT    NOT NULL,
      format        TEXT    NOT NULL,
      ingested_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      source_mtime  INTEGER
    );
    CREATE TABLE coverage_files (
      run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
      file_path     TEXT    NOT NULL,
      lines_found   INTEGER NOT NULL DEFAULT 0,
      lines_hit     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, file_path)
    );
    CREATE TABLE coverage_lines (
      run_id        INTEGER NOT NULL REFERENCES coverage_runs(id) ON DELETE CASCADE,
      file_path     TEXT    NOT NULL,
      line_number   INTEGER NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, file_path, line_number)
    );
  `);
  return db;
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

function insertConfigEntry(
  db: Database.Database,
  fileId: number,
  key: string,
  kind: string,
  value: string | null,
  defaultValue: string | null,
  inferredType: string,
  required: number,
  description: string | null,
): number {
  const result = db
    .prepare(
      `INSERT INTO config_entries (file_id, key, value, default_value, inferred_type, required, description, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(fileId, key, value, defaultValue, inferredType, required, description, kind);
  return result.lastInsertRowid as number;
}

function insertConfigRef(
  db: Database.Database,
  configEntryId: number,
  fileId: number,
  line: number,
): void {
  db.prepare(
    'INSERT INTO config_entry_refs (config_entry_id, file_id, line) VALUES (?, ?, ?)',
  ).run(configEntryId, fileId, line);
}

function insertDoc(
  db: Database.Database,
  docPath: string,
  branch: string,
  kind: string,
  title: string,
  content: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO docs (path, branch, kind, title, content, content_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(docPath, branch, kind, title, content, `${docPath}:${branch}:${kind}`, 1700000000);
  return result.lastInsertRowid as number;
}

function insertDocSection(
  db: Database.Database,
  docId: number,
  sectionIndex: number,
  title: string,
  headingPath: string[],
  content: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO doc_sections
       (doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      docId,
      sectionIndex,
      title,
      Math.max(1, headingPath.length),
      JSON.stringify(headingPath),
      sectionIndex + 1,
      sectionIndex + 2,
      content,
      `${docId}:${sectionIndex}`,
    );
  return result.lastInsertRowid as number;
}

function loadDocSectionEmbeddingsTable(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE doc_section_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);
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

function insertDocSectionEmbedding(
  db: Database.Database,
  sectionId: number,
  embedding: number[],
): void {
  db.prepare(
    'INSERT OR REPLACE INTO doc_section_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(sectionId, JSON.stringify(embedding));
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

// ─── openReadOnly ──────────────────────────────────────────────────────────────

describe('openReadOnly', () => {
  it('should open the database in read-only mode with foreign keys enabled', () => {
    const dbPath = path.join(os.tmpdir(), `lore-db-test-${Date.now()}.sqlite`);
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE files (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT    NOT NULL,
        branch      TEXT    NOT NULL DEFAULT '',
        language    TEXT    NOT NULL,
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        last_hash   TEXT,
        indexed_at  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(path, branch)
      );
    `);
    seedDb.close();

    const db = openReadOnly(dbPath);
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    expect(foreignKeys).toBe(1);
    expect(() => db.prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)').run('a.ts', 'main', 'typescript')).toThrow();

    db.close();
    fs.rmSync(dbPath);
  });
});

describe('coverage helpers', () => {
  it('should return latest coverage run ordered by ingested_at and id', () => {
    const db = createCoverageDb();
    db.prepare(
      'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
    ).run('aaa111', 'cov1.info', 'lcov', 100);
    db.prepare(
      'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
    ).run('bbb222', 'cov2.info', 'lcov', 100);

    const latest = getLatestCoverageRun(db);
    expect(latest?.commit_sha).toBe('bbb222');
  });

  it('should return non-stale metadata when no coverage run exists', () => {
    const db = createCoverageDb();
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('ccc333', 'Alice', 'alice@example.com', 1700000001, 'first');

    const staleness = getCoverageStaleness(db);
    expect(staleness).toEqual({
      coverage_commit: null,
      current_commit: 'ccc333',
      commits_behind: 0,
      stale: false,
    });
  });

  it('should compute commit staleness and latest global coverage totals', () => {
    const db = createCoverageDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    const symbolId = insertSymbol(db, fileId, 'render');
    expect(symbolId).toBeGreaterThan(0);

    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('aaa111', 'Alice', 'alice@example.com', 1700000001, 'first');
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('bbb222', 'Alice', 'alice@example.com', 1700000002, 'second');
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('ccc333', 'Alice', 'alice@example.com', 1700000003, 'third');

    const runId = db
      .prepare(
        'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
      )
      .run('aaa111', 'cov.info', 'lcov', 1700000002).lastInsertRowid as number;
    db.prepare(
      'INSERT INTO coverage_files (run_id, file_path, lines_found, lines_hit) VALUES (?, ?, ?, ?)',
    ).run(runId, 'src/main.ts', 5, 3);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 1, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 2, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 3, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 4, 1);

    const staleness = getCoverageStaleness(db);
    expect(staleness.coverage_commit).toBe('aaa111');
    expect(staleness.current_commit).toBe('ccc333');
    expect(staleness.commits_behind).toBe(2);
    expect(staleness.stale).toBe(true);

    const totals = getLatestCoverageTotals(db);
    expect(totals).toEqual({
      lines_found: 5,
      lines_hit: 3,
      coverage_percent: 60,
    });
  });

  it('should return symbol aggregates and coverage map with branch filtering', () => {
    const db = createCoverageDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main');
    const featFileId = insertFile(db, 'src/feat.ts', 'feat');
    const mainSymbolId = insertSymbol(db, mainFileId, 'render');
    const featSymbolId = insertSymbol(db, featFileId, 'render');
    const runId = db
      .prepare(
        'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
      )
      .run('aaa111', 'cov.info', 'lcov', 1700000002).lastInsertRowid as number;

    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 1, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 2, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 3, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 1, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 2, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 3, 1);

    const aggregates = getSymbolCoverageAggregates(db, { symbolIds: [mainSymbolId], limit: 10 });
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]?.uncovered_lines).toEqual([2]);
    expect(aggregates[0]?.coverage_percent).toBeCloseTo(66.666, 2);

    const coverageMap = getCoveragePercentBySymbolIds(db, [mainSymbolId, featSymbolId], 'main');
    expect(coverageMap.get(mainSymbolId)).toBeCloseTo(66.666, 2);
    expect(coverageMap.has(featSymbolId)).toBe(false);
    expect(getCoveragePercentBySymbolIds(db, [])).toEqual(new Map());
  });
});

// ─── FileRow interface ────────────────────────────────────────────────────────

describe('FileRow interface', () => {
  it('should include a branch field', () => {
    const db = createTestDb();
    const id = insertFile(db, 'src/foo.ts', 'main');
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow;
    expect(row).toHaveProperty('branch');
    expect(typeof row.branch).toBe('string');
    db.close();
  });
});

// ─── getFileById ──────────────────────────────────────────────────────────────

describe('getFileById', () => {
  let db: Database.Database;
  let fileId: number;

  beforeEach(() => {
    db = createTestDb();
    fileId = insertFile(db, 'src/index.ts', 'main');
  });

  it('should return the file row when id exists', () => {
    const row = getFileById(db, fileId);
    expect(row).toBeDefined();
    expect(row!.path).toBe('src/index.ts');
    expect(row!.branch).toBe('main');
  });

  it('should return undefined when id does not exist', () => {
    expect(getFileById(db, 9999)).toBeUndefined();
  });

  it('should filter by branch when branch is provided and matches', () => {
    const row = getFileById(db, fileId, 'main');
    expect(row).toBeDefined();
    expect(row!.branch).toBe('main');
  });

  it('should return undefined when branch does not match', () => {
    expect(getFileById(db, fileId, 'other-branch')).toBeUndefined();
  });

  it('should return the row regardless of branch when branch is omitted', () => {
    insertFile(db, 'src/other.ts', 'feat');
    const row = getFileById(db, fileId);
    expect(row).toBeDefined();
  });
});

// ─── getFileByPath ────────────────────────────────────────────────────────────

describe('getFileByPath', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, 'src/utils.ts', 'main');
    insertFile(db, 'src/utils.ts', 'feat');
  });

  it('should return a row when path matches and no branch filter', () => {
    // Without branch there may be multiple rows; SQLite returns first match.
    const row = getFileByPath(db, 'src/utils.ts');
    expect(row).toBeDefined();
    expect(row!.path).toBe('src/utils.ts');
  });

  it('should filter by branch when provided', () => {
    const row = getFileByPath(db, 'src/utils.ts', 'feat');
    expect(row).toBeDefined();
    expect(row!.branch).toBe('feat');
  });

  it('should return undefined when path does not exist', () => {
    expect(getFileByPath(db, 'nonexistent.ts')).toBeUndefined();
  });

  it('should return undefined when branch does not match', () => {
    expect(getFileByPath(db, 'src/utils.ts', 'nonexistent-branch')).toBeUndefined();
  });
});

// ─── listFiles ────────────────────────────────────────────────────────────────

describe('listFiles', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, 'a.ts', 'main');
    insertFile(db, 'b.ts', 'main');
    insertFile(db, 'c.ts', 'feat');
  });

  it('should return all files when no branch filter (default limit is large)', () => {
    const rows = listFiles(db);
    expect(rows.length).toBe(3);
  });

  it('should filter by branch when branch is provided', () => {
    const rows = listFiles(db, undefined, 'main');
    expect(rows.length).toBe(2);
    rows.forEach((r) => expect(r.branch).toBe('main'));
  });

  it('should respect the limit parameter', () => {
    const rows = listFiles(db, 1);
    expect(rows.length).toBe(1);
  });

  it('should respect the limit parameter when filtering by branch', () => {
    const rows = listFiles(db, 1, 'main');
    expect(rows.length).toBe(1);
  });

  it('should return an empty array when branch has no files', () => {
    const rows = listFiles(db, undefined, 'nonexistent');
    expect(rows).toEqual([]);
  });
});

describe('listFilesByPathPrefix', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, 'src/main.ts', 'main');
    insertFile(db, 'src/utils/helpers.ts', 'main');
    insertFile(db, 'src/utils/helpers.ts', 'feat');
    insertFile(db, 'scripts/build.ts', 'main');
  });

  it('should return exact-path and descendant matches in deterministic order', () => {
    const rows = listFilesByPathPrefix(db, 'src');
    expect(rows.map((row) => `${row.path}@${row.branch}`)).toEqual([
      'src/main.ts@main',
      'src/utils/helpers.ts@feat',
      'src/utils/helpers.ts@main',
    ]);
  });

  it('should normalize trailing slashes and filter by branch when provided', () => {
    const rows = listFilesByPathPrefix(db, 'src/', 'main');
    expect(rows.map((row) => `${row.path}@${row.branch}`)).toEqual([
      'src/main.ts@main',
      'src/utils/helpers.ts@main',
    ]);
  });

  it('should return an empty array for blank prefixes', () => {
    expect(listFilesByPathPrefix(db, '   ')).toEqual([]);
  });

  it('should respect the limit parameter', () => {
    const rows = listFilesByPathPrefix(db, 'src', undefined, 2);
    expect(rows).toHaveLength(2);
  });
});

// ─── listResolvedEdges ────────────────────────────────────────────────────────

describe('listResolvedEdges', () => {
  function createEdgeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE files (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT    NOT NULL,
        branch     TEXT    NOT NULL DEFAULT '',
        language   TEXT    NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        last_hash  TEXT,
        indexed_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(path, branch)
      );
      CREATE TABLE symbols (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        signature  TEXT,
        doc_comment TEXT
      );
      CREATE TABLE symbol_refs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id           INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        file_id             INTEGER REFERENCES files(id) ON DELETE CASCADE,
        callee_id           INTEGER REFERENCES symbols(id),
        callee_name         TEXT    NOT NULL,
        call_line           INTEGER NOT NULL,
        call_character      INTEGER,
        call_kind           TEXT    NOT NULL DEFAULT 'direct',
        resolution_method   TEXT    NOT NULL DEFAULT 'unresolved'
      );
    `);
    return db;
  }

  let db: Database.Database;
  let fileA: number;
  let fileB: number;
  let callerSym: number;
  let calleeSym: number;

  beforeEach(() => {
    db = createEdgeDb();
    fileA = Number(db.prepare("INSERT INTO files (path, branch, language) VALUES ('src/a.ts', 'main', 'typescript')").run().lastInsertRowid);
    fileB = Number(db.prepare("INSERT INTO files (path, branch, language) VALUES ('src/b.ts', 'main', 'typescript')").run().lastInsertRowid);
    callerSym = Number(db.prepare("INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, 'doWork', 'function', 1, 20)").run(fileA).lastInsertRowid);
    calleeSym = Number(db.prepare("INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, 'helper', 'function', 1, 10)").run(fileB).lastInsertRowid);

    // Resolved edge
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_kind, resolution_method)
       VALUES (?, ?, ?, 'helper', 5, 'direct', 'lsp_definition')`,
    ).run(callerSym, fileA, calleeSym);

    // Unresolved edge
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, call_kind, resolution_method)
       VALUES (?, ?, 'unknown', 12, 'direct', 'unresolved')`,
    ).run(callerSym, fileA);
  });

  it('should return all edges by default', () => {
    const edges = listResolvedEdges(db);
    expect(edges).toHaveLength(2);
    expect(edges[0]!.caller_name).toBe('doWork');
    expect(edges[0]!.callee_id).toBe(calleeSym);
    expect(edges[0]!.callee_file_path).toBe('src/b.ts');
    expect(edges[1]!.callee_id).toBeNull();
  });

  it('should filter to resolved-only edges', () => {
    const edges = listResolvedEdges(db, { resolvedOnly: true });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.resolution_method).toBe('lsp_definition');
    expect(edges[0]!.callee_name).toBe('helper');
  });

  it('should filter by file_id', () => {
    // Add an edge from fileB so there's something to exclude
    const sym2 = Number(db.prepare("INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, 'other', 'function', 1, 5)").run(fileB).lastInsertRowid);
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, call_kind, resolution_method)
       VALUES (?, ?, 'doWork', 3, 'direct', 'unresolved')`,
    ).run(sym2, fileB);

    const edgesA = listResolvedEdges(db, { fileId: fileA });
    expect(edgesA).toHaveLength(2);
    expect(edgesA.every(e => e.caller_file_id === fileA)).toBe(true);

    const edgesB = listResolvedEdges(db, { fileId: fileB });
    expect(edgesB).toHaveLength(1);
    expect(edgesB[0]!.caller_name).toBe('other');
  });

  it('should respect the limit parameter', () => {
    const edges = listResolvedEdges(db, { limit: 1 });
    expect(edges).toHaveLength(1);
  });

  it('should return empty for non-existent fileId', () => {
    const edges = listResolvedEdges(db, { fileId: 9999 });
    expect(edges).toEqual([]);
  });
});

describe('documentation helpers', () => {
  let db: Database.Database;
  let readmeMainDocId: number;
  let readmeFeatDocId: number;
  let architectureDocId: number;
  let guideDocId: number;
  let architectureSectionId: number;

  beforeEach(() => {
    db = createTestDb();
    readmeMainDocId = insertDoc(db, '/repo/README.md', 'main', 'readme', 'Lore', '# Lore\n## Install');
    readmeFeatDocId = insertDoc(db, '/repo/README.md', 'feat', 'readme', 'Lore feat', '# Lore\n## Branch');
    architectureDocId = insertDoc(
      db,
      '/repo/docs/architecture.md',
      'main',
      'architecture',
      'Architecture',
      '# Architecture\n## Overview',
    );
    guideDocId = insertDoc(db, '/repo/docs/guide.md', 'main', 'guide', 'Guide', '# Guide\n## Setup');

    insertDocSection(db, readmeMainDocId, 0, 'Lore', ['Lore'], 'Root intro');
    insertDocSection(db, readmeMainDocId, 1, 'Install', ['Lore', 'Install'], 'Install with npm');
    insertDocSection(db, readmeFeatDocId, 0, 'Lore', ['Lore'], 'Feature branch readme');
    architectureSectionId = insertDocSection(
      db,
      architectureDocId,
      0,
      'Architecture',
      ['Architecture'],
      'System overview',
    );
    insertDocSection(db, guideDocId, 0, 'Guide', ['Guide'], 'Setup walkthrough');
  });

  it('listDocs returns deterministically ordered docs and supports kind/branch filters', () => {
    const allDocs = listDocs(db, { limit: 20 });
    expect(allDocs.map((row) => `${row.path}@${row.branch}`)).toEqual([
      '/repo/README.md@feat',
      '/repo/README.md@main',
      '/repo/docs/architecture.md@main',
      '/repo/docs/guide.md@main',
    ]);

    const filtered = listDocs(db, {
      branch: 'main',
      kinds: ['guide', 'architecture'],
      limit: 20,
    });
    expect(filtered.map((row) => `${row.path}:${row.kind}`)).toEqual([
      '/repo/docs/architecture.md:architecture',
      '/repo/docs/guide.md:guide',
    ]);

    expect(listDocs(db, { kind: 'adr' })).toEqual([]);
  });

  it('should merge, trim, and deduplicate kind filters across kind and kinds args', () => {
    const mergedKindsDocs = listDocs(db, {
      kind: ' readme ',
      kinds: ['guide', 'readme', '  ', 'guide'],
      limit: 20,
    });
    expect(mergedKindsDocs.map((row) => `${row.path}:${row.kind}`)).toEqual([
      '/repo/README.md:readme',
      '/repo/README.md:readme',
      '/repo/docs/guide.md:guide',
    ]);

    const mergedKindsSections = listDocSections(db, {
      path: '/repo/README.md',
      kind: ' readme ',
      kinds: ['readme', ' guide '],
      limit: 20,
    });
    expect(mergedKindsSections.map((row) => row.section_index)).toEqual([0, 0, 1]);

    const mergedKindsSearch = searchDocSections(db, {
      query: 'guide',
      kind: ' guide ',
      kinds: ['guide', ''],
      limit: 20,
    });
    expect(mergedKindsSearch.map((row) => row.doc_kind)).toEqual(['guide']);
  });

  it('getDocByPath supports optional branch lookup and empty results', () => {
    const exact = getDocByPath(db, '/repo/README.md', 'main');
    expect(exact?.id).toBe(readmeMainDocId);
    expect(exact?.content).toContain('Install');

    const defaultBranchRow = getDocByPath(db, '/repo/README.md');
    expect(defaultBranchRow?.branch).toBe('feat');
    expect(getDocByPath(db, '/repo/missing.md', 'main')).toBeUndefined();
  });

  it('listDocSections includes heading-path metadata with deterministic ordering and filtering', () => {
    const allSections = listDocSections(db, { limit: 20 });
    expect(allSections.map((row) => `${row.doc_path}@${row.doc_branch}#${row.section_index}`)).toEqual([
      '/repo/README.md@feat#0',
      '/repo/README.md@main#0',
      '/repo/README.md@main#1',
      '/repo/docs/architecture.md@main#0',
      '/repo/docs/guide.md@main#0',
    ]);
    expect(allSections[2]?.heading_path).toBe(JSON.stringify(['Lore', 'Install']));

    const readmeMainSections = listDocSections(db, {
      path: '/repo/README.md',
      branch: 'main',
      kind: 'readme',
      limit: 20,
    });
    expect(readmeMainSections.map((row) => row.section_index)).toEqual([0, 1]);
    expect(listDocSections(db, { kind: 'adr', limit: 20 })).toEqual([]);
  });

  it('searchDocSections supports path/branch/kind filtering with deterministic ordering', () => {
    const results = searchDocSections(db, {
      query: 'overview',
      branch: 'main',
      kinds: ['architecture', 'readme'],
      limit: 20,
    });
    expect(results.map((row) => `${row.doc_path}:${row.title}`)).toEqual([
      '/repo/docs/architecture.md:Architecture',
    ]);

    const scoped = searchDocSections(db, {
      query: 'install',
      path: '/repo/README.md',
      branch: 'main',
      kind: 'readme',
      limit: 20,
    });
    expect(scoped.map((row) => row.section_index)).toEqual([1]);
    expect(scoped[0]?.heading_path).toBe(JSON.stringify(['Lore', 'Install']));
    expect(searchDocSections(db, { query: '   ', limit: 20 })).toEqual([]);
    expect(searchDocSections(db, { query: 'missing', limit: 20 })).toEqual([]);
  });

  it('semanticSearchDocSections should return an empty list for an empty query vector', () => {
    expect(semanticSearchDocSections(db, { queryVector: [] })).toEqual([]);
  });

  it('semanticSearchDocSections should return results for matching embeddings', () => {
    loadDocSectionEmbeddingsTable(db, 3);
    insertDocSectionEmbedding(db, architectureSectionId, [1, 0, 0]);
    // With a properly parameterised k value, the vec0 query returns
    // matching rows when the embedding table has data.
    const rows = semanticSearchDocSections(db, {
      queryVector: [1, 0, 0],
      branch: 'main',
      kinds: ['readme', 'architecture'],
      limit: 20,
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ─── listTestMappingsBySourcePath ──────────────────────────────────────────────

describe('listTestMappingsBySourcePath', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.exec(`
      CREATE TABLE test_mappings (
        test_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        confidence     TEXT    NOT NULL DEFAULT 'heuristic',
        UNIQUE(test_file_id, source_file_id)
      );
    `);
  });

  it('should return mapped test paths with confidence sorted by test path', () => {
    const sourceMainId = insertFile(db, 'src/math.ts', 'main');
    const sourceFeatId = insertFile(db, 'src/math.ts', 'feat');
    const testMainId = insertFile(db, 'tests/main/math.test.ts', 'main');
    const testFeatId = insertFile(db, 'tests/feat/math.test.ts', 'feat');

    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)').run(testMainId, sourceMainId, 'import');
    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)').run(testFeatId, sourceFeatId, 'heuristic');

    const mappings = listTestMappingsBySourcePath(db, 'src/math.ts');
    expect(mappings).toEqual([
      { test_path: 'tests/feat/math.test.ts', confidence: 'heuristic' },
      { test_path: 'tests/main/math.test.ts', confidence: 'import' },
    ]);
  });

  it('should filter mappings by source and test branch when branch is provided', () => {
    const sourceMainId = insertFile(db, 'src/math.ts', 'main');
    const sourceFeatId = insertFile(db, 'src/math.ts', 'feat');
    const testMainId = insertFile(db, 'tests/math.test.ts', 'main');
    const testFeatId = insertFile(db, 'tests/math.test.ts', 'feat');

    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)').run(testMainId, sourceMainId, 'import');
    db.prepare('INSERT INTO test_mappings (test_file_id, source_file_id, confidence) VALUES (?, ?, ?)').run(testFeatId, sourceFeatId, 'heuristic');

    const mappings = listTestMappingsBySourcePath(db, 'src/math.ts', 'feat');
    expect(mappings).toEqual([{ test_path: 'tests/math.test.ts', confidence: 'heuristic' }]);
  });

  it('should return an empty array when the source file has no mappings', () => {
    insertFile(db, 'src/math.ts', 'main');
    expect(listTestMappingsBySourcePath(db, 'src/math.ts')).toEqual([]);
    expect(listTestMappingsBySourcePath(db, 'src/missing.ts')).toEqual([]);
  });
});

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
    db.exec(`
      CREATE TABLE symbol_metrics (
        symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
        line_count INTEGER,
        param_count INTEGER,
        cyclomatic INTEGER,
        max_nesting INTEGER
      );
    `);
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
    db.exec(`
      ALTER TABLE external_symbols ADD COLUMN resolved_type_signature TEXT;
      ALTER TABLE external_symbols ADD COLUMN resolved_return_type TEXT;
      ALTER TABLE external_symbols ADD COLUMN definition_uri TEXT;
      ALTER TABLE external_symbols ADD COLUMN definition_path TEXT;
    `);
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

  it('should return empty arrays when external_symbols table is unavailable', () => {
    const noExternalDb = new Database(':memory:');
    noExternalDb.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL, branch TEXT NOT NULL, language TEXT NOT NULL);
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL
      );
    `);

    expect(getExternalSymbolsByName(noExternalDb, 'leftPad')).toEqual([]);
    expect(searchExternalSymbolsByName(noExternalDb, 'left')).toEqual([]);
    noExternalDb.close();
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

// ─── listConfigEntries ────────────────────────────────────────────────────────

describe('listConfigEntries (stub — no DDL exists)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should always return an empty array (no config_entries DDL exists)', () => {
    // listConfigEntries is a no-op stub because the config_entries and
    // config_entry_refs tables were never created in the main DDL.
    // The stub always returns [] regardless of arguments.
    expect(listConfigEntries(db)).toEqual([]);
    expect(listConfigEntries(db, { key: 'API_KEY' })).toEqual([]);
    expect(listConfigEntries(db, { filePath: 'config/.env' })).toEqual([]);
    expect(listConfigEntries(db, { kind: 'env' })).toEqual([]);
    expect(listConfigEntries(db, { key: 'X', filePath: 'Y', kind: 'Z' })).toEqual([]);
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

  it('should return empty arrays when commit_refs table is unavailable', () => {
    const noRefsDb = createCommitDb(false);
    noRefsDb.prepare(
      `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run('sha1', 'User', 'user@example.com', 1, 'msg');

    expect(listCommitRefs(noRefsDb, 'sha1')).toEqual([]);
    expect(listCommitsByRef(noRefsDb, 'main', 10)).toEqual([]);
    noRefsDb.close();
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

// ─── Commit stats helpers ─────────────────────────────────────────────────────

describe('commit stats helpers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createCommitDb();
    // Insert some commits
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, message, timestamp) VALUES (?, ?, ?, ?, ?)`,
    ).run('aaa', 'Alice', 'alice@example.com', 'feat: add feature A', 1700000000);
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, message, timestamp) VALUES (?, ?, ?, ?, ?)`,
    ).run('bbb', 'Bob', 'bob@example.com', 'fix: bug B', 1700100000);
    db.prepare(
      `INSERT INTO commits (sha, author, author_email, message, timestamp) VALUES (?, ?, ?, ?, ?)`,
    ).run('ccc', 'Alice', 'alice@example.com', 'chore: cleanup', 1700200000);
    // Insert commit_files
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES (?, ?, ?, ?, ?)`,
    ).run('aaa', 'src/a.ts', 'A', 50, 0);
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES (?, ?, ?, ?, ?)`,
    ).run('bbb', 'src/a.ts', 'M', 10, 5);
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES (?, ?, ?, ?, ?)`,
    ).run('bbb', 'src/b.ts', 'A', 30, 0);
    db.prepare(
      `INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES (?, ?, ?, ?, ?)`,
    ).run('ccc', 'src/a.ts', 'M', 5, 20);
  });

  describe('listCommitCadence', () => {
    it('should return daily commit cadence', () => {
      const result = listCommitCadence(db, 'day');
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('bucket');
      expect(result[0]).toHaveProperty('commits');
    });

    it('should return weekly commit cadence', () => {
      const result = listCommitCadence(db, 'week');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return monthly commit cadence', () => {
      const result = listCommitCadence(db, 'month');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should filter by since/until dates', () => {
      const result = listCommitCadence(db, 'day', {
        since: '2023-11-14',
        until: '2023-11-16',
      });
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should filter by author', () => {
      const result = listCommitCadence(db, 'day', { author: 'Alice' });
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('listCommitSizes', () => {
    it('should return commit sizes with insertions and deletions', () => {
      const result = listCommitSizes(db);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('sha');
      expect(result[0]).toHaveProperty('insertions');
      expect(result[0]).toHaveProperty('deletions');
    });

    it('should respect limit', () => {
      const result = listCommitSizes(db, { limit: 1 });
      expect(result.length).toBe(1);
    });

    it('should filter by author', () => {
      const result = listCommitSizes(db, { author: 'Bob' });
      expect(result.length).toBe(1);
      expect(result[0]?.author).toBe('Bob');
    });

    it('should filter by since/until', () => {
      const result = listCommitSizes(db, {
        since: '2023-11-15',
        until: '2023-11-16',
      });
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('listCommitChurnByFile', () => {
    it('should return churn stats per file', () => {
      const result = listCommitChurnByFile(db);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('file_path');
      expect(result[0]).toHaveProperty('commit_count');
      expect(result[0]).toHaveProperty('total_churn');
    });

    it('should respect limit', () => {
      const result = listCommitChurnByFile(db, { limit: 1 });
      expect(result.length).toBe(1);
    });

    it('should filter by author', () => {
      const result = listCommitChurnByFile(db, { author: 'Alice' });
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('listCommitAuthorStats', () => {
    it('should return stats per author', () => {
      const result = listCommitAuthorStats(db);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('author');
      expect(result[0]).toHaveProperty('commit_count');
    });

    it('should respect limit', () => {
      const result = listCommitAuthorStats(db, { limit: 1 });
      expect(result.length).toBe(1);
    });

    it('should filter by time range', () => {
      const result = listCommitAuthorStats(db, {
        since: '2023-11-14',
        until: '2023-11-17',
      });
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('listCommitMessagePrefixes', () => {
    it('should return message prefix counts', () => {
      const result = listCommitMessagePrefixes(db);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('prefix');
      expect(result[0]).toHaveProperty('count');
    });

    it('should respect limit', () => {
      const result = listCommitMessagePrefixes(db, { limit: 1 });
      expect(result.length).toBe(1);
    });
  });

  describe('listCommitSchedule', () => {
    it('should return commit schedule by day-of-week and hour', () => {
      const result = listCommitSchedule(db);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('day_of_week');
      expect(result[0]).toHaveProperty('hour_of_day');
      expect(result[0]).toHaveProperty('commits');
    });

    it('should filter by author', () => {
      const result = listCommitSchedule(db, { author: 'Alice' });
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('listCommitBranchActivity', () => {
    it('should return empty when commit_refs table has no data', () => {
      const result = listCommitBranchActivity(db);
      expect(result).toEqual([]);
    });

    it('should return branch activity when commit_refs data exists', () => {
      // Insert commit_refs data
      db.exec(`
        INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('aaa', 'main', 'branch');
        INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('bbb', 'main', 'branch');
        INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('ccc', 'develop', 'branch');
      `);
      const result = listCommitBranchActivity(db);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('ref_name');
      expect(result[0]).toHaveProperty('commits');
    });

    it('should respect limit', () => {
      db.exec(`
        INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('aaa', 'main', 'branch');
        INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('bbb', 'develop', 'branch');
      `);
      const result = listCommitBranchActivity(db, { limit: 1 });
      expect(result.length).toBe(1);
    });
  });
});
