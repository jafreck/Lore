import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  handler,
  toolDef,
  type DependentsArgs,
  type DependentsResult,
  type DependentsErrorResult,
} from '../../../src/server/tools/dependents.js';
import { openDb } from '../../../src/db/schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string, branch = 'main'): number {
  const result = db
    .prepare("INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, ?, 'typescript', 0, NULL, '')")
    .run(path, branch);
  return result.lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, fileId: number, name: string, kind = 'function'): number {
  const result = db
    .prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)')
    .run(fileId, name, kind);
  return result.lastInsertRowid as number;
}

function insertCallEdge(
  db: Database.Database,
  callerId: number,
  calleeId: number | null,
  calleeName: string,
  line = 0,
): void {
  db.prepare(
    "INSERT INTO symbol_refs (caller_id, callee_id, callee_name, call_line, resolution_method) VALUES (?, ?, ?, ?, 'resolved')",
  ).run(callerId, calleeId, calleeName, line);
}

function insertImportEdge(db: Database.Database, fileId: number, rawImport: string, resolvedId: number | null): void {
  db.prepare('INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)').run(
    fileId,
    rawImport,
    resolvedId,
  );
}

function insertInheritanceEdge(
  db: Database.Database,
  fileId: number,
  sourceSymbolId: number,
  targetSymbolId: number | null,
  targetSymbolName: string,
  type: 'extends' | 'implements' = 'extends',
): void {
  db.prepare(
    'INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line) VALUES (?, ?, ?, ?, ?, 1)',
  ).run(fileId, sourceSymbolId, targetSymbolId, targetSymbolName, type);
}

function insertTypeRef(
  db: Database.Database,
  fileId: number,
  symbolId: number | null,
  typeId: number | null,
  typeName: string,
): void {
  db.prepare(
    "INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line) VALUES (?, ?, ?, ?, ?, 'type_annotation', 1)",
  ).run(fileId, symbolId, typeId, typeName, typeName);
}

function isSuccess(result: DependentsResult | DependentsErrorResult): result is DependentsResult {
  return !('error' in result);
}

function asObject(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function isError(result: DependentsResult | DependentsErrorResult): result is DependentsErrorResult {
  return 'error' in result;
}

// ─── toolDef ──────────────────────────────────────────────────────────────────

describe('lore_dependents toolDef', () => {
  it('should have correct name and required fields', () => {
    expect(toolDef.name).toBe('lore_dependents');
    expect(toolDef.inputSchema.required).toEqual(['query', 'kind']);
  });

  it('should expose kind enum with symbol and file', () => {
    expect(toolDef.inputSchema.properties.kind.enum).toEqual(['symbol', 'file']);
  });

  it('should not expose a depth parameter', () => {
    expect(toolDef.inputSchema.properties).not.toHaveProperty('depth');
  });
});

// ─── Symbol dependents ───────────────────────────────────────────────────────

describe('dependents handler – kind=symbol', () => {
  let db: Database.Database;
  let targetSymbolId: number;

  beforeEach(() => {
    db = createTestDb();
    // Set up: src/db.ts has openDb; src/main.ts has runApp which calls openDb
    const dbFileId = insertFile(db, 'src/db.ts');
    const mainFileId = insertFile(db, 'src/main.ts');
    const utilFileId = insertFile(db, 'src/util.ts');

    targetSymbolId = insertSymbol(db, dbFileId, 'openDb');
    const runAppId = insertSymbol(db, mainFileId, 'runApp');
    const helperSymId = insertSymbol(db, utilFileId, 'helper');

    // runApp calls openDb
    insertCallEdge(db, runAppId, targetSymbolId, 'openDb', 5);
    // helper calls openDb
    insertCallEdge(db, helperSymId, targetSymbolId, 'openDb', 3);

    // main.ts imports db.ts
    insertImportEdge(db, mainFileId, './db', dbFileId);
    // util.ts imports db.ts
    insertImportEdge(db, utilFileId, './db', dbFileId);
  });

  it('should return callers of a symbol', () => {
    const result = handler(db, { query: 'openDb', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.target.name).toBe('openDb');
    expect(result.target.kind).toBe('function');
    expect(result.dependents.callers.length).toBe(2);
  });

  it('should return importers of the file containing the symbol', () => {
    const result = handler(db, { query: 'openDb', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.importers.length).toBe(2);
  });

  it('should set total_count accurately', () => {
    const result = handler(db, { query: 'openDb', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    const total =
      result.dependents.callers.length +
      result.dependents.importers.length +
      result.dependents.subclasses.length +
      result.dependents.type_references.length;
    expect(result.total_count).toBe(total);
  });

  it('should return error when symbol not found', () => {
    const result = handler(db, { query: 'nonExistent', kind: 'symbol' });
    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.error).toContain('No symbol found');
  });

  it('should omit provenance fields in compact mode', () => {
    const result = handler(db, { query: 'openDb', kind: 'symbol', compact: true });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    const caller = asObject(result.dependents.callers[0]);
    expect(caller).not.toHaveProperty('line');
    expect(caller).not.toHaveProperty('character');
    expect(caller).not.toHaveProperty('resolution_method');
    // But name/id fields are preserved
    expect(caller).toHaveProperty('caller_id');
    expect(caller).toHaveProperty('caller_name');
  });

  it('should include provenance fields when compact is false', () => {
    const result = handler(db, { query: 'openDb', kind: 'symbol', compact: false });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    const caller = asObject(result.dependents.callers[0]);
    expect(caller).toHaveProperty('line');
    expect(caller).toHaveProperty('resolution_method');
  });

  it('should set depth_used to 5 (always transitive)', () => {
    const result = handler(db, { query: 'openDb', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;
    expect(result.depth_used).toBe(5);
  });
});

// ─── Symbol: subclasses & type references ────────────────────────────────────

describe('dependents handler – symbol subclasses and type refs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const baseFileId = insertFile(db, 'src/base.ts');
    const childFileId = insertFile(db, 'src/child.ts');
    const consumerFileId = insertFile(db, 'src/consumer.ts');

    const baseClassId = insertSymbol(db, baseFileId, 'BaseService', 'class');
    const childClassId = insertSymbol(db, childFileId, 'ChildService', 'class');
    const consumerId = insertSymbol(db, consumerFileId, 'consume', 'function');

    // ChildService extends BaseService
    insertInheritanceEdge(db, childFileId, childClassId, baseClassId, 'BaseService');

    // consume references BaseService as a type
    insertTypeRef(db, consumerFileId, consumerId, baseClassId, 'BaseService');
  });

  it('should return subclasses of a class', () => {
    const result = handler(db, { query: 'BaseService', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.subclasses.length).toBe(1);
    const sub = asObject(result.dependents.subclasses[0]);
    expect(sub.symbol_name).toBe('ChildService');
    expect(sub.relationship_type).toBe('extends');
  });

  it('should return type references to a symbol', () => {
    const result = handler(db, { query: 'BaseService', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.type_references.length).toBe(1);
    const ref = asObject(result.dependents.type_references[0]);
    expect(ref.symbol_name).toBe('consume');
  });
});

// ─── File dependents ─────────────────────────────────────────────────────────

describe('dependents handler – kind=file', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const targetFileId = insertFile(db, 'src/db.ts');
    const importerFileId = insertFile(db, 'src/main.ts');
    const anotherFileId = insertFile(db, 'src/util.ts');

    // src/main.ts imports src/db.ts
    insertImportEdge(db, importerFileId, './db', targetFileId);
    // src/util.ts imports src/db.ts
    insertImportEdge(db, anotherFileId, './db', targetFileId);

    // Symbol in db.ts called by symbol in util.ts
    const openDbId = insertSymbol(db, targetFileId, 'openDb');
    const helperSymId = insertSymbol(db, anotherFileId, 'helper');
    insertCallEdge(db, helperSymId, openDbId, 'openDb', 2);
  });

  it('should return files that import this file', () => {
    const result = handler(db, { query: 'src/db.ts', kind: 'file' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.target.kind).toBe('file');
    expect(result.target.name).toBe('src/db.ts');
    expect(result.dependents.importers.length).toBe(2);
  });

  it('should return callers from other files that call symbols in this file', () => {
    const result = handler(db, { query: 'src/db.ts', kind: 'file' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    // Only the cross-file caller (helper from util.ts), not intra-file calls
    expect(result.dependents.callers.length).toBe(1);
    const caller = asObject(result.dependents.callers[0]);
    expect(caller.caller_name).toBe('helper');
    expect(caller.caller_file).toBe('src/util.ts');
  });

  it('should return error when file not found', () => {
    const result = handler(db, { query: 'src/nonexistent.ts', kind: 'file' });
    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.error).toContain('No file found');
  });

  it('should compute total_count correctly for file dependents', () => {
    const result = handler(db, { query: 'src/db.ts', kind: 'file' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.total_count).toBe(
      result.dependents.callers.length +
      result.dependents.importers.length +
      result.dependents.subclasses.length +
      result.dependents.type_references.length,
    );
  });

  it('should support compact mode for file dependents', () => {
    const result = handler(db, { query: 'src/db.ts', kind: 'file', compact: true });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    const importer = asObject(result.dependents.importers[0]);
    expect(importer).toHaveProperty('file_id');
    expect(importer).toHaveProperty('file_path');
    expect(importer).not.toHaveProperty('raw_import');
  });
});

// ─── File dependents with subclasses and type_refs ─────────────────────────

describe('dependents handler – kind=file with subclasses and type_refs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Target file has a class
    const targetFileId = insertFile(db, 'src/base.ts');
    const childFileId = insertFile(db, 'src/child.ts');
    const userFileId = insertFile(db, 'src/user.ts');

    const baseClass = insertSymbol(db, targetFileId, 'Base', 'class');
    const childClass = insertSymbol(db, childFileId, 'Child', 'class');
    const userFn = insertSymbol(db, userFileId, 'useBase', 'function');

    // Child extends Base (subclass of symbol in target file)
    insertInheritanceEdge(db, childFileId, childClass, baseClass, 'Base');
    // useBase references Base as a type
    insertTypeRef(db, userFileId, userFn, baseClass, 'Base');
  });

  it('should return subclasses in file-kind query', () => {
    const result = handler(db, { query: 'src/base.ts', kind: 'file' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.subclasses.length).toBe(1);
    expect(asObject(result.dependents.subclasses[0]).symbol_name).toBe('Child');
  });

  it('should return type_references in file-kind query', () => {
    const result = handler(db, { query: 'src/base.ts', kind: 'file' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.type_references.length).toBe(1);
    expect(asObject(result.dependents.type_references[0]).symbol_name).toBe('useBase');
  });

  it('should compact subclasses and type_references in file-kind query', () => {
    const result = handler(db, { query: 'src/base.ts', kind: 'file', compact: true });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.subclasses.length).toBe(1);
    const sub = asObject(result.dependents.subclasses[0]);
    expect(sub).toHaveProperty('symbol_name');
    expect(sub).not.toHaveProperty('line');

    expect(result.dependents.type_references.length).toBe(1);
    const tref = asObject(result.dependents.type_references[0]);
    expect(tref).toHaveProperty('symbol_name');
    expect(tref).not.toHaveProperty('line');
  });
});

// ─── Transitive (multi-hop) dependents ────────────────────────────────────────

describe('dependents handler – transitive closure', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Chain: A calls B calls C — querying C with depth=2 should reach A
    const fileId = insertFile(db, 'src/chain.ts');
    const symA = insertSymbol(db, fileId, 'funcA');
    const symB = insertSymbol(db, fileId, 'funcB');
    const symC = insertSymbol(db, fileId, 'funcC');
    insertCallEdge(db, symA, symB, 'funcB');
    insertCallEdge(db, symB, symC, 'funcC');
  });

  it('should return both direct and transitive callers by default', () => {
    const result = handler(db, { query: 'funcC', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.callers.length).toBe(2);
    const callerNames = result.dependents.callers.map(
      (c) => asObject(c).caller_name,
    );
    expect(callerNames).toContain('funcA');
    expect(callerNames).toContain('funcB');
  });
});

// ─── Transitive importer expansion ───────────────────────────────────────────

describe('dependents handler – transitive import chain', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Chain: file3 imports file2 imports file1
    const file1Id = insertFile(db, 'src/lib.ts');
    const file2Id = insertFile(db, 'src/mid.ts');
    const file3Id = insertFile(db, 'src/app.ts');
    insertImportEdge(db, file2Id, './lib', file1Id);
    insertImportEdge(db, file3Id, './mid', file2Id);
  });

  it('file query should return transitive importers by default', () => {
    const result = handler(db, { query: 'src/lib.ts', kind: 'file' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.importers.length).toBe(2);
    const paths = result.dependents.importers.map((i) => asObject(i).file_path);
    expect(paths).toContain('src/mid.ts');
    expect(paths).toContain('src/app.ts');
  });
});

// ─── Branch filtering ─────────────────────────────────────────────────────────

describe('dependents handler – branch filtering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainFileId = insertFile(db, 'src/db.ts', 'main');
    const featFileId = insertFile(db, 'src/main.ts', 'main');
    const devFileId = insertFile(db, 'src/main.ts', 'dev');

    const targetSym = insertSymbol(db, mainFileId, 'openDb');
    const mainCaller = insertSymbol(db, featFileId, 'mainCaller');
    const devCaller = insertSymbol(db, devFileId, 'devCaller');

    insertCallEdge(db, mainCaller, targetSym, 'openDb');
    insertCallEdge(db, devCaller, targetSym, 'openDb');
  });

  it('should filter callers by branch', () => {
    const result = handler(db, { query: 'openDb', kind: 'symbol', branch: 'main' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.callers.length).toBe(1);
    expect(asObject(result.dependents.callers[0]).caller_name).toBe('mainCaller');
  });
});

// ─── Ambiguous symbol ─────────────────────────────────────────────────────────

describe('dependents handler – ambiguous symbol', () => {
  it('should return disambiguation error when too many matches', () => {
    const db = createTestDb();
    // Insert many symbols with the same name in different files
    for (let i = 0; i < 7; i++) {
      const fid = insertFile(db, `src/mod${i}.ts`);
      insertSymbol(db, fid, 'init');
    }

    const result = handler(db, { query: 'init', kind: 'symbol' });
    expect(isError(result)).toBe(true);
    if (!isError(result)) return;
    expect(result.error).toContain('Ambiguous');
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThan(0);
  });

  it('should return disambiguation error for a few matching symbols (≤5)', () => {
    const db = createTestDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const s1 = insertSymbol(db, f1, 'run');
    const s2 = insertSymbol(db, f2, 'run');

    // One caller each
    const caller1 = insertSymbol(db, f1, 'callerA');
    const caller2 = insertSymbol(db, f2, 'callerB');
    insertCallEdge(db, caller1, s1, 'run');
    insertCallEdge(db, caller2, s2, 'run');

    const result = handler(db, { query: 'run', kind: 'symbol' });
    expect(isError(result)).toBe(true);
    if (!isError(result)) return;

    // Should report ambiguity with both candidates
    expect(result.error).toContain('Ambiguous');
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBe(2);
  });
});

// ─── Empty dependents ─────────────────────────────────────────────────────────

describe('dependents handler – empty dependents', () => {
  it('should return all-empty arrays when a symbol has no dependents', () => {
    const db = createTestDb();
    const fid = insertFile(db, 'src/lonely.ts');
    insertSymbol(db, fid, 'isolated');

    const result = handler(db, { query: 'isolated', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.callers).toEqual([]);
    expect(result.dependents.importers).toEqual([]);
    expect(result.dependents.subclasses).toEqual([]);
    expect(result.dependents.type_references).toEqual([]);
    expect(result.total_count).toBe(0);
  });
});

// ─── Subclass dependents ──────────────────────────────────────────────────────

describe('dependents handler – subclass queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const baseFileId = insertFile(db, 'src/base.ts');
    const childFileId = insertFile(db, 'src/child.ts');

    const baseClass = insertSymbol(db, baseFileId, 'BaseService', 'class');
    const childClass = insertSymbol(db, childFileId, 'ChildService', 'class');

    // ChildService extends BaseService
    insertInheritanceEdge(db, childFileId, childClass, baseClass, 'BaseService', 'extends');
  });

  it('should return subclass dependents for a symbol', () => {
    const result = handler(db, { query: 'BaseService', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.subclasses.length).toBe(1);
    const sub = asObject(result.dependents.subclasses[0]);
    expect(sub.symbol_name).toBe('ChildService');
    expect(sub.relationship_type).toBe('extends');
  });

  it('should omit provenance fields in compact subclass output', () => {
    const result = handler(db, { query: 'BaseService', kind: 'symbol', compact: true });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.subclasses.length).toBe(1);
    const sub = asObject(result.dependents.subclasses[0]);
    expect(sub).toHaveProperty('symbol_name');
    expect(sub).toHaveProperty('relationship_type');
    // compact mode should not include resolution fields like line/character
    expect(sub).not.toHaveProperty('line');
  });
});

// ─── Type reference dependents ────────────────────────────────────────────────

describe('dependents handler – type reference queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const typeFileId = insertFile(db, 'src/types.ts');
    const userFileId = insertFile(db, 'src/user.ts');

    const configType = insertSymbol(db, typeFileId, 'Config', 'type');
    const userSym = insertSymbol(db, userFileId, 'loadConfig', 'function');

    // loadConfig uses Config as a type reference
    insertTypeRef(db, userFileId, userSym, configType, 'Config');
  });

  it('should return type reference dependents for a symbol', () => {
    const result = handler(db, { query: 'Config', kind: 'symbol' });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.type_references.length).toBe(1);
    const ref = asObject(result.dependents.type_references[0]);
    expect(ref.symbol_name).toBe('loadConfig');
  });

  it('should omit provenance fields in compact type reference output', () => {
    const result = handler(db, { query: 'Config', kind: 'symbol', compact: true });
    expect(isSuccess(result)).toBe(true);
    if (!isSuccess(result)) return;

    expect(result.dependents.type_references.length).toBe(1);
    const ref = asObject(result.dependents.type_references[0]);
    expect(ref).toHaveProperty('symbol_name');
    expect(ref).toHaveProperty('ref_kind');
    // compact mode should not include line/character
    expect(ref).not.toHaveProperty('line');
  });
});
