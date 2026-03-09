import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict as parseAndExtract } from '../helpers/extractorHelper.js';
import { CExtractor } from '../../src/indexer/extractors/c.js';
import { CppExtractor } from '../../src/indexer/extractors/cpp.js';
import { CSharpExtractor } from '../../src/indexer/extractors/csharp.js';
import { ElixirExtractor } from '../../src/indexer/extractors/elixir.js';
import { ElmExtractor } from '../../src/indexer/extractors/elm.js';
import { HaskellExtractor } from '../../src/indexer/extractors/haskell.js';
import { JuliaExtractor } from '../../src/indexer/extractors/julia.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');

const cResult = parseAndExtract(
  'c',
  path.join(fixtureDir, 'c/sample.c'),
  new CExtractor(),
);

const cHeaderResult = parseAndExtract(
  'c',
  path.join(fixtureDir, 'c/sample.h'),
  new CExtractor(),
);

const cppResult = parseAndExtract(
  'cpp',
  path.join(fixtureDir, 'cpp/sample.cpp'),
  new CppExtractor(),
);

const csharpResult = parseAndExtract(
  'csharp',
  path.join(fixtureDir, 'csharp/sample.cs'),
  new CSharpExtractor(),
);

const elixirResult = parseAndExtract(
  'elixir',
  path.join(fixtureDir, 'elixir/sample.ex'),
  new ElixirExtractor(),
);

const elmResult = parseAndExtract(
  'elm',
  path.join(fixtureDir, 'elm/sample.elm'),
  new ElmExtractor(),
);

const haskellResult = parseAndExtract(
  'haskell',
  path.join(fixtureDir, 'haskell/sample.hs'),
  new HaskellExtractor(),
);

const juliaResult = parseAndExtract(
  'julia',
  path.join(fixtureDir, 'julia/sample.jl'),
  new JuliaExtractor(),
);

// ─── C ────────────────────────────────────────────────────────────────────────

describe('C extractor', () => {
  test('symbols', () => {
    expect(cResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(cResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(cResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(cResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('extracts macro symbols', () => {
    const macros = cResult!.symbols.filter(s => s.kind === 'macro');
    expect(macros.length).toBeGreaterThan(0);
    expect(macros.map(m => m.name)).toContain('SQUARE');
  });

  test('tags macro call-refs with callKind macro', () => {
    const macroRefs = cResult!.callRefs.filter(r => r.callKind === 'macro');
    expect(macroRefs.length).toBeGreaterThan(0);
    expect(macroRefs.some(r => r.calleeRaw === 'SQUARE')).toBe(true);
  });

  test('tags indirect call-refs via function pointer', () => {
    const indirectRefs = cResult!.callRefs.filter(r => r.isIndirect === true);
    expect(indirectRefs.length).toBeGreaterThan(0);
    expect(indirectRefs.every(r => r.callKind === 'indirect')).toBe(true);
  });
});

// ─── C header ─────────────────────────────────────────────────────────────────

describe('C extractor (header)', () => {
  test('symbols', () => {
    expect(cHeaderResult!.symbols).toMatchSnapshot();
  });

  test('extracts function declarations (prototypes)', () => {
    const funcs = cHeaderResult!.symbols.filter(s => s.kind === 'function');
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs.map(f => f.name)).toEqual(
      expect.arrayContaining(['buffer_create', 'buffer_destroy', 'buffer_append', 'buffer_remaining', 'buffer_printf', 'buffer_is_empty']),
    );
  });

  test('extracts struct, enum, typedef, and macro symbols', () => {
    expect(cHeaderResult!.symbols.some(s => s.kind === 'struct' && s.name === 'Buffer')).toBe(true);
    expect(cHeaderResult!.symbols.some(s => s.kind === 'enum' && s.name === 'Status')).toBe(true);
    expect(cHeaderResult!.symbols.some(s => s.kind === 'typedef')).toBe(true);
    expect(cHeaderResult!.symbols.some(s => s.kind === 'macro' && s.name === 'MAX_SIZE')).toBe(true);
    expect(cHeaderResult!.symbols.some(s => s.kind === 'macro' && s.name === 'ALIGN')).toBe(true);
  });

  test('imports', () => {
    expect(cHeaderResult!.imports).toMatchSnapshot();
  });

  test('extracts type-refs from function declarations', () => {
    expect(cHeaderResult!.typeRefs.length).toBeGreaterThan(0);
    const typeNames = cHeaderResult!.typeRefs.map(r => r.typeRaw);
    expect(typeNames).toEqual(expect.arrayContaining(['Buffer']));
  });
});

// ─── C++ ──────────────────────────────────────────────────────────────────────

describe('C++ extractor', () => {
  test('symbols', () => {
    expect(cppResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(cppResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(cppResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(cppResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('extracts macro symbols', () => {
    const macros = cppResult!.symbols.filter(s => s.kind === 'macro');
    expect(macros.length).toBeGreaterThan(0);
    expect(macros.map(m => m.name)).toContain('MAX');
  });

  test('tags macro call-refs with callKind macro', () => {
    const macroRefs = cppResult!.callRefs.filter(r => r.callKind === 'macro');
    expect(macroRefs.length).toBeGreaterThan(0);
    expect(macroRefs.some(r => r.calleeRaw === 'MAX')).toBe(true);
  });

  test('tags indirect call-refs via function pointer', () => {
    const indirectRefs = cppResult!.callRefs.filter(r => r.isIndirect === true);
    expect(indirectRefs.length).toBeGreaterThan(0);
    expect(indirectRefs.every(r => r.callKind === 'indirect')).toBe(true);
  });
});

// ─── C# ───────────────────────────────────────────────────────────────────────

describe('C# extractor', () => {
  test('symbols', () => {
    expect(csharpResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(csharpResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(csharpResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(csharpResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Elixir ───────────────────────────────────────────────────────────────────

describe('Elixir extractor', () => {
  test('symbols', () => {
    expect(elixirResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(elixirResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(elixirResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(elixirResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Elm ──────────────────────────────────────────────────────────────────────

describe('Elm extractor', () => {
  test('symbols', () => {
    expect(elmResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(elmResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(elmResult!.callRefs).toMatchSnapshot();
  });
});

// ─── Haskell ──────────────────────────────────────────────────────────────────

describe('Haskell extractor', () => {
  test('symbols', () => {
    expect(haskellResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(haskellResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(haskellResult!.callRefs).toMatchSnapshot();
  });
});

// ─── Julia ────────────────────────────────────────────────────────────────────

describe('Julia extractor', () => {
  test('symbols', () => {
    expect(juliaResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(juliaResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(juliaResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(juliaResult!.callRefs.length).toBeGreaterThan(0);
  });
});
