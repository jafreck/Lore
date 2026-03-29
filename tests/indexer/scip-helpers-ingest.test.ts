import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  inferLoreLanguage,
  materializeVirtualDispatch,
} from '../../src/indexer/stages/scip-helpers/ingest.js';
import { openDb, type Database } from '../../src/db/schema.js';
import { initLogger, LogLevel, resetLogger, getLogger } from '../../src/logger.js';
import { create } from '@bufbuild/protobuf';
import { SymbolInformationSchema, type SymbolInformation as ScipSymbolInformation } from '../../src/scip/scip_pb.js';

// ─── inferLoreLanguage ────────────────────────────────────────────────────────

describe('inferLoreLanguage', () => {
  describe('maps SCIP language strings', () => {
    const cases: Array<[string, string]> = [
      ['typescript', 'typescript'],
      ['typescriptreact', 'typescript'],
      ['javascript', 'javascript'],
      ['javascriptreact', 'javascript'],
      ['python', 'python'],
      ['java', 'java'],
      ['scala', 'scala'],
      ['kotlin', 'kotlin'],
      ['rust', 'rust'],
      ['c', 'c'],
      ['c++', 'cpp'],
      ['cpp', 'cpp'],
      ['c#', 'csharp'],
      ['csharp', 'csharp'],
      ['ruby', 'ruby'],
      ['php', 'php'],
      ['go', 'go'],
    ];

    for (const [scip, expected] of cases) {
      it(`maps "${scip}" → "${expected}"`, () => {
        expect(inferLoreLanguage(scip, 'foo.txt')).toBe(expected);
      });
    }

    it('is case-insensitive', () => {
      expect(inferLoreLanguage('TypeScript', 'foo.txt')).toBe('typescript');
      expect(inferLoreLanguage('PYTHON', 'foo.txt')).toBe('python');
    });
  });

  describe('falls back to file extension', () => {
    it('infers typescript from .ts', () => {
      expect(inferLoreLanguage('', 'src/main.ts')).toBe('typescript');
    });
    it('infers typescript from .tsx', () => {
      expect(inferLoreLanguage('', 'src/App.tsx')).toBe('typescript');
    });
    it('infers python from .py', () => {
      expect(inferLoreLanguage('', 'main.py')).toBe('python');
    });
    it('infers go from .go', () => {
      expect(inferLoreLanguage('', 'main.go')).toBe('go');
    });
    it('infers java from .java', () => {
      expect(inferLoreLanguage('', 'Main.java')).toBe('java');
    });
    it('infers rust from .rs', () => {
      expect(inferLoreLanguage('', 'lib.rs')).toBe('rust');
    });
    it('returns null for unknown extension', () => {
      expect(inferLoreLanguage('', 'data.xyz')).toBeNull();
    });
    it('returns null for no extension', () => {
      expect(inferLoreLanguage('', 'Makefile')).toBeNull();
    });
  });

  describe('prefers explicit language over extension', () => {
    it('uses SCIP language when both are available', () => {
      expect(inferLoreLanguage('python', 'main.ts')).toBe('python');
    });
  });
});

// ─── materializeVirtualDispatch ───────────────────────────────────────────────

describe('materializeVirtualDispatch', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: LogLevel.SILENT });
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function insertFile(filePath: string): number {
    const info = db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation) VALUES (?, 'main', 'typescript', 10, 'abc', '', 'baseline', 1)",
    ).run(filePath);
    return Number(info.lastInsertRowid);
  }

  function insertSymbol(fileId: number, name: string, kind: string, startLine: number): number {
    const info = db.prepare(
      "INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation) VALUES (?, ?, ?, ?, ?, 'baseline', 1)",
    ).run(fileId, name, kind, startLine, startLine + 5);
    return Number(info.lastInsertRowid);
  }

  function insertCallRef(callerId: number, calleeId: number, fileId: number): void {
    db.prepare(
      "INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, layer, generation) VALUES (?, ?, ?, 'callee', 10, 5, 'direct', 'scip_definition', 'baseline', 1)",
    ).run(callerId, fileId, calleeId);
  }

  function makeSymbolInfo(
    symbol: string,
    relationships: Array<{ symbol: string; isImplementation: boolean }>,
  ): ScipSymbolInformation {
    return create(SymbolInformationSchema, {
      symbol,
      relationships: relationships.map(r => ({
        symbol: r.symbol,
        isImplementation: r.isImplementation,
        isReference: false,
        isDefinition: false,
        isTypeDefinition: false,
      })),
    });
  }

  it('returns 0 when no implements relationships exist', () => {
    const scipToLoreId = new Map<string, number>();
    const symbolInfoMap = new Map<string, ScipSymbolInformation>();
    const symbolDefinitions = new Map<string, { filePath: string; line: number; character: number }>();

    const result = materializeVirtualDispatch(
      db, scipToLoreId, symbolInfoMap, symbolDefinitions,
      'baseline', 1, getLogger(),
    );
    expect(result).toBe(0);
  });

  it('returns 0 when implements exist but no matching methods', () => {
    const interfaceType = 'scip-ts npm pkg 1.0 IFoo#';
    const concreteType = 'scip-ts npm pkg 1.0 FooImpl#';

    const scipToLoreId = new Map<string, number>([
      [interfaceType, 1],
      [concreteType, 2],
    ]);

    const symbolInfoMap = new Map<string, ScipSymbolInformation>([
      [concreteType, makeSymbolInfo(concreteType, [
        { symbol: interfaceType, isImplementation: true },
      ])],
    ]);
    const symbolDefinitions = new Map<string, { filePath: string; line: number; character: number }>();

    const result = materializeVirtualDispatch(
      db, scipToLoreId, symbolInfoMap, symbolDefinitions,
      'baseline', 1, getLogger(),
    );
    expect(result).toBe(0);
  });

  it('materializes virtual dispatch edges for matching interface→concrete methods', () => {
    const fileId = insertFile('/src/foo.ts');

    // Interface method
    const interfaceType = 'scip-ts npm pkg 1.0 IReader#';
    const interfaceMethod = 'scip-ts npm pkg 1.0 IReader#read().';
    const interfaceMethodId = insertSymbol(fileId, 'read', 'method', 0);

    // Concrete method
    const concreteType = 'scip-ts npm pkg 1.0 FileReader#';
    const concreteMethod = 'scip-ts npm pkg 1.0 FileReader#read().';
    const concreteMethodId = insertSymbol(fileId, 'read', 'method', 10);

    // A caller of IReader.read()
    const callerId = insertSymbol(fileId, 'process', 'function', 20);
    insertCallRef(callerId, interfaceMethodId, fileId);

    const scipToLoreId = new Map<string, number>([
      [interfaceType, 100],
      [interfaceMethod, interfaceMethodId],
      [concreteType, 200],
      [concreteMethod, concreteMethodId],
    ]);

    const symbolInfoMap = new Map<string, ScipSymbolInformation>([
      [concreteType, makeSymbolInfo(concreteType, [
        { symbol: interfaceType, isImplementation: true },
      ])],
    ]);

    const symbolDefinitions = new Map([
      [concreteMethod, { filePath: '/src/foo.ts', line: 10, character: 2 }],
    ]);

    const result = materializeVirtualDispatch(
      db, scipToLoreId, symbolInfoMap, symbolDefinitions,
      'baseline', 1, getLogger(),
    );

    expect(result).toBe(1);

    // Verify the virtual dispatch edge was inserted with correct values
    const edges = db.prepare(
      "SELECT caller_id, callee_id, callee_name, call_kind, resolution_method, definition_path, definition_line FROM symbol_refs WHERE call_kind = 'virtual_dispatch'",
    ).all() as Array<{ caller_id: number; callee_id: number; callee_name: string; call_kind: string; resolution_method: string; definition_path: string | null; definition_line: number | null }>;
    expect(edges.length).toBe(1);
    expect(edges[0]!.caller_id).toBe(callerId);
    expect(edges[0]!.callee_id).toBe(concreteMethodId);
    expect(edges[0]!.callee_name).toBe('read');
    expect(edges[0]!.call_kind).toBe('virtual_dispatch');
    expect(edges[0]!.resolution_method).toBe('scip_definition');
    expect(edges[0]!.definition_path).toBe('/src/foo.ts');
    expect(edges[0]!.definition_line).toBe(10);
  });

  it('does not duplicate edges on re-run', () => {
    const fileId = insertFile('/src/bar.ts');
    const interfaceMethod = 'scip-ts npm pkg 1.0 IWriter#write().';
    const concreteMethod = 'scip-ts npm pkg 1.0 FileWriter#write().';
    const interfaceMethodId = insertSymbol(fileId, 'write', 'method', 0);
    const concreteMethodId = insertSymbol(fileId, 'write', 'method', 10);
    const callerId = insertSymbol(fileId, 'save', 'function', 20);
    insertCallRef(callerId, interfaceMethodId, fileId);

    const scipToLoreId = new Map<string, number>([
      ['scip-ts npm pkg 1.0 IWriter#', 100],
      [interfaceMethod, interfaceMethodId],
      ['scip-ts npm pkg 1.0 FileWriter#', 200],
      [concreteMethod, concreteMethodId],
    ]);
    const symbolInfoMap = new Map<string, ScipSymbolInformation>([
      ['scip-ts npm pkg 1.0 FileWriter#', makeSymbolInfo('scip-ts npm pkg 1.0 FileWriter#', [
        { symbol: 'scip-ts npm pkg 1.0 IWriter#', isImplementation: true },
      ])],
    ]);
    const symbolDefinitions = new Map([
      [concreteMethod, { filePath: '/src/bar.ts', line: 10, character: 0 }],
    ]);
    const log = getLogger();

    // First run
    const first = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefinitions, 'baseline', 1, log);
    expect(first).toBe(1);

    // Second run — should not duplicate
    const second = materializeVirtualDispatch(db, scipToLoreId, symbolInfoMap, symbolDefinitions, 'baseline', 1, log);
    expect(second).toBe(0);

    // Verify total edges unchanged and original edge intact
    const allVd = db.prepare("SELECT caller_id, callee_id FROM symbol_refs WHERE call_kind = 'virtual_dispatch'").all() as Array<{ caller_id: number; callee_id: number }>;
    expect(allVd.length).toBe(1);
    expect(allVd[0]!.caller_id).toBe(callerId);
    expect(allVd[0]!.callee_id).toBe(concreteMethodId);
  });
});
