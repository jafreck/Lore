import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef, type GraphArgs, type GraphEdge } from '../../../src/kb-server/tools/graph.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
      callee_name TEXT    NOT NULL
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

// ─── handler (kind=call) ──────────────────────────────────────────────────────

describe('kb_graph toolDef', () => {
  it('should expose kind enum values for call, import, module, and inheritance', () => {
    expect(toolDef.inputSchema.properties.kind.enum).toEqual([
      'call',
      'import',
      'module',
      'inheritance',
    ]);
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
    insertCallEdge(db, mainSymbolId, null, 'callee');
    insertCallEdge(db, featSymbolId, null, 'featCallee');
  });

  it('should return all call edges when no filter', () => {
    const result = handler(db, { kind: 'call' });
    expect(result.edges.length).toBe(2);
  });

  it('should include source_branch on each edge', () => {
    const result = handler(db, { kind: 'call' });
    result.edges.forEach((e) => expect(typeof e.source_branch).toBe('string'));
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
