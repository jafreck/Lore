import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef, type GraphArgs, type GraphEdge, type CompactGraphEdge } from '../../../src/server/tools/graph.js';
import { openDb } from '../../../src/db/schema.js';
import { createRequire } from 'node:module';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const esmRequire = createRequire(import.meta.url);

function createTestDb(): Database.Database {
  const db = openDb(':memory:');
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, ?, ?, 0, NULL, \'\')')
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
  line = 0,
  character?: number,
  resolutionMethod = 'unresolved',
): void {
  db.prepare(
    'INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line, call_character, resolution_method) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(callerId, calleeId, calleeName, line, character ?? null, resolutionMethod);
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
  fileId: number,
  line = 1,
): void {
  db.prepare(
    `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line)
     VALUES (?, ?, ?, ?, 'extends', ?)`,
  ).run(fileId, sourceSymbolId, targetSymbolId, targetSymbolName, line);
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
  it('should expose kind enum values for call, import, module, inheritance, and type_dependency', () => {
    expect(toolDef.inputSchema.properties.kind.enum).toEqual([
      'call',
      'import',
      'module',
      'inheritance',
      'type_dependency',
    ]);
  });

  it('should expose semantic mode controls in the input schema', () => {
    expect(toolDef.inputSchema.properties.mode.enum).toEqual(['structural', 'semantic']);
    expect(toolDef.inputSchema.properties.query_vector.type).toBe('array');
    expect(toolDef.inputSchema.properties.semantic_limit.type).toBe('number');
    expect(toolDef.inputSchema.properties.semantic_max_distance.type).toBe('number');
  });

  it('should expose target_id for reverse/inbound edge queries', () => {
    expect(toolDef.inputSchema.properties.target_id).toBeDefined();
    expect(toolDef.inputSchema.properties.target_id.type).toBe('number');
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
    db.prepare('INSERT INTO coverage_files (run_id, file_path, lines_found, lines_hit) VALUES (?, ?, ?, ?)').run(runId, 'src/main.ts', 10, 9);
    db.prepare('INSERT INTO coverage_files (run_id, file_path, lines_found, lines_hit) VALUES (?, ?, ?, ?)').run(runId, 'src/feat.ts', 10, 8);
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

  it('should filter call edges by target_id (reverse/inbound)', () => {
    // calleeMainId is the callee; find its callers
    const all = handler(db, { kind: 'call' });
    const calleeId = all.edges.find((e) => e.source_name === 'caller')?.target_id;
    expect(calleeId).toBeDefined();
    const result = handler(db, { kind: 'call', target_id: calleeId! });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('caller');
  });

  it('should filter call edges by both source_id and target_id', () => {
    const all = handler(db, { kind: 'call' });
    const edge = all.edges.find((e) => e.source_name === 'caller')!;
    const result = handler(db, { kind: 'call', source_id: edge.source_id!, target_id: edge.target_id! });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('caller');
  });

  it('should return empty when target_id does not match any callee', () => {
    const result = handler(db, { kind: 'call', target_id: 99999 });
    expect(result.edges).toEqual([]);
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

  it('should filter import edges by target_id (who imports this file)', () => {
    // mainFileId imports utilsFileId; find importers of utilsFileId
    const all = handler(db, { kind: 'import', branch: 'main' });
    const targetId = all.edges[0]?.target_id;
    expect(targetId).toBeDefined();
    const result = handler(db, { kind: 'import', target_id: targetId! });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('src/main.ts');
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

    insertInheritanceEdge(db, derivedId, baseId, 'Base', mainFileId);
    insertInheritanceEdge(db, featDerivedId, null, 'UnknownBase', featFileId);
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

  it('should filter inheritance edges by target_id (who extends this base)', () => {
    // Find all classes that extend Base
    const all = handler(db, { kind: 'inheritance', branch: 'main' });
    const baseId = all.edges[0]?.target_id;
    expect(baseId).toBeDefined();
    const result = handler(db, { kind: 'inheritance', target_id: baseId! });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('Derived');
    expect(result.edges[0].target_name).toBe('Base');
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

// ─── handler (kind=inheritance with implements) ───────────────────────────────

describe('graph handler – inheritance includes implements', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    const classId = insertSymbol(db, fileId, 'MyService', 'class');
    const ifaceId = insertSymbol(db, fileId, 'IService', 'interface');
    // extends
    insertInheritanceEdge(db, classId, null, 'BaseService', fileId);
    // implements
    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line)
       VALUES (?, ?, ?, ?, 'implements', 1)`,
    ).run(fileId, classId, ifaceId, 'IService');
  });

  it('should return both extends and implements edges', () => {
    const result = handler(db, { kind: 'inheritance' });
    expect(result.edges.length).toBe(2);
  });
});

// ─── handler (kind=type_dependency) ───────────────────────────────────────────

describe('graph handler – kind=type_dependency', () => {
  let db: Database.Database;
  let symbolId: number;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    symbolId = insertSymbol(db, fileId, 'process');
    const targetId = insertSymbol(db, fileId, 'MyStruct', 'struct');
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line)
       VALUES (?, ?, ?, 'MyStruct', 'MyStruct', 'parameter', 5)`,
    ).run(fileId, symbolId, targetId);
  });

  it('should return type dependency edges', () => {
    const result = handler(db, { kind: 'type_dependency' });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('process');
    expect(result.edges[0].target_name).toBe('MyStruct');
  });

  it('should filter type dependency edges by source_id', () => {
    const result = handler(db, { kind: 'type_dependency', source_id: symbolId });
    expect(result.edges.length).toBe(1);
  });

  it('should filter type dependency edges by target_id (who references this type)', () => {
    const all = handler(db, { kind: 'type_dependency' });
    const typeId = all.edges[0]?.target_id;
    expect(typeId).toBeDefined();
    const result = handler(db, { kind: 'type_dependency', target_id: typeId! });
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source_name).toBe('process');
    expect(result.edges[0].target_name).toBe('MyStruct');
  });
});

// ─── Provenance fields on edges ───────────────────────────────────────────────

describe('graph handler – provenance fields', () => {
  it('should expose resolution_method and definition location on call edges', () => {
    const db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    const callerId = insertSymbol(db, fileId, 'caller');
    const calleeId = insertSymbol(db, fileId, 'callee');
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line, call_character, resolution_method, definition_path, definition_line, definition_character)
       VALUES (?, ?, 'callee', 5, 10, 'lsp_definition', 'src/main.ts', 20, 4)`,
    ).run(callerId, calleeId);

    const result = handler(db, { kind: 'call', branch: 'main' });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      line: 6,
      character: 11,
      resolution_method: 'lsp_definition',
      definition_path: 'src/main.ts',
      definition_line: 20,
      definition_character: 4,
    });
  });

  it('should expose resolution_method on type dependency edges', () => {
    const db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    const symbolId = insertSymbol(db, fileId, 'process');
    const targetId = insertSymbol(db, fileId, 'MyType', 'class');
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method, definition_path, definition_line, definition_character)
       VALUES (?, ?, ?, 'MyType', 'MyType', 'parameter', 8, 4, 'lsp_definition', 'src/main.ts', 1, 0)`,
    ).run(fileId, symbolId, targetId);

    const result = handler(db, { kind: 'type_dependency', branch: 'main' });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      line: 9,
      character: 5,
      resolution_method: 'lsp_definition',
      definition_path: 'src/main.ts',
      definition_line: 1,
      definition_character: 0,
    });
  });

  it('should expose resolution_method on inheritance edges', () => {
    const db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    const baseId = insertSymbol(db, fileId, 'Base', 'class');
    const derivedId = insertSymbol(db, fileId, 'Derived', 'class');
    db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method, definition_path, definition_line, definition_character)
       VALUES (?, ?, ?, 'Base', 'extends', 10, 5, 'lsp_definition', 'src/main.ts', 1, 0)`,
    ).run(fileId, derivedId, baseId);

    const result = handler(db, { kind: 'inheritance', branch: 'main' });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      line: 11,
      character: 6,
      resolution_method: 'lsp_definition',
      definition_path: 'src/main.ts',
      definition_line: 1,
      definition_character: 0,
    });
  });
});

// ─── depth parameter (transitive traversal) ──────────────────────────────────

describe('graph handler – depth parameter', () => {
  let db: Database.Database;
  let aId: number;
  let bId: number;
  let cId: number;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    aId = insertSymbol(db, fileId, 'a');
    bId = insertSymbol(db, fileId, 'b');
    cId = insertSymbol(db, fileId, 'c');
    const dId = insertSymbol(db, fileId, 'd');
    // a → b → c → d
    insertCallEdge(db, aId, bId, 'b');
    insertCallEdge(db, bId, cId, 'c');
    insertCallEdge(db, cId, dId, 'd');
  });

  it('should return only direct edges at depth=1 (default)', () => {
    const result = handler(db, { kind: 'call', source_id: aId });
    expect(result.edges.length).toBe(1);
    expect(result.depth_used).toBe(1);
  });

  it('should return 2-hop transitive edges at depth=2', () => {
    const result = handler(db, { kind: 'call', source_id: aId, depth: 2 });
    expect(result.edges.length).toBe(2);
    expect(result.depth_used).toBe(2);
    const names = (result.edges as GraphEdge[]).map((e) => e.target_name);
    expect(names).toContain('b');
    expect(names).toContain('c');
  });

  it('should return full chain at depth=3', () => {
    const result = handler(db, { kind: 'call', source_id: aId, depth: 3 });
    expect(result.edges.length).toBe(3);
    const names = (result.edges as GraphEdge[]).map((e) => e.target_name);
    expect(names).toContain('b');
    expect(names).toContain('c');
    expect(names).toContain('d');
  });

  it('should clamp depth to max 5', () => {
    const result = handler(db, { kind: 'call', source_id: aId, depth: 100 });
    expect(result.depth_used).toBe(5);
  });

  it('should clamp depth to min 1', () => {
    const result = handler(db, { kind: 'call', source_id: aId, depth: 0 });
    expect(result.depth_used).toBe(1);
  });

  it('should not duplicate edges in cyclic graphs', () => {
    // Add cycle: d → a
    const allEdges = handler(db, { kind: 'call' }).edges as GraphEdge[];
    const dId = allEdges.find((e) => e.target_name === 'd')?.target_id;
    insertCallEdge(db, dId!, aId, 'a');
    const result = handler(db, { kind: 'call', source_id: aId, depth: 5 });
    // a→b, b→c, c→d, d→a = 4 unique edges
    expect(result.edges.length).toBe(4);
  });

  it('should work for inbound traversal (target_id with depth)', () => {
    // Find all transitive callers of d
    const allEdges = handler(db, { kind: 'call' }).edges as GraphEdge[];
    const dId = allEdges.find((e) => e.target_name === 'd')?.target_id!;
    const result = handler(db, { kind: 'call', target_id: dId, depth: 3 });
    expect(result.edges.length).toBe(3);
    const callerNames = (result.edges as GraphEdge[]).map((e) => e.source_name);
    expect(callerNames).toContain('c');
    expect(callerNames).toContain('b');
    expect(callerNames).toContain('a');
  });

  it('should respect limit even during multi-hop traversal', () => {
    const result = handler(db, { kind: 'call', source_id: aId, depth: 5, limit: 2 });
    expect(result.edges.length).toBeLessThanOrEqual(2);
  });
});

// ─── compact parameter ────────────────────────────────────────────────────────

describe('graph handler – compact mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    const callerId = insertSymbol(db, fileId, 'caller');
    const calleeId = insertSymbol(db, fileId, 'callee');
    insertCallEdge(db, callerId, calleeId, 'callee', 5, 10, 'lsp_definition');
  });

  it('should return full edge records when compact=false', () => {
    const result = handler(db, { kind: 'call', compact: false });
    const edge = result.edges[0] as GraphEdge;
    expect(edge.source_id).toBeDefined();
    expect(edge.target_id).toBeDefined();
    expect(edge.resolution_method).toBeDefined();
  });

  it('should omit provenance fields but keep IDs when compact=true', () => {
    const result = handler(db, { kind: 'call', compact: true });
    const edge = result.edges[0] as CompactGraphEdge;
    expect(edge.source_name).toBe('caller');
    expect(edge.target_name).toBe('callee');
    expect(edge.source_branch).toBe('main');
    // IDs should be preserved for follow-up queries
    expect(edge.source_id).toBeDefined();
    expect(edge.target_id).toBeDefined();
    // Provenance fields should be stripped
    expect((edge as any).resolution_method).toBeUndefined();
    expect((edge as any).line).toBeUndefined();
    expect((edge as any).character).toBeUndefined();
    expect((edge as any).definition_path).toBeUndefined();
    expect((edge as any).definition_line).toBeUndefined();
    expect((edge as any).definition_character).toBeUndefined();
  });

  it('should default compact to false', () => {
    const result = handler(db, { kind: 'call' });
    const edge = result.edges[0] as GraphEdge;
    expect(edge.source_id).toBeDefined();
  });
});

// ─── toolDef new parameters ───────────────────────────────────────────────────

describe('lore_graph toolDef – new parameters', () => {
  it('should expose depth parameter with min/max constraints', () => {
    const depth = toolDef.inputSchema.properties.depth;
    expect(depth.type).toBe('number');
    expect(depth.minimum).toBe(1);
    expect(depth.maximum).toBe(5);
  });

  it('should expose compact parameter', () => {
    const c = toolDef.inputSchema.properties.compact;
    expect(c.type).toBe('boolean');
  });
});
