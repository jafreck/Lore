import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/dependents.js';

function seedDependentsData(db: Database.Database) {
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/core.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/consumer.ts', 'main', 'typescript', '')`).run();
  db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/other.ts', 'main', 'typescript', '')`).run();

  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'coreFunc', 'function', 1, 5)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'consumerFunc', 'function', 1, 5)`).run();
  db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'otherFunc', 'function', 1, 3)`).run();

  // consumerFunc calls coreFunc
  db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (2, 2, 1, 'coreFunc', 2, 'resolved')`).run();

  // consumer.ts imports core.ts
  db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (2, './core', 1)`).run();
}

describe('lore_dependents toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_dependents');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.required).toContain('query');
    expect(toolDef.inputSchema.required).toContain('kind');
  });
});

describe('lore_dependents handler — symbol', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDependentsData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finds callers of a symbol', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(result.target.name).toBe('coreFunc');
    expect(result.dependents.callers.length).toBeGreaterThanOrEqual(1);
  });

  it('returns importers for a symbol', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    // Should find importers of the file containing coreFunc
    expect(result.dependents.importers.length).toBeGreaterThanOrEqual(1);
  });

  it('returns total_count', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(result.total_count).toBeGreaterThanOrEqual(1);
  });

  it('supports compact mode', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol', compact: true });
    expect(result.dependents.callers.length).toBeGreaterThanOrEqual(1);
    const caller = result.dependents.callers[0] as any;
    // compact callers omit line, character, resolution_method
    expect(caller.line).toBeUndefined();
  });

  it('throws for unknown symbol', () => {
    expect(() => handler(db, { query: 'nonExistent', kind: 'symbol' })).toThrow(/No symbol found/);
  });

  it('returns depth_used', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(result.depth_used).toBeDefined();
    expect(typeof result.depth_used).toBe('number');
  });

  it('returns truncated flag', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol' });
    expect(typeof result.truncated).toBe('boolean');
  });
});

describe('lore_dependents handler — file', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedDependentsData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finds importers of a file', () => {
    const result = handler(db, { query: 'src/core.ts', kind: 'file' });
    expect(result.target.name).toBe('src/core.ts');
    expect(result.target.kind).toBe('file');
    expect(result.dependents.importers.length).toBeGreaterThanOrEqual(1);
  });

  it('finds callers from other files', () => {
    const result = handler(db, { query: 'src/core.ts', kind: 'file' });
    expect(result.dependents.callers.length).toBeGreaterThanOrEqual(1);
  });

  it('throws for unknown file', () => {
    expect(() => handler(db, { query: 'not/a/real/path.ts', kind: 'file' })).toThrow(/No file found/);
  });
});

describe('lore_dependents handler — ambiguous symbol', () => {
  it('throws for ambiguous symbol name', () => {
    const db = openDb(':memory:');
    try {
      db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'a.ts', 'main', 'typescript', '')`).run();
      db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'b.ts', 'main', 'typescript', '')`).run();
      db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'dup', 'function', 1, 1)`).run();
      db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'dup', 'function', 1, 1)`).run();
      expect(() => handler(db, { query: 'dup', kind: 'symbol' })).toThrow(/Ambiguous/);
    } finally {
      db.close();
    }
  });
});

// ─── Subclasses (symbol_relationships) ────────────────────────────────────────

describe('lore_dependents handler — subclasses', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    // Base class in core.ts
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/core.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/child.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/impl.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (4, 'src/grandchild.ts', 'main', 'typescript', '')`).run();

    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'BaseClass', 'class', 1, 10)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'ChildClass', 'class', 1, 10)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'ImplClass', 'class', 1, 10)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (4, 4, 'GrandChild', 'class', 1, 10)`).run();

    // ChildClass extends BaseClass
    db.prepare(`INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method) VALUES (2, 2, 1, 'BaseClass', 'extends', 1, 0, 'resolved')`).run();
    // ImplClass implements BaseClass
    db.prepare(`INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method) VALUES (3, 3, 1, 'BaseClass', 'implements', 1, 0, 'resolved')`).run();
    // GrandChild extends ChildClass (transitive)
    db.prepare(`INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method) VALUES (4, 4, 2, 'ChildClass', 'extends', 1, 0, 'resolved')`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('finds direct extends subclasses', () => {
    const result = handler(db, { query: 'BaseClass', kind: 'symbol' });
    const names = result.dependents.subclasses.map((s: any) => s.symbol_name);
    expect(names).toContain('ChildClass');
  });

  it('finds implements subclasses', () => {
    const result = handler(db, { query: 'BaseClass', kind: 'symbol' });
    const names = result.dependents.subclasses.map((s: any) => s.symbol_name);
    expect(names).toContain('ImplClass');
  });

  it('finds transitive subclasses (grandchild)', () => {
    const result = handler(db, { query: 'BaseClass', kind: 'symbol' });
    const names = result.dependents.subclasses.map((s: any) => s.symbol_name);
    expect(names).toContain('GrandChild');
  });

  it('includes line/character in full mode', () => {
    const result = handler(db, { query: 'BaseClass', kind: 'symbol' });
    const sub = result.dependents.subclasses[0] as any;
    expect(sub.line).toBeDefined();
    expect(sub.resolution_method).toBeDefined();
  });

  it('compact mode omits line/character/resolution_method', () => {
    const result = handler(db, { query: 'BaseClass', kind: 'symbol', compact: true });
    expect(result.dependents.subclasses.length).toBeGreaterThanOrEqual(2);
    const sub = result.dependents.subclasses[0] as any;
    expect(sub.line).toBeUndefined();
    expect(sub.character).toBeUndefined();
    expect(sub.resolution_method).toBeUndefined();
    // compact still has these fields
    expect(sub.symbol_id).toBeDefined();
    expect(sub.symbol_name).toBeDefined();
    expect(sub.relationship_type).toBeDefined();
  });

  it('counts subclasses in total_count', () => {
    const result = handler(db, { query: 'BaseClass', kind: 'symbol' });
    expect(result.total_count).toBeGreaterThanOrEqual(3); // ChildClass, ImplClass, GrandChild
  });
});

// ─── Type references (type_refs) ──────────────────────────────────────────────

describe('lore_dependents handler — type references', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/types.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/usage.ts', 'main', 'typescript', '')`).run();

    // The type being referenced
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'MyType', 'type', 1, 5)`).run();
    // The symbol that uses the type
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'useMyType', 'function', 1, 5)`).run();

    // type_ref: useMyType references MyType with resolved type_id
    db.prepare(`INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method) VALUES (2, 2, 1, 'MyType', 'MyType', 'parameter', 2, 5, 'resolved')`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('finds type references to a symbol', () => {
    const result = handler(db, { query: 'MyType', kind: 'symbol' });
    expect(result.dependents.type_references.length).toBe(1);
    const ref = result.dependents.type_references[0] as any;
    expect(ref.symbol_name).toBe('useMyType');
    expect(ref.ref_kind).toBe('parameter');
  });

  it('includes line/character in full mode', () => {
    const result = handler(db, { query: 'MyType', kind: 'symbol' });
    const ref = result.dependents.type_references[0] as any;
    expect(ref.line).toBeDefined();
    expect(ref.resolution_method).toBeDefined();
  });

  it('compact mode omits line/character/resolution_method', () => {
    const result = handler(db, { query: 'MyType', kind: 'symbol', compact: true });
    expect(result.dependents.type_references.length).toBe(1);
    const ref = result.dependents.type_references[0] as any;
    expect(ref.line).toBeUndefined();
    expect(ref.character).toBeUndefined();
    expect(ref.resolution_method).toBeUndefined();
    expect(ref.symbol_name).toBe('useMyType');
    expect(ref.ref_kind).toBe('parameter');
  });

  it('counts type references in total_count', () => {
    const result = handler(db, { query: 'MyType', kind: 'symbol' });
    expect(result.total_count).toBeGreaterThanOrEqual(1);
  });
});

// ─── Transitive caller expansion (multi-hop) ─────────────────────────────────

describe('lore_dependents handler — transitive callers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/b.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/c.ts', 'main', 'typescript', '')`).run();

    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'funcA', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'funcB', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'funcC', 'function', 1, 5)`).run();

    // funcB calls funcA (hop 1)
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (2, 2, 1, 'funcA', 2, 'resolved')`).run();
    // funcC calls funcB (hop 2)
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (3, 3, 2, 'funcB', 2, 'resolved')`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('finds transitive callers across multiple hops', () => {
    const result = handler(db, { query: 'funcA', kind: 'symbol' });
    const callerNames = result.dependents.callers.map((c: any) => c.caller_name);
    expect(callerNames).toContain('funcB');
    expect(callerNames).toContain('funcC');
  });

  it('includes both direct and transitive callers in total_count', () => {
    const result = handler(db, { query: 'funcA', kind: 'symbol' });
    expect(result.dependents.callers.length).toBe(2);
  });
});

// ─── Transitive importer expansion (multi-hop) ───────────────────────────────

describe('lore_dependents handler — transitive importers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/base.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/mid.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/top.ts', 'main', 'typescript', '')`).run();

    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'baseExport', 'function', 1, 5)`).run();

    // mid.ts imports base.ts (hop 1)
    db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (2, './base', 1)`).run();
    // top.ts imports mid.ts (hop 2)
    db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (3, './mid', 2)`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('finds transitive importers across multiple hops', () => {
    const result = handler(db, { query: 'baseExport', kind: 'symbol' });
    const importerPaths = result.dependents.importers.map((i: any) => i.file_path);
    expect(importerPaths).toContain('src/mid.ts');
    expect(importerPaths).toContain('src/top.ts');
  });
});

// ─── File-kind same-file caller filtering ─────────────────────────────────────

describe('lore_dependents handler — file same-file filtering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/mod.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/external.ts', 'main', 'typescript', '')`).run();

    // Two symbols in the same file
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'exported', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'internal', 'function', 6, 10)`).run();
    // External caller
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 2, 'externalCaller', 'function', 1, 5)`).run();

    // internal calls exported (same file — should be filtered for file-kind)
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (2, 1, 1, 'exported', 7, 'resolved')`).run();
    // externalCaller calls exported (different file — should be included)
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (3, 2, 1, 'exported', 2, 'resolved')`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('excludes same-file callers in file-kind mode', () => {
    const result = handler(db, { query: 'src/mod.ts', kind: 'file' });
    const callerNames = result.dependents.callers.map((c: any) => c.caller_name);
    expect(callerNames).toContain('externalCaller');
    expect(callerNames).not.toContain('internal');
  });

  it('includes same-file callers in symbol-kind mode', () => {
    const result = handler(db, { query: 'exported', kind: 'symbol' });
    const callerNames = result.dependents.callers.map((c: any) => c.caller_name);
    expect(callerNames).toContain('internal');
    expect(callerNames).toContain('externalCaller');
  });
});

// ─── File-kind subclasses and type refs ───────────────────────────────────────

describe('lore_dependents handler — file-kind subclasses and type refs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/base.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/derived.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/user.ts', 'main', 'typescript', '')`).run();

    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'BaseInterface', 'interface', 1, 10)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'DerivedClass', 'class', 1, 10)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'userFunc', 'function', 1, 5)`).run();

    // DerivedClass implements BaseInterface
    db.prepare(`INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method) VALUES (2, 2, 1, 'BaseInterface', 'implements', 1, 0, 'resolved')`).run();

    // userFunc has a type_ref to BaseInterface
    db.prepare(`INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method) VALUES (3, 3, 1, 'BaseInterface', 'BaseInterface', 'return_type', 2, 5, 'resolved')`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('finds subclasses via file-kind query', () => {
    const result = handler(db, { query: 'src/base.ts', kind: 'file' });
    const names = result.dependents.subclasses.map((s: any) => s.symbol_name);
    expect(names).toContain('DerivedClass');
  });

  it('finds type references via file-kind query', () => {
    const result = handler(db, { query: 'src/base.ts', kind: 'file' });
    expect(result.dependents.type_references.length).toBe(1);
    const ref = result.dependents.type_references[0] as any;
    expect(ref.symbol_name).toBe('userFunc');
    expect(ref.ref_kind).toBe('return_type');
  });
});

// ─── Branch filtering ─────────────────────────────────────────────────────────

describe('lore_dependents handler — branch filtering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    // Main branch files
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/core.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/consumer.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (5, 'src/types.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (6, 'src/child.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (7, 'src/user.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (8, 'src/mid.ts', 'main', 'typescript', '')`).run();
    // Feature branch files
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (3, 'src/core.ts', 'feature', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (4, 'src/feat-consumer.ts', 'feature', 'typescript', '')`).run();

    // Main branch symbols
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'coreFunc', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'consumerFunc', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (5, 5, 'BaseType', 'class', 1, 10)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (6, 6, 'ChildType', 'class', 1, 10)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (7, 7, 'userFunc', 'function', 1, 5)`).run();
    // Feature branch symbols
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (3, 3, 'coreFunc', 'function', 1, 5)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (4, 4, 'featConsumer', 'function', 1, 5)`).run();

    // Main: consumerFunc calls coreFunc
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (2, 2, 1, 'coreFunc', 2, 'resolved')`).run();
    // Feature: featConsumer calls coreFunc (feature)
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (4, 4, 3, 'coreFunc', 2, 'resolved')`).run();

    // Main: consumer.ts imports core.ts
    db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (2, './core', 1)`).run();
    // Main: mid.ts imports consumer.ts (for multi-hop)
    db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (8, './consumer', 2)`).run();
    // Feature: feat-consumer.ts imports core.ts (feature)
    db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (4, './core', 3)`).run();

    // Main: ChildType extends BaseType
    db.prepare(`INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method) VALUES (6, 6, 5, 'BaseType', 'extends', 1, 0, 'resolved')`).run();

    // Main: userFunc type-references BaseType
    db.prepare(`INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method) VALUES (7, 7, 5, 'BaseType', 'BaseType', 'parameter', 2, 5, 'resolved')`).run();
  });

  afterEach(() => { db.close(); });

  it('symbol kind with branch restricts callers to that branch', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol', branch: 'main' });
    expect(result.target.name).toBe('coreFunc');
    const callerNames = result.dependents.callers.map((c: any) => c.caller_name);
    expect(callerNames).toContain('consumerFunc');
    expect(callerNames).not.toContain('featConsumer');
  });

  it('symbol kind with branch restricts importers to that branch', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol', branch: 'main' });
    const importerPaths = result.dependents.importers.map((i: any) => i.file_path);
    expect(importerPaths).toContain('src/consumer.ts');
    expect(importerPaths).not.toContain('src/feat-consumer.ts');
  });

  it('symbol kind with branch covers subclass and type_ref expansion', () => {
    const result = handler(db, { query: 'BaseType', kind: 'symbol', branch: 'main' });
    const subNames = result.dependents.subclasses.map((s: any) => s.symbol_name);
    expect(subNames).toContain('ChildType');
    expect(result.dependents.type_references.length).toBe(1);
  });

  it('file kind with branch restricts all dependent queries', () => {
    const result = handler(db, { query: 'src/core.ts', kind: 'file', branch: 'main' });
    expect(result.target.name).toBe('src/core.ts');
    const importerPaths = result.dependents.importers.map((i: any) => i.file_path);
    expect(importerPaths).toContain('src/consumer.ts');
    expect(importerPaths).not.toContain('src/feat-consumer.ts');
  });

  it('file kind with branch covers type_refs through file symbols', () => {
    const result = handler(db, { query: 'src/types.ts', kind: 'file', branch: 'main' });
    expect(result.dependents.type_references.length).toBe(1);
    const ref = result.dependents.type_references[0] as any;
    expect(ref.symbol_name).toBe('userFunc');
  });

  it('compact mode with branch filtering', () => {
    const result = handler(db, { query: 'coreFunc', kind: 'symbol', branch: 'main', compact: true });
    expect(result.dependents.callers.length).toBeGreaterThanOrEqual(1);
    const caller = result.dependents.callers[0] as any;
    expect(caller.line).toBeUndefined();
  });
});

// ─── Parent symbol (enclosing name) handling ──────────────────────────────────

describe('lore_dependents handler — parent symbol', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/target.ts', 'main', 'typescript', '')`).run();
    db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/caller.ts', 'main', 'typescript', '')`).run();

    // Target symbol
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'targetFn', 'function', 1, 5)`).run();
    // Parent class
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'MyClass', 'class', 1, 20)`).run();
    // Method in class with parent_symbol_id
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, parent_symbol_id) VALUES (3, 2, 'myMethod', 'method', 5, 15, 2)`).run();

    // myMethod calls targetFn
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method) VALUES (3, 2, 1, 'targetFn', 7, 'resolved')`).run();

    // Import for importer coverage
    db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (2, './target', 1)`).run();
  });

  afterEach(() => { db.close(); });

  it('full mode includes parent_symbol_id and enclosing_name', () => {
    const result = handler(db, { query: 'targetFn', kind: 'symbol' });
    const caller = result.dependents.callers[0] as any;
    expect(caller.caller_parent_symbol_id).toBe(2);
    expect(caller.caller_parent_name).toBe('MyClass');
  });

  it('compact mode includes parent_symbol_id and enclosing_name', () => {
    const result = handler(db, { query: 'targetFn', kind: 'symbol', compact: true });
    const caller = result.dependents.callers[0] as any;
    expect(caller.caller_parent_symbol_id).toBe(2);
    expect(caller.caller_parent_name).toBe('MyClass');
  });

  it('compact importers omit raw_import', () => {
    const result = handler(db, { query: 'targetFn', kind: 'symbol', compact: true });
    expect(result.dependents.importers.length).toBeGreaterThanOrEqual(1);
    const imp = result.dependents.importers[0] as any;
    expect(imp.file_id).toBeDefined();
    expect(imp.file_path).toBeDefined();
    expect(imp.raw_import).toBeUndefined();
  });
});

// ─── File with no symbols (empty-array guards) ───────────────────────────────

describe('lore_dependents handler — file with no symbols', () => {
  it('returns empty callers/subclasses/type_refs for symbol-less file', () => {
    const db = openDb(':memory:');
    try {
      // File with no symbols defined in it
      db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (1, 'empty.ts', 'main', 'typescript', '')`).run();
      // Another file that imports it
      db.prepare(`INSERT INTO files (id, path, branch, language, source) VALUES (2, 'consumer.ts', 'main', 'typescript', '')`).run();
      db.prepare(`INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (2, './empty', 1)`).run();

      const result = handler(db, { query: 'empty.ts', kind: 'file' });
      expect(result.target.name).toBe('empty.ts');
      // Import still found
      expect(result.dependents.importers.length).toBe(1);
      // No symbols → empty callers, subclasses, type_refs
      expect(result.dependents.callers).toHaveLength(0);
      expect(result.dependents.subclasses).toHaveLength(0);
      expect(result.dependents.type_references).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
