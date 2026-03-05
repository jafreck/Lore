import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef } from '../../../src/lore-server/tools/architecture.js';

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
    CREATE TABLE external_deps (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      package  TEXT    NOT NULL
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
  `);
  return db;
}

function createTestDbWithoutDocs(): Database.Database {
  const db = createTestDb();
  db.exec('DROP TABLE docs');
  return db;
}

function insertFile(db: Database.Database, path: string, branch: string): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, 'typescript');
  return result.lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, fileId: number, name: string): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    )
    .run(fileId, name, 'function');
  return result.lastInsertRowid as number;
}

function insertModule(db: Database.Database, name: string): number {
  const result = db
    .prepare('INSERT INTO modules (name, kind, manifest) VALUES (?, ?, ?)')
    .run(name, 'package', null);
  return result.lastInsertRowid as number;
}

function mapFileToModule(db: Database.Database, fileId: number, moduleId: number): void {
  db.prepare('INSERT INTO file_modules (file_id, module_id) VALUES (?, ?)').run(fileId, moduleId);
}

function insertImport(db: Database.Database, fileId: number, resolvedId: number | null): void {
  db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(
    fileId,
    './x',
    resolvedId,
  );
}

function insertExternalDep(db: Database.Database, fileId: number, pkg: string): void {
  db.prepare('INSERT INTO external_deps (file_id, package) VALUES (?, ?)').run(fileId, pkg);
}

function insertDoc(
  db: Database.Database,
  path: string,
  branch: string,
  kind: string,
  title: string,
): void {
  db.prepare(
    `INSERT INTO docs (path, branch, kind, title, content, content_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(path, branch, kind, title, `${title} content`, `${path}:${branch}`, Date.now());
}

describe('lore_architecture toolDef', () => {
  it('should expose optional depth and branch properties', () => {
    expect(toolDef.name).toBe('lore_architecture');
    expect(toolDef.inputSchema.required).toEqual([]);
    expect(toolDef.inputSchema.properties.depth.type).toBe('number');
    expect(toolDef.inputSchema.properties.branch.type).toBe('string');
  });
});

describe('architecture handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();

    const appModuleId = insertModule(db, 'app');
    const coreModuleId = insertModule(db, 'core');
    const cliModuleId = insertModule(db, 'cli');
    const featModuleId = insertModule(db, 'feat');

    const mainAppFileId = insertFile(db, 'src/app/main.ts', 'main');
    const mainUtilsFileId = insertFile(db, 'src/app/utils.ts', 'main');
    const mainLibFileId = insertFile(db, 'src/lib/helper.ts', 'main');
    const mainCliFileId = insertFile(db, 'src/cli/index.ts', 'main');
    const featAppFileId = insertFile(db, 'src/app/main.ts', 'feat');
    const featExtraFileId = insertFile(db, 'src/feat/extra.ts', 'feat');

    insertSymbol(db, mainAppFileId, 'renderApp');
    insertSymbol(db, mainAppFileId, 'mountApp');
    insertSymbol(db, mainUtilsFileId, 'format');
    insertSymbol(db, mainLibFileId, 'helper');
    insertSymbol(db, featAppFileId, 'renderFeat');

    mapFileToModule(db, mainAppFileId, appModuleId);
    mapFileToModule(db, mainUtilsFileId, appModuleId);
    mapFileToModule(db, mainLibFileId, coreModuleId);
    mapFileToModule(db, mainCliFileId, cliModuleId);
    mapFileToModule(db, featAppFileId, appModuleId);
    mapFileToModule(db, featExtraFileId, featModuleId);

    insertImport(db, mainAppFileId, mainUtilsFileId);
    insertImport(db, mainAppFileId, mainLibFileId);
    insertImport(db, mainUtilsFileId, mainLibFileId);
    insertImport(db, mainCliFileId, mainAppFileId);
    insertImport(db, featAppFileId, featExtraFileId);
    insertImport(db, featAppFileId, mainAppFileId);

    insertExternalDep(db, mainAppFileId, 'react');
    insertExternalDep(db, mainUtilsFileId, 'react');
    insertExternalDep(db, mainLibFileId, 'lodash');
    insertExternalDep(db, mainCliFileId, 'commander');
    insertExternalDep(db, featAppFileId, 'react');
    insertExternalDep(db, featExtraFileId, 'lodash');

    insertDoc(db, 'src/app/README.md', 'main', 'readme', 'App README');
    insertDoc(db, 'src/lib/design.md', 'main', 'design', 'Library Design');
    insertDoc(db, 'src/app/README.md', 'feat', 'readme', 'Feature App README');
  });

  it('should return all top-level architecture sections', () => {
    const result = handler(db, {});
    expect(result).toHaveProperty('components');
    expect(result).toHaveProperty('edges');
    expect(result).toHaveProperty('entry_points');
    expect(result).toHaveProperty('leaf_nodes');
    expect(result).toHaveProperty('external_deps');
  });

  it('should aggregate component, edge, node, and dependency data', () => {
    const result = handler(db, {});

    expect(result.components).toHaveLength(5);
    expect(result.edges).toHaveLength(4);
    expect(result.entry_points).toEqual(
      expect.arrayContaining([
        { branch: 'main', component: 'src/cli' },
        { branch: 'feat', component: 'src/app' },
      ]),
    );
    expect(result.leaf_nodes).toEqual(
      expect.arrayContaining([
        { branch: 'main', component: 'src/lib' },
        { branch: 'feat', component: 'src/feat' },
      ]),
    );

    const mainApp = result.components.find((c) => c.branch === 'main' && c.component === 'src/app');
    expect(mainApp).toBeDefined();
    expect(mainApp?.file_count).toBe(2);
    expect(mainApp?.symbol_count).toBe(3);
    expect(mainApp?.module_count).toBe(2);
    expect(mainApp?.docs_context).toEqual([
      expect.objectContaining({
        path: 'src/app/README.md',
        kind: 'readme',
        title: 'App README',
      }),
    ]);

    const appToLib = result.edges.find(
      (e) =>
        e.branch === 'main' &&
        e.source_component === 'src/app' &&
        e.target_component === 'src/lib',
    );
    expect(appToLib?.edge_count).toBe(2);

    const mainAppReact = result.external_deps.find(
      (d) => d.branch === 'main' && d.component === 'src/app' && d.package === 'react',
    );
    expect(mainAppReact?.file_count).toBe(2);

    const featApp = result.components.find((c) => c.branch === 'feat' && c.component === 'src/app');
    expect(featApp?.docs_context).toEqual([
      expect.objectContaining({
        path: 'src/app/README.md',
        kind: 'readme',
        title: 'Feature App README',
      }),
    ]);
  });

  it('should filter output by branch when branch is provided', () => {
    const result = handler(db, { branch: 'main' });
    expect(result.components.every((c) => c.branch === 'main')).toBe(true);
    expect(result.edges.every((e) => e.branch === 'main')).toBe(true);
    expect(result.entry_points.every((n) => n.branch === 'main')).toBe(true);
    expect(result.leaf_nodes.every((n) => n.branch === 'main')).toBe(true);
    expect(result.external_deps.every((d) => d.branch === 'main')).toBe(true);
    expect(result.components.every((c) => c.docs_context.every((doc) => doc.path.startsWith(c.component)))).toBe(true);
    expect(result.components).toHaveLength(3);
    expect(result.edges).toHaveLength(3);
  });

  it('should group paths at depth 1 and clamp invalid depth values', () => {
    const depthOne = handler(db, { depth: 1 });
    expect(depthOne.components).toHaveLength(2);
    expect(depthOne.components.map((c) => c.component)).toEqual(['src', 'src']);
    expect(depthOne.edges).toHaveLength(2);
    depthOne.components.forEach((component) => {
      expect(component.docs_context.length).toBeGreaterThanOrEqual(1);
      expect(component.docs_context.every((doc) => doc.path.startsWith('src/'))).toBe(true);
    });

    const clamped = handler(db, { depth: 0.2 });
    expect(clamped.components.map((c) => c.component)).toEqual(['src', 'src']);
  });

  it('should keep docs context empty when docs table is unavailable', () => {
    const dbNoDocs = createTestDbWithoutDocs();
    const moduleId = insertModule(dbNoDocs, 'app');
    const sourceId = insertFile(dbNoDocs, 'src/app/main.ts', 'main');
    const depId = insertFile(dbNoDocs, 'src/lib/helper.ts', 'main');

    insertSymbol(dbNoDocs, sourceId, 'run');
    mapFileToModule(dbNoDocs, sourceId, moduleId);
    insertImport(dbNoDocs, sourceId, depId);
    insertExternalDep(dbNoDocs, sourceId, 'react');

    const result = handler(dbNoDocs, {});
    expect(result.components).toHaveLength(2);
    expect(result.components.every((component) => component.docs_context.length === 0)).toBe(true);
  });
});
