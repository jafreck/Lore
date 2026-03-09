import { describe, it, expect } from 'vitest';
import { normalizeTypeName, resolveSymbolEdges } from '../../src/indexer/call-graph.js';
import { openDb } from '../../src/indexer/db.js';
import type { Database } from '../../src/indexer/db.js';

describe('normalizeTypeName', () => {
  it('should strip pointer suffix', () => {
    expect(normalizeTypeName('ZSTD_CCtx*')).toBe('ZSTD_CCtx');
  });

  it('should strip const qualifier and pointer', () => {
    expect(normalizeTypeName('const ZSTD_CCtx*')).toBe('ZSTD_CCtx');
  });

  it('should strip struct keyword', () => {
    expect(normalizeTypeName('struct Foo')).toBe('Foo');
  });

  it('should strip enum keyword', () => {
    expect(normalizeTypeName('enum Bar')).toBe('Bar');
  });

  it('should strip Rust &mut reference', () => {
    expect(normalizeTypeName('&mut Foo')).toBe('Foo');
  });

  it('should strip Rust lifetime annotation', () => {
    expect(normalizeTypeName("&'a Foo")).toBe('Foo');
  });

  it('should strip Rust static mut lifetime', () => {
    expect(normalizeTypeName("&'static mut Bar")).toBe('Bar');
  });

  it('should truncate at generic args', () => {
    expect(normalizeTypeName('Vec<MyStruct>')).toBe('Vec');
  });

  it('should take last segment after :: for std::vector<int>', () => {
    expect(normalizeTypeName('std::vector<int>')).toBe('vector');
  });

  it('should take last segment after :: for crate::types::Foo', () => {
    expect(normalizeTypeName('crate::types::Foo')).toBe('Foo');
  });

  it('should take last segment after . for MyModule.MyType', () => {
    expect(normalizeTypeName('MyModule.MyType')).toBe('MyType');
  });

  it('should truncate nested generics', () => {
    expect(normalizeTypeName('Option<Box<MyStruct>>')).toBe('Option');
  });

  it('should preserve unsigned int (compound C type)', () => {
    expect(normalizeTypeName('unsigned int')).toBe('unsigned int');
  });

  it('should preserve int32_t', () => {
    expect(normalizeTypeName('int32_t')).toBe('int32_t');
  });

  it('should return empty for empty string', () => {
    expect(normalizeTypeName('')).toBe('');
  });

  it('should return bare name unchanged', () => {
    expect(normalizeTypeName('MyType')).toBe('MyType');
  });

  it('should handle nested generics A<B<C>>', () => {
    expect(normalizeTypeName('A<B<C>>')).toBe('A');
  });

  it('should handle Rust &', () => {
    expect(normalizeTypeName('&Foo')).toBe('Foo');
  });

  it('should preserve long long (C compound type)', () => {
    expect(normalizeTypeName('long long')).toBe('long long');
  });

  it('should handle C function pointer void (*)(int) → empty', () => {
    expect(normalizeTypeName('void (*)(int)')).toBe('');
  });

  it('should strip array suffix', () => {
    expect(normalizeTypeName('int[]')).toBe('int');
  });

  it('should strip volatile qualifier', () => {
    expect(normalizeTypeName('volatile int*')).toBe('int');
  });
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string): number {
  return Number(
    db.prepare("INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, 'main', 'typescript', 0, NULL, '')")
      .run(path).lastInsertRowid,
  );
}

function insertSymbol(db: Database.Database, fileId: number, name: string, kind = 'class', startLine = 1): number {
  return Number(
    db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, name, kind, startLine, startLine + 10, `${kind} ${name}`).lastInsertRowid,
  );
}

// ─── resolveSymbolEdges: bare-name collision (same-file preference) ───────────

describe('resolveSymbolEdges – bare-name collision across files', () => {
  it('should prefer the Widget in the same file as the referencing symbol', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const widget1 = insertSymbol(db, file1, 'Widget', 'class', 1);
    const widget2 = insertSymbol(db, file2, 'Widget', 'class', 1);

    // Create a symbol in file1 that references Widget
    const consumer = insertSymbol(db, file1, 'renderWidget', 'function', 20);

    // Insert a type_ref from the consumer in file1 referencing 'Widget'
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line)
       VALUES (?, ?, 'Widget', 'Widget', 'parameter', 22)`,
    ).run(file1, consumer);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id FROM type_refs WHERE symbol_id = ?').get(consumer) as { type_id: number | null };
    expect(ref.type_id).toBe(widget1);
  });

  it('should resolve to the other Widget when source_file_id differs', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    insertSymbol(db, file1, 'Widget', 'class', 1);
    const widget2 = insertSymbol(db, file2, 'Widget', 'class', 1);

    // Create a symbol in file2 that references Widget
    const consumer = insertSymbol(db, file2, 'renderWidget', 'function', 20);

    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line)
       VALUES (?, ?, 'Widget', 'Widget', 'parameter', 22)`,
    ).run(file2, consumer);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id FROM type_refs WHERE symbol_id = ?').get(consumer) as { type_id: number | null };
    expect(ref.type_id).toBe(widget2);
  });

  it('should resolve symbol_refs with same-file preference on bare-name collision', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const handler1 = insertSymbol(db, file1, 'handle', 'function', 1);
    insertSymbol(db, file2, 'handle', 'function', 1);

    const caller = insertSymbol(db, file1, 'dispatch', 'function', 20);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line) VALUES (?, 'handle', 22)`,
    ).run(caller);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null };
    expect(ref.callee_id).toBe(handler1);
  });
});

// ─── resolveSymbolEdges: definition_path-based resolution ─────────────────────

describe('resolveSymbolEdges – definition_path-based resolution', () => {
  it('should resolve type_ref via definition_path when name-based fails', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    insertSymbol(db, file1, 'Widget', 'class', 1);
    const widget2 = insertSymbol(db, file2, 'Widget', 'class', 1);

    const consumer = insertSymbol(db, file1, 'renderWidget', 'function', 20);

    // Insert a type_ref with a mangled name that won't match by name,
    // but has definition_path pointing to file2
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, definition_path)
       VALUES (?, ?, 'com.example.Widget', 'com.example.Widget', 'parameter', 22, ?)`,
    ).run(file1, consumer, 'src/file2.ts');

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id FROM type_refs WHERE symbol_id = ?').get(consumer) as { type_id: number | null };
    expect(ref.type_id).toBe(widget2);
  });

  it('should resolve type_ref via definition_path to file2 Widget even when file1 Widget matches by name', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    insertSymbol(db, file1, 'Widget', 'class', 1);
    const widget2 = insertSymbol(db, file2, 'Widget', 'class', 1);

    const consumer = insertSymbol(db, file1, 'renderWidget', 'function', 20);

    // This type_ref has a name that doesn't match any symbol ('UnknownWidget'),
    // plus a definition_path pointing to file2 — should resolve via path
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, definition_path)
       VALUES (?, ?, 'UnknownWidget', 'UnknownWidget', 'parameter', 22, ?)`,
    ).run(file1, consumer, 'src/file2.ts');

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id FROM type_refs WHERE symbol_id = ?').get(consumer) as { type_id: number | null };
    expect(ref.type_id).toBe(widget2);
  });

  it('should resolve symbol_ref via definition_path when callee_name has no match', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const target = insertSymbol(db, file2, 'WidgetImpl', 'class', 5);

    const caller = insertSymbol(db, file1, 'bootstrap', 'function', 1);

    // callee_name 'NoMatch' won't match any symbol; definition_path resolves it
    db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line, definition_path) VALUES (?, 'NoMatch', 10, ?)`,
    ).run(caller, 'src/file2.ts');

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null };
    expect(ref.callee_id).toBe(target);
  });

  it('should pick the first symbol by start_line when definition_path matches multiple symbols', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    // Two symbols in file2 at different lines
    const first = insertSymbol(db, file2, 'Alpha', 'class', 1);
    insertSymbol(db, file2, 'Beta', 'class', 50);

    const caller = insertSymbol(db, file1, 'main', 'function', 1);

    db.prepare(
      `INSERT INTO symbol_refs (caller_id, callee_name, call_line, definition_path) VALUES (?, 'NoMatch', 10, ?)`,
    ).run(caller, 'src/file2.ts');

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT callee_id FROM symbol_refs WHERE caller_id = ?').get(caller) as { callee_id: number | null };
    expect(ref.callee_id).toBe(first);
  });

  it('should not overwrite an already-resolved ref via definition_path', () => {
    const db = createDb();
    const file1 = insertFile(db, 'src/file1.ts');
    const file2 = insertFile(db, 'src/file2.ts');

    const widget1 = insertSymbol(db, file1, 'Widget', 'class', 1);
    insertSymbol(db, file2, 'Widget', 'class', 1);

    const consumer = insertSymbol(db, file1, 'renderWidget', 'function', 20);

    // type_ref with name 'Widget' — will resolve by name to widget1 (same file)
    // Also has definition_path to file2 — but since it's already resolved, the path pass should skip it
    db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, definition_path)
       VALUES (?, ?, 'Widget', 'Widget', 'parameter', 22, ?)`,
    ).run(file1, consumer, 'src/file2.ts');

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT type_id FROM type_refs WHERE symbol_id = ?').get(consumer) as { type_id: number | null };
    // Name-based resolves first to widget1 (same-file), definition_path pass shouldn't override
    expect(ref.type_id).toBe(widget1);
  });
});
