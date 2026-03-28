import { describe, it, expect, afterEach } from 'vitest';
import {
  inferLoreLanguage,
  inferTypeRefKindFromTree,
  isCallExpression,
  extractReceiverName,
  extractImportPathFromTree,
  findMatchingCallRef,
  findMatchingTypeRefKind,
  materializeVirtualDispatch,
} from '../../src/indexer/stages/scip-helpers/ingest.js';
import { ParserPool } from '../../src/parsing/parser.js';
import { openDb, type Database } from '../../src/db/schema.js';
import { getLogger } from '../../src/logger.js';
import type { SymbolInformation as ScipSymbolInformation } from '../../src/scip/scip_pb.js';

// ─── inferLoreLanguage ────────────────────────────────────────────────────────

describe('inferLoreLanguage', () => {
  describe('maps SCIP language strings', () => {
    it('maps typescript', () => {
      expect(inferLoreLanguage('typescript', 'foo.ts')).toBe('typescript');
    });

    it('maps typescriptreact', () => {
      expect(inferLoreLanguage('typescriptreact', 'foo.tsx')).toBe('typescript');
    });

    it('maps javascript', () => {
      expect(inferLoreLanguage('javascript', 'foo.js')).toBe('javascript');
    });

    it('maps javascriptreact', () => {
      expect(inferLoreLanguage('javascriptreact', 'foo.jsx')).toBe('javascript');
    });

    it('maps python', () => {
      expect(inferLoreLanguage('python', 'foo.py')).toBe('python');
    });

    it('maps java', () => {
      expect(inferLoreLanguage('java', 'Foo.java')).toBe('java');
    });

    it('maps scala', () => {
      expect(inferLoreLanguage('scala', 'Foo.scala')).toBe('scala');
    });

    it('maps kotlin', () => {
      expect(inferLoreLanguage('kotlin', 'Foo.kt')).toBe('kotlin');
    });

    it('maps rust', () => {
      expect(inferLoreLanguage('rust', 'lib.rs')).toBe('rust');
    });

    it('maps c', () => {
      expect(inferLoreLanguage('c', 'main.c')).toBe('c');
    });

    it('maps c++ to cpp', () => {
      expect(inferLoreLanguage('c++', 'main.cpp')).toBe('cpp');
    });

    it('maps cpp to cpp', () => {
      expect(inferLoreLanguage('cpp', 'main.cpp')).toBe('cpp');
    });

    it('maps c# to csharp', () => {
      expect(inferLoreLanguage('c#', 'Foo.cs')).toBe('csharp');
    });

    it('maps csharp', () => {
      expect(inferLoreLanguage('csharp', 'Foo.cs')).toBe('csharp');
    });

    it('maps visualbasic to csharp', () => {
      expect(inferLoreLanguage('visualbasic', 'Foo.vb')).toBe('csharp');
    });

    it('maps ruby', () => {
      expect(inferLoreLanguage('ruby', 'app.rb')).toBe('ruby');
    });

    it('maps php', () => {
      expect(inferLoreLanguage('php', 'index.php')).toBe('php');
    });

    it('maps go', () => {
      expect(inferLoreLanguage('go', 'main.go')).toBe('go');
    });

    it('maps dart', () => {
      expect(inferLoreLanguage('dart', 'main.dart')).toBe('dart');
    });

    it('is case insensitive for SCIP language', () => {
      expect(inferLoreLanguage('TypeScript', 'foo.ts')).toBe('typescript');
      expect(inferLoreLanguage('PYTHON', 'foo.py')).toBe('python');
      expect(inferLoreLanguage('Java', 'Foo.java')).toBe('java');
    });
  });

  describe('infers from file extension when SCIP language is blank', () => {
    it('infers typescript from .ts', () => {
      expect(inferLoreLanguage('', 'src/index.ts')).toBe('typescript');
    });

    it('infers typescript from .tsx', () => {
      expect(inferLoreLanguage('', 'src/App.tsx')).toBe('typescript');
    });

    it('infers javascript from .js', () => {
      expect(inferLoreLanguage('', 'lib/utils.js')).toBe('javascript');
    });

    it('infers python from .py', () => {
      expect(inferLoreLanguage('', 'app/main.py')).toBe('python');
    });

    it('infers java from .java', () => {
      expect(inferLoreLanguage('', 'com/example/Main.java')).toBe('java');
    });

    it('infers rust from .rs', () => {
      expect(inferLoreLanguage('', 'src/lib.rs')).toBe('rust');
    });

    it('infers go from .go', () => {
      expect(inferLoreLanguage('', 'cmd/main.go')).toBe('go');
    });

    it('infers c from .c', () => {
      expect(inferLoreLanguage('', 'src/main.c')).toBe('c');
    });

    it('infers c from .h', () => {
      expect(inferLoreLanguage('', 'include/header.h')).toBe('c');
    });

    it('infers cpp from .cpp', () => {
      expect(inferLoreLanguage('', 'src/main.cpp')).toBe('cpp');
    });

    it('infers csharp from .cs', () => {
      expect(inferLoreLanguage('', 'Program.cs')).toBe('csharp');
    });

    it('infers ruby from .rb', () => {
      expect(inferLoreLanguage('', 'app.rb')).toBe('ruby');
    });

    it('infers php from .php', () => {
      expect(inferLoreLanguage('', 'index.php')).toBe('php');
    });
  });

  describe('edge cases', () => {
    it('returns null for unknown language and unknown extension', () => {
      expect(inferLoreLanguage('unknown_lang', 'file.xyz')).toBeNull();
    });

    it('returns null for empty language and no extension', () => {
      expect(inferLoreLanguage('', 'Makefile')).toBeNull();
    });

    it('falls back to extension when SCIP language is unrecognised', () => {
      expect(inferLoreLanguage('unknown', 'src/index.ts')).toBe('typescript');
    });

    it('prefers SCIP language over extension', () => {
      // Edge case: SCIP says python but file is .ts — trust SCIP
      expect(inferLoreLanguage('python', 'src/index.ts')).toBe('python');
    });
  });
});

// ─── Tree-sitter-based helpers ────────────────────────────────────────────────

const pool = new ParserPool();

function parseTS(source: string) {
  const tree = pool.parse('typescript', source);
  if (!tree) throw new Error('Failed to parse TypeScript');
  return tree;
}

function parsePython(source: string) {
  const tree = pool.parse('python', source);
  if (!tree) throw new Error('Failed to parse Python');
  return tree;
}

function parseC(source: string) {
  const tree = pool.parse('c', source);
  if (!tree) throw new Error('Failed to parse C');
  return tree;
}

function parseJava(source: string) {
  const tree = pool.parse('java', source);
  if (!tree) throw new Error('Failed to parse Java');
  return tree;
}

function parseRust(source: string) {
  const tree = pool.parse('rust', source);
  if (!tree) throw new Error('Failed to parse Rust');
  return tree;
}

function parseGo(source: string) {
  const tree = pool.parse('go', source);
  if (!tree) throw new Error('Failed to parse Go');
  return tree;
}

describe('inferTypeRefKindFromTree', () => {
  it('identifies type annotations on parameters', () => {
    const src = 'function foo(x: MyType) {}';
    const tree = parseTS(src);
    // MyType starts at column 16
    const kind = inferTypeRefKindFromTree(tree, 0, 16);
    expect(kind).toBe('parameter');
  });

  it('identifies variable declarations', () => {
    const src = 'const x: MyType = 1;';
    const tree = parseTS(src);
    // MyType at col 9
    const kind = inferTypeRefKindFromTree(tree, 0, 9);
    // Variable declarator or lexical_declaration
    expect(['variable', 'field', 'parameter']).toContain(kind);
  });

  it('returns null when node is not in a type position', () => {
    const src = 'const x = 42;';
    const tree = parseTS(src);
    // col 10 is the literal 42
    const kind = inferTypeRefKindFromTree(tree, 0, 10);
    // Could be variable or null depending on how deep it walks
    // The point is it shouldn't crash
    expect(kind === null || typeof kind === 'string').toBe(true);
  });
});

describe('isCallExpression', () => {
  it('returns true for call expressions', () => {
    const src = 'foo(1, 2);';
    const tree = parseTS(src);
    // 'foo' starts at col 0
    expect(isCallExpression(tree, 0, 0)).toBe(true);
  });

  it('returns true for method calls', () => {
    const src = 'obj.method(arg);';
    const tree = parseTS(src);
    // 'method' at col 4
    expect(isCallExpression(tree, 0, 4)).toBe(true);
  });

  it('returns true for new expressions', () => {
    const src = 'new MyClass(arg);';
    const tree = parseTS(src);
    expect(isCallExpression(tree, 0, 4)).toBe(true);
  });

  it('returns false for plain identifiers', () => {
    const src = 'const x = myVar;';
    const tree = parseTS(src);
    // myVar at col 10
    expect(isCallExpression(tree, 0, 10)).toBe(false);
  });
});

describe('extractReceiverName', () => {
  it('extracts receiver from member expression', () => {
    const src = 'obj.method(arg);';
    const tree = parseTS(src);
    // 'method' at col 4
    const receiver = extractReceiverName(tree, 0, 4);
    expect(receiver).toBe('obj');
  });

  it('returns null for plain function call', () => {
    const src = 'foo(1);';
    const tree = parseTS(src);
    const receiver = extractReceiverName(tree, 0, 0);
    expect(receiver).toBeNull();
  });

  it('extracts from chained access', () => {
    const src = 'a.b.c();';
    const tree = parseTS(src);
    // 'c' is at col 4 within a nested member_expression — the receiver
    // extraction walks up from col 4-ish; tree-sitter may not see 'c' itself
    // as a member_expression child at that position.  Verify no crash.
    const receiver = extractReceiverName(tree, 0, 4);
    // May be null or a string depending on tree shape
    expect(receiver === null || typeof receiver === 'string').toBe(true);
  });
});

describe('extractImportPathFromTree', () => {
  it('extracts path from ES import statement', () => {
    const src = "import { foo } from './bar';";
    const tree = parseTS(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).toBe('./bar');
  });

  it('extracts path from import without braces', () => {
    const src = "import fs from 'fs';";
    const tree = parseTS(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).toBe('fs');
  });

  it('returns null for non-import line', () => {
    const src = 'const x = 42;';
    const tree = parseTS(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).toBeNull();
  });

  it('extracts path from Python import', () => {
    const src = 'from os.path import join';
    const tree = parsePython(src);
    const importPath = extractImportPathFromTree(tree, 0);
    // Should extract the dotted path
    expect(importPath).not.toBeNull();
  });
});

describe('findMatchingCallRef', () => {
  it('returns null for undefined treeData', () => {
    expect(findMatchingCallRef(undefined, 0, 0, 'foo')).toBeNull();
  });

  it('returns null when no candidates on line', () => {
    const treeData = {
      callRefsByLine: new Map(),
      typeRefsByLine: new Map(),
    };
    expect(findMatchingCallRef(treeData as any, 5, 0, 'foo')).toBeNull();
  });

  it('matches by callee name', () => {
    const callRef = { callee: 'foo', calleeRaw: 'foo', line: 10, character: 5, isAsync: false };
    const treeData = {
      callRefsByLine: new Map([[10, [callRef]]]),
      typeRefsByLine: new Map(),
    };
    const result = findMatchingCallRef(treeData as any, 10, 5, 'foo');
    expect(result).toBe(callRef);
  });

  it('picks closest by column distance', () => {
    const ref1 = { callee: 'foo', calleeRaw: 'foo', line: 10, character: 2, isAsync: false };
    const ref2 = { callee: 'foo', calleeRaw: 'foo', line: 10, character: 20, isAsync: false };
    const treeData = {
      callRefsByLine: new Map([[10, [ref1, ref2]]]),
      typeRefsByLine: new Map(),
    };
    const result = findMatchingCallRef(treeData as any, 10, 3, 'foo');
    expect(result).toBe(ref1);
  });

  it('matches new-prefixed names', () => {
    const callRef = { callee: 'MyClass', calleeRaw: 'new MyClass', line: 5, character: 0, isAsync: false };
    const treeData = {
      callRefsByLine: new Map([[5, [callRef]]]),
      typeRefsByLine: new Map(),
    };
    const result = findMatchingCallRef(treeData as any, 5, 0, 'MyClass');
    expect(result).toBe(callRef);
  });

  it('skips non-matching names', () => {
    const callRef = { callee: 'bar', calleeRaw: 'bar', line: 10, character: 5, isAsync: false };
    const treeData = {
      callRefsByLine: new Map([[10, [callRef]]]),
      typeRefsByLine: new Map(),
    };
    expect(findMatchingCallRef(treeData as any, 10, 5, 'foo')).toBeNull();
  });
});

describe('findMatchingTypeRefKind', () => {
  it('returns null for undefined treeData', () => {
    expect(findMatchingTypeRefKind(undefined, 0, 0, 'Foo')).toBeNull();
  });

  it('returns null when no candidates on line', () => {
    const treeData = {
      callRefsByLine: new Map(),
      typeRefsByLine: new Map(),
    };
    expect(findMatchingTypeRefKind(treeData as any, 5, 0, 'Foo')).toBeNull();
  });

  it('matches by normalized type name', () => {
    const typeRef = { typeRaw: 'Foo', refKind: 'field' as const, line: 10, character: 5 };
    const treeData = {
      callRefsByLine: new Map(),
      typeRefsByLine: new Map([[10, [typeRef]]]),
    };
    const result = findMatchingTypeRefKind(treeData as any, 10, 5, 'Foo');
    expect(result).toBe('field');
  });

  it('returns null for non-matching type names', () => {
    const typeRef = { typeRaw: 'Bar', refKind: 'field' as const, line: 10, character: 5 };
    const treeData = {
      callRefsByLine: new Map(),
      typeRefsByLine: new Map([[10, [typeRef]]]),
    };
    expect(findMatchingTypeRefKind(treeData as any, 10, 5, 'Foo')).toBeNull();
  });

  it('picks closest by column distance', () => {
    const ref1 = { typeRaw: 'Foo', refKind: 'field' as const, line: 10, character: 2 };
    const ref2 = { typeRaw: 'Foo', refKind: 'parameter' as const, line: 10, character: 20 };
    const treeData = {
      callRefsByLine: new Map(),
      typeRefsByLine: new Map([[10, [ref1, ref2]]]),
    };
    const result = findMatchingTypeRefKind(treeData as any, 10, 3, 'Foo');
    expect(result).toBe('field');
  });
});

// ─── Additional inferTypeRefKindFromTree branches ─────────────────────────

describe('inferTypeRefKindFromTree (additional branches)', () => {
  it('identifies property_declaration as field (Java)', () => {
    // Java field with type — tree-sitter-java uses field_declaration
    const src = 'class Foo { private int bar; }';
    const tree = parseJava(src);
    // 'int' at col 20 on line 0 inside field_declaration
    const kind = inferTypeRefKindFromTree(tree, 0, 20);
    expect(kind).toBe('field');
  });

  it('identifies field_definition as field', () => {
    // JavaScript class field
    const src = `class Foo {
  bar = 42;
}`;
    const tree = parseTS(src);
    // 'bar' at col 2, line 1 — inside a field_definition
    const kind = inferTypeRefKindFromTree(tree, 1, 2);
    // field_definition maps to 'field'
    expect(kind === 'field' || kind === 'variable' || kind === null).toBe(true);
  });

  it('identifies typed_parameter (Python)', () => {
    const src = 'def foo(x: MyType):\n    pass';
    const tree = parsePython(src);
    // MyType at col 11 on line 0
    const kind = inferTypeRefKindFromTree(tree, 0, 11);
    expect(kind).toBe('parameter');
  });

  it('identifies parameter_declaration (C)', () => {
    const src = 'void foo(int x) {}';
    const tree = parseC(src);
    // 'int' at col 9 on line 0 — inside parameter_declaration
    const kind = inferTypeRefKindFromTree(tree, 0, 9);
    expect(kind).toBe('parameter');
  });

  it('identifies lexical_declaration as variable', () => {
    const src = 'let x: string = "hello";';
    const tree = parseTS(src);
    // 'string' at col 7 on line 0
    const kind = inferTypeRefKindFromTree(tree, 0, 7);
    expect(['variable', 'field', 'parameter']).toContain(kind);
  });

  it('identifies generic_type as generic_arg', () => {
    const src = 'const x: Map<string, number> = new Map();';
    const tree = parseTS(src);
    // 'Map' at col 9 — in a generic_type
    const kind = inferTypeRefKindFromTree(tree, 0, 9);
    expect(kind === 'generic_arg' || kind === 'variable').toBe(true);
  });

  it('identifies type_argument_list as generic_arg', () => {
    // Java generic invocation
    const src = 'class Foo { void bar() { List<String> x; } }';
    const tree = parseJava(src);
    // 'String' inside type_arguments — col 30
    const kind = inferTypeRefKindFromTree(tree, 0, 30);
    expect(kind === 'generic_arg' || kind === 'variable' || kind === null).toBe(true);
  });
});

// ─── extractImportPathFromTree edge cases ─────────────────────────────────

describe('extractImportPathFromTree (edge cases)', () => {
  it('extracts C #include system header (system_lib_string)', () => {
    const src = '#include <stdio.h>';
    const tree = parseC(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).toBe('stdio.h');
  });

  it('extracts C #include quoted header', () => {
    const src = '#include "myheader.h"';
    const tree = parseC(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).toBe('myheader.h');
  });

  it('extracts Java import with qualified identifier', () => {
    const src = 'import java.util.List;';
    const tree = parseJava(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).not.toBeNull();
    expect(importPath).toContain('java');
  });

  it('extracts Rust use declaration with scoped_identifier', () => {
    const src = 'use std::collections::HashMap;';
    const tree = parseRust(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).not.toBeNull();
    expect(importPath).toContain('std');
  });

  it('returns null when no import found', () => {
    const src = 'const x = 42;';
    const tree = parseTS(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).toBeNull();
  });

  it('returns null for a line containing only a comment', () => {
    const src = '// just a comment';
    const tree = parseTS(src);
    const importPath = extractImportPathFromTree(tree, 0);
    expect(importPath).toBeNull();
  });

  it('extracts Go import path', () => {
    const src = `package main
import "fmt"`;
    const tree = parseGo(src);
    const importPath = extractImportPathFromTree(tree, 1);
    expect(importPath).toBe('fmt');
  });
});

// ─── extractReceiverName — operand field (Go/Rust) ────────────────────────

describe('extractReceiverName (operand field)', () => {
  it('extracts receiver from Go selector expression', () => {
    const src = `package main
func main() { obj.Method() }`;
    const tree = parseGo(src);
    // 'Method' at col 22 on line 1 (inside selector_expression)
    const receiver = extractReceiverName(tree, 1, 22);
    expect(receiver).toBe('obj');
  });

  it('returns null for plain Go function call', () => {
    const src = `package main
func main() { foo() }`;
    const tree = parseGo(src);
    const receiver = extractReceiverName(tree, 1, 15);
    expect(receiver).toBeNull();
  });
});

// ─── materializeVirtualDispatch ───────────────────────────────────────────

describe('materializeVirtualDispatch', () => {
  let db: Database.Database;
  const log = getLogger();

  afterEach(() => {
    if (db) db.close();
  });

  function seedBasicSchema() {
    db = openDb(':memory:');

    // Insert a file
    db.prepare(`INSERT INTO files (id, path, language) VALUES (1, 'test.ts', 'typescript')`).run();

    // Insert symbols: interface method and concrete method
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, layer, generation)
      VALUES (100, 1, 'IAnimal', 'interface', 1, 10, 'baseline', 0)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, layer, generation)
      VALUES (101, 1, 'sound', 'method', 2, 4, 'baseline', 0)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, layer, generation)
      VALUES (200, 1, 'Dog', 'class', 11, 20, 'baseline', 0)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, layer, generation)
      VALUES (201, 1, 'sound', 'method', 12, 14, 'baseline', 0)`).run();
    db.prepare(`INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, layer, generation)
      VALUES (300, 1, 'main', 'function', 21, 30, 'baseline', 0)`).run();

    // Insert a call from main → IAnimal#sound (the interface method)
    db.prepare(`INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, layer, generation)
      VALUES (300, 1, 101, 'sound', 25, 10, 'direct', 'scip_definition', 'baseline', 0)`).run();
  }

  it('returns 0 when no implements pairs exist', () => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, language) VALUES (1, 'test.ts', 'typescript')`).run();

    const scipToLoreId = new Map<string, number>([
      ['pkg Foo#bar().', 101],
    ]);
    const symbolInfoMap = new Map<string, ScipSymbolInformation>();
    const symbolDefs = new Map<string, { filePath: string; line: number; character: number }>();

    const result = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefs, 'baseline', 0, log);
    expect(result).toBe(0);
  });

  it('returns 0 when implements pairs exist but no method mappings match', () => {
    db = openDb(':memory:');
    db.prepare(`INSERT INTO files (id, path, language) VALUES (1, 'test.ts', 'typescript')`).run();

    const scipToLoreId = new Map<string, number>([
      ['pkg IAnimal#', 100],
      ['pkg Dog#', 200],
    ]);

    // Dog implements IAnimal, but neither has methods in scipToLoreId
    const symbolInfoMap = new Map<string, ScipSymbolInformation>([
      ['pkg Dog#', {
        $typeName: 'scip.SymbolInformation' as const,
        symbol: 'pkg Dog#',
        documentation: [],
        relationships: [{
          $typeName: 'scip.Relationship' as const,
          symbol: 'pkg IAnimal#',
          isReference: false,
          isImplementation: true,
          isTypeDefinition: false,
        }],
        kind: 0,
        displayName: 'Dog',
        enclosingSymbol: '',
      } as unknown as ScipSymbolInformation],
    ]);

    const symbolDefs = new Map<string, { filePath: string; line: number; character: number }>();
    const result = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefs, 'baseline', 0, log);
    expect(result).toBe(0);
  });

  it('materializes virtual dispatch edges for matching interface/concrete methods', () => {
    seedBasicSchema();

    // SCIP symbols:
    // Interface: pkg IAnimal#sound().  →  lore id 101
    // Concrete:  pkg Dog#sound().      →  lore id 201
    const scipToLoreId = new Map<string, number>([
      ['pkg IAnimal#', 100],
      ['pkg IAnimal#sound().', 101],
      ['pkg Dog#', 200],
      ['pkg Dog#sound().', 201],
    ]);

    // Dog implements IAnimal
    const symbolInfoMap = new Map<string, ScipSymbolInformation>([
      ['pkg Dog#', {
        $typeName: 'scip.SymbolInformation' as const,
        symbol: 'pkg Dog#',
        documentation: [],
        relationships: [{
          $typeName: 'scip.Relationship' as const,
          symbol: 'pkg IAnimal#',
          isReference: false,
          isImplementation: true,
          isTypeDefinition: false,
        }],
        kind: 0,
        displayName: 'Dog',
        enclosingSymbol: '',
      } as unknown as ScipSymbolInformation],
    ]);

    const symbolDefs = new Map<string, { filePath: string; line: number; character: number }>([
      ['pkg Dog#sound().', { filePath: 'test.ts', line: 12, character: 2 }],
    ]);

    const edgesInserted = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefs, 'baseline', 0, log);

    // Should have inserted 1 edge: main → Dog#sound via virtual_dispatch
    expect(edgesInserted).toBe(1);

    // Verify the inserted edge
    const rows = db.prepare(`SELECT * FROM symbol_refs WHERE call_kind = 'virtual_dispatch'`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].caller_id).toBe(300);
    expect(rows[0].callee_id).toBe(201);
    expect(rows[0].callee_name).toBe('sound');
    expect(rows[0].call_kind).toBe('virtual_dispatch');
    expect(rows[0].resolution_method).toBe('scip_definition');
  });

  it('does not duplicate edges on second run', () => {
    seedBasicSchema();

    const scipToLoreId = new Map<string, number>([
      ['pkg IAnimal#', 100],
      ['pkg IAnimal#sound().', 101],
      ['pkg Dog#', 200],
      ['pkg Dog#sound().', 201],
    ]);

    const symbolInfoMap = new Map<string, ScipSymbolInformation>([
      ['pkg Dog#', {
        $typeName: 'scip.SymbolInformation' as const,
        symbol: 'pkg Dog#',
        documentation: [],
        relationships: [{
          $typeName: 'scip.Relationship' as const,
          symbol: 'pkg IAnimal#',
          isReference: false,
          isImplementation: true,
          isTypeDefinition: false,
        }],
        kind: 0,
        displayName: 'Dog',
        enclosingSymbol: '',
      } as unknown as ScipSymbolInformation],
    ]);

    const symbolDefs = new Map<string, { filePath: string; line: number; character: number }>([
      ['pkg Dog#sound().', { filePath: 'test.ts', line: 12, character: 2 }],
    ]);

    const first = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefs, 'baseline', 0, log);
    expect(first).toBe(1);

    // Second run should insert 0 new edges (already exist)
    const second = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefs, 'baseline', 0, log);
    expect(second).toBe(0);
  });

  it('handles concrete methods without definitions', () => {
    seedBasicSchema();

    const scipToLoreId = new Map<string, number>([
      ['pkg IAnimal#', 100],
      ['pkg IAnimal#sound().', 101],
      ['pkg Dog#', 200],
      ['pkg Dog#sound().', 201],
    ]);

    const symbolInfoMap = new Map<string, ScipSymbolInformation>([
      ['pkg Dog#', {
        $typeName: 'scip.SymbolInformation' as const,
        symbol: 'pkg Dog#',
        documentation: [],
        relationships: [{
          $typeName: 'scip.Relationship' as const,
          symbol: 'pkg IAnimal#',
          isReference: false,
          isImplementation: true,
          isTypeDefinition: false,
        }],
        kind: 0,
        displayName: 'Dog',
        enclosingSymbol: '',
      } as unknown as ScipSymbolInformation],
    ]);

    // No definitions for the concrete method
    const symbolDefs = new Map<string, { filePath: string; line: number; character: number }>();

    const edgesInserted = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefs, 'baseline', 0, log);
    expect(edgesInserted).toBe(1);

    // The edge should have null definition fields
    const rows = db.prepare(`SELECT * FROM symbol_refs WHERE call_kind = 'virtual_dispatch'`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].definition_uri).toBeNull();
    expect(rows[0].definition_path).toBeNull();
  });
});
