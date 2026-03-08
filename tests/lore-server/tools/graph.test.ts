import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef, type GraphArgs, type GraphEdge } from '../../../src/lore-server/tools/graph.js';
import { createRequire } from 'node:module';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const esmRequire = createRequire(import.meta.url);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT '',
      language    TEXT    NOT NULL DEFAULT 'typescript',
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      last_hash   TEXT,
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'function',
      start_line  INTEGER NOT NULL DEFAULT 1,
      end_line    INTEGER NOT NULL DEFAULT 10,
      signature   TEXT,
      doc_comment TEXT
    );
    CREATE TABLE symbol_refs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      callee_id   INTEGER,
      callee_name TEXT    NOT NULL,
      call_kind   TEXT    NOT NULL DEFAULT 'direct'
    );
    CREATE TABLE file_imports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      raw_import  TEXT    NOT NULL,
      resolved_id INTEGER REFERENCES files(id)
    );
    CREATE TABLE modules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      kind        TEXT    NOT NULL,
      manifest    TEXT
    );
    CREATE TABLE file_modules (
      file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      PRIMARY KEY (file_id, module_id)
    );
    CREATE TABLE symbol_relationships (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      source_symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      target_symbol_id   INTEGER REFERENCES symbols(id),
      target_symbol_name TEXT    NOT NULL,
      relationship_type  TEXT    NOT NULL
    );
    CREATE TABLE coverage_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_sha    TEXT    NOT NULL,
      source_path   TEXT    NOT NULL,
      format        TEXT    NOT NULL,
      ingested_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      source_mtime  INTEGER
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

function insertFile(db: Database.Database, path: string, branch: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, 'typescript');
  return result.lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, fileId: number, name: string, kind = 'function'): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    )
    .run(fileId, name, kind);
  return result.lastInsertRowid as number;
}

function insertCallEdge(
  db: Database.Database,
  callerId: number,
  calleeId: number | null,
  calleeName: string,
): void {
  db.prepare('INSERT INTO symbol_refs (caller_id, callee_id, callee_name) VALUES (?, ?, ?)').run(
    callerId,
    calleeId,
    calleeName,
  );
}

function insertImportEdge(
  db: Database.Database,
  fileId: number,
  rawImport: string,
  resolvedId: number | null,
): void {
  db.prepare(
    'INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)',
  ).run(fileId, rawImport, resolvedId);
}

function insertModule(db: Database.Database, name: string, kind = 'package'): number {
  const result = db
    .prepare('INSERT INTO modules (name, kind, manifest) VALUES (?, ?, ?)')
    .run(name, kind, null);
  return result.lastInsertRowid as number;
}

function mapFileToModule(db: Database.Database, fileId: number, moduleId: number): void {
  db.prepare('INSERT INTO file_modules (file_id, module_id) VALUES (?, ?)').run(fileId, moduleId);
}

function insertInheritanceEdge(
  db: Database.Database,
  sourceSymbolId: number,
  targetSymbolId: number | null,
  targetSymbolName: string,
): void {
  db.prepare(
    `INSERT INTO symbol_relationships (source_symbol_id, target_symbol_id, target_symbol_name, relationship_type)
     VALUES (?, ?, ?, 'extends')`,
  ).run(sourceSymbolId, targetSymbolId, targetSymbolName);
}

function loadSymbolEmbeddings(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE symbol_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);
}

function insertSymbolEmbedding(db: Database.Database, symbolId: number, embedding: number[]): void {
  db.prepare(
    'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(symbolId, JSON.stringify(embedding));
}

// ─── handler (kind=call) ──────────────────────────────────────────────────────

describe('lore_graph toolDef', () => {
  it('should expose kind enum values for call, import, module, and inheritance', () => {
    expect(toolDef.inputSchema.properties.kind.enum).toEqual([
      'call',
      'import',
      'module',
      'inheritance',
    ]);
  });

  it('should expose semantic mode controls in the input schema', () => {
    expect(toolDef.inputSchema.properties.mode.enum).toEqual(['structural', 'semantic']);
    expect(toolDef.inputSchema.properties.query_vector.type).toBe('array');
    expect(toolDef.inputSchema.properties.semantic_limit.type).toBe('number');
    expect(toolDef.inputSchema.properties.semantic_max_distance.type).toBe('number');
  });
});

describe('graph handler – kind=call', () => {
  let db: Database.Database;
  let mainSymbolId: number;
  let featSymbolId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main');
    const featFileId = insertFile(db, 'src/feat.ts', 'feat');
    mainSymbolId = insertSymbol(db, mainFileId, 'caller');
    featSymbolId = insertSymbol(db, featFileId, 'featCaller');
    const calleeMainId = insertSymbol(db, mainFileId, 'callee');
    const calleeFeatId = insertSymbol(db, featFileId, 'featCallee');
    insertCallEdge(db, mainSymbolId, calleeMainId, 'callee');
    insertCallEdge(db, featSymbolId, calleeFeatId, 'featCallee');
    const runId = db
      .prepare(
        'INSERT INTO coverage_runs (commit_sha, source_path, format, ingested_at) VALUES (?, ?, ?, ?)',
      )
      .run('abc123', 'coverage/lcov.info', 'lcov', 100).lastInsertRowid as number;
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 1, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 2, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 3, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 4, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 5, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 6, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 7, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 8, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 9, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 10, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 1, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 2, 0);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 3, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 4, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 5, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 6, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 7, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 8, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 9, 1);
    db.prepare('INSERT INTO coverage_lines (run_id, file_path, line_number, hit_count) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 10, 1);
  });

  it('should return all call edges when no filter', () => {
    const result = handler(db, { kind: 'call' });
    expect(result.edges.length).toBe(2);
  });

  it('should include source_branch on each edge', () => {
    const result = handler(db, { kind: 'call' });
    result.edges.forEach((e) => expect(typeof e.source_branch).toBe('string'));
  });

  it('should include callee coverage percentage on call edges', () => {
    const result = handler(db, { kind: 'call', branch: 'main' });
    expect(result.edges[0]?.callee_coverage_percent).toBeCloseTo(90, 5);
  });

  it('should filter call edges by source_id', () => {
    const result = handler(db, { kind: 'call', source_id: mainSymbolId });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('caller');
  });

  it('should filter call edges by branch', () => {
    const result = handler(db, { kind: 'call', branch: 'main' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('main');
  });

  it('should filter call edges by source_id and branch', () => {
    const result = handler(db, { kind: 'call', source_id: mainSymbolId, branch: 'main' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('main');
  });

  it('should return empty edges when branch does not match', () => {
    const result = handler(db, { kind: 'call', branch: 'nonexistent' });
    expect(result.edges).toEqual([]);
  });

  it('should respect the limit parameter', () => {
    const result = handler(db, { kind: 'call', limit: 1 });
    expect(result.edges.length).toBeLessThanOrEqual(1);
  });
});

// ─── handler (kind=import) ────────────────────────────────────────────────────

describe('graph handler – kind=import', () => {
  let db: Database.Database;
  let mainFileId: number;
  let featFileId: number;

  beforeEach(() => {
    db = createTestDb();
    mainFileId = insertFile(db, 'src/main.ts', 'main');
    featFileId = insertFile(db, 'src/feat.ts', 'feat');
    const utilsFileId = insertFile(db, 'src/utils.ts', 'main');
    insertImportEdge(db, mainFileId, './utils', utilsFileId);
    insertImportEdge(db, featFileId, './utils', null);
  });

  it('should return all import edges when no filter', () => {
    const result = handler(db, { kind: 'import' });
    expect(result.edges.length).toBe(2);
  });

  it('should include source_branch on each edge', () => {
    const result = handler(db, { kind: 'import' });
    result.edges.forEach((e) => expect(typeof e.source_branch).toBe('string'));
  });

  it('should filter import edges by source_id', () => {
    const result = handler(db, { kind: 'import', source_id: mainFileId });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('main');
  });

  it('should filter import edges by branch', () => {
    const result = handler(db, { kind: 'import', branch: 'feat' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('feat');
  });

  it('should return empty edges when branch does not match', () => {
    const result = handler(db, { kind: 'import', branch: 'nonexistent' });
    expect(result.edges).toEqual([]);
  });

  it('should use raw_import when resolved_id is null', () => {
    const result = handler(db, { kind: 'import', branch: 'feat' });
    expect(result.edges[0].target_name).toBe('./utils');
  });
});

describe('graph handler – kind=module', () => {
  let db: Database.Database;
  let appModuleId: number;
  let featModuleId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main');
    const featFileId = insertFile(db, 'src/feat.ts', 'feat');
    const sharedFileId = insertFile(db, 'src/shared.ts', 'main');

    appModuleId = insertModule(db, 'app');
    featModuleId = insertModule(db, 'feat-app');
    const sharedModuleId = insertModule(db, 'shared');

    mapFileToModule(db, mainFileId, appModuleId);
    mapFileToModule(db, featFileId, featModuleId);
    mapFileToModule(db, sharedFileId, sharedModuleId);

    insertImportEdge(db, mainFileId, './shared', sharedFileId);
    insertImportEdge(db, featFileId, './missing', null);
  });

  it('should return module edges inferred from file imports', () => {
    const result = handler(db, { kind: 'module' });
    expect(result.edges.length).toBe(2);
  });

  it('should filter module edges by source_id', () => {
    const result = handler(db, { kind: 'module', source_id: appModuleId });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('app');
    expect(result.edges[0].target_name).toBe('shared');
  });

  it('should filter module edges by branch', () => {
    const result = handler(db, { kind: 'module', branch: 'feat' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('feat-app');
    expect(result.edges[0].target_name).toBe('./missing');
  });

  it('should return empty module edges when branch does not match', () => {
    const result = handler(db, { kind: 'module', branch: 'nonexistent' });
    expect(result.edges).toEqual([]);
  });
});

describe('graph handler – kind=inheritance', () => {
  let db: Database.Database;
  let derivedId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main');
    const featFileId = insertFile(db, 'src/feat.ts', 'feat');
    const baseId = insertSymbol(db, mainFileId, 'Base', 'class');
    derivedId = insertSymbol(db, mainFileId, 'Derived', 'class');
    const featDerivedId = insertSymbol(db, featFileId, 'FeatDerived', 'class');

    insertInheritanceEdge(db, derivedId, baseId, 'Base');
    insertInheritanceEdge(db, featDerivedId, null, 'UnknownBase');
  });

  it('should return inheritance edges', () => {
    const result = handler(db, { kind: 'inheritance' });
    expect(result.edges.length).toBe(2);
  });

  it('should filter inheritance edges by source_id', () => {
    const result = handler(db, { kind: 'inheritance', source_id: derivedId });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('Derived');
    expect(result.edges[0].target_name).toBe('Base');
  });

  it('should filter inheritance edges by branch', () => {
    const result = handler(db, { kind: 'inheritance', branch: 'main' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_branch).toBe('main');
  });

  it('should return empty inheritance edges when branch does not match', () => {
    const result = handler(db, { kind: 'inheritance', branch: 'nonexistent' });
    expect(result.edges).toEqual([]);
  });
});

describe('graph handler – semantic mode', () => {
  let db: Database.Database;
  let mainParseId: number;
  let mainRenderId: number;
  let featParseId: number;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/main.ts', 'main');
    const featFileId = insertFile(db, 'src/feat.ts', 'feat');

    mainParseId = insertSymbol(db, mainFileId, 'parseConfig');
    mainRenderId = insertSymbol(db, mainFileId, 'renderPage');
    featParseId = insertSymbol(db, featFileId, 'parseConfigFeat');
    const featRenderId = insertSymbol(db, featFileId, 'renderFeat');

    insertCallEdge(db, mainParseId, mainRenderId, 'renderPage');
    insertCallEdge(db, featParseId, featRenderId, 'renderFeat');

    const mainModuleId = insertModule(db, 'core');
    const featModuleId = insertModule(db, 'feature-core');
    mapFileToModule(db, mainFileId, mainModuleId);
    mapFileToModule(db, featFileId, featModuleId);
  });

  it('should fall back to structural mode when semantic mode is missing query_vector', () => {
    const result = handler(db, { kind: 'call', mode: 'semantic', branch: 'main' });
    expect(result.mode_used).toBe('structural (fallback: missing query_vector)');
    expect(result.semantic_nodes).toEqual([]);
    expect(result.edges).toHaveLength(1);
  });

  it('should fall back to structural mode when embeddings table is unavailable', () => {
    const result = handler(db, { kind: 'call', mode: 'semantic', query_vector: [1, 0, 0], branch: 'main' });
    expect(result.mode_used).toBe('structural (fallback: no embeddings)');
    expect(result.semantic_nodes).toEqual([]);
    expect(result.edges).toHaveLength(1);
  });

  it('should return branch-scoped semantic symbol and module nodes when embeddings are available', () => {
    loadSymbolEmbeddings(db, 3);
    insertSymbolEmbedding(db, mainParseId, [1.0, 0.0, 0.0]);
    insertSymbolEmbedding(db, mainRenderId, [0.9, 0.1, 0.0]);
    insertSymbolEmbedding(db, featParseId, [0.0, 1.0, 0.0]);

    const result = handler(db, {
      kind: 'call',
      mode: 'semantic',
      query_vector: [1.0, 0.0, 0.0],
      branch: 'main',
      semantic_limit: 10,
    });

    expect(result.mode_used).toBe('semantic');
    expect(result.edges).toHaveLength(1);
    const semanticNodes = result.semantic_nodes ?? [];
    const symbolNodes = semanticNodes.filter((node) => node.node_type === 'symbol');
    const moduleNodes = semanticNodes.filter((node) => node.node_type === 'module');

    expect(symbolNodes.map((node) => node.branch)).toEqual(['main', 'main']);
    expect(symbolNodes.map((node) => node.name)).toEqual(['parseConfig', 'renderPage']);
    expect(symbolNodes[0].score).toBeLessThanOrEqual(symbolNodes[1].score);
    expect(moduleNodes).toHaveLength(1);
    expect(moduleNodes[0]).toMatchObject({
      node_type: 'module',
      name: 'core',
      branch: 'main',
      kind: 'package',
    });
    expect(moduleNodes[0].score).toBe(symbolNodes[0].score);
  });

  it('should clamp semantic_limit values below 1 to a single semantic symbol result', () => {
    loadSymbolEmbeddings(db, 3);
    insertSymbolEmbedding(db, mainParseId, [1.0, 0.0, 0.0]);
    insertSymbolEmbedding(db, mainRenderId, [0.9, 0.1, 0.0]);
    insertSymbolEmbedding(db, featParseId, [0.0, 1.0, 0.0]);

    const result = handler(db, {
      kind: 'call',
      mode: 'semantic',
      query_vector: [1.0, 0.0, 0.0],
      branch: 'main',
      semantic_limit: 0,
    });

    expect(result.mode_used).toBe('semantic');
    const semanticNodes = result.semantic_nodes ?? [];
    const symbolNodes = semanticNodes.filter((node) => node.node_type === 'symbol');
    const moduleNodes = semanticNodes.filter((node) => node.node_type === 'module');
    expect(symbolNodes).toHaveLength(1);
    expect(symbolNodes[0].name).toBe('parseConfig');
    expect(moduleNodes).toHaveLength(1);
    expect(moduleNodes[0].name).toBe('core');
  });

  it('should filter semantic nodes by semantic_max_distance threshold', () => {
    loadSymbolEmbeddings(db, 3);
    insertSymbolEmbedding(db, mainParseId, [1.0, 0.0, 0.0]);
    insertSymbolEmbedding(db, mainRenderId, [0.9, 0.1, 0.0]);

    const result = handler(db, {
      kind: 'call',
      mode: 'semantic',
      query_vector: [1.0, 0.0, 0.0],
      branch: 'main',
      semantic_limit: 10,
      semantic_max_distance: 0.001,
    });

    expect(result.mode_used).toBe('semantic');
    const semanticNodes = result.semantic_nodes ?? [];
    const symbolNodes = semanticNodes.filter((node) => node.node_type === 'symbol');
    const moduleNodes = semanticNodes.filter((node) => node.node_type === 'module');
    expect(symbolNodes).toHaveLength(1);
    expect(symbolNodes[0].name).toBe('parseConfig');
    expect(moduleNodes).toHaveLength(1);
    expect(moduleNodes[0].name).toBe('core');
  });
});
