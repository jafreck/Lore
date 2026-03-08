import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtract } from '../helpers/extractorHelper.js';
import { CExtractor } from '../../src/indexer/extractors/c.js';
import { CppExtractor } from '../../src/indexer/extractors/cpp.js';
import { CSharpExtractor } from '../../src/indexer/extractors/csharp.js';
import { DartExtractor } from '../../src/indexer/extractors/dart.js';
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

const dartResult = parseAndExtract(
  'dart',
  path.join(fixtureDir, 'dart/sample.dart'),
  new DartExtractor(),
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
  test.skipIf(!cResult)('symbols', () => {
    expect(cResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!cResult)('imports', () => {
    expect(cResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!cResult)('callRefs', () => {
    expect(cResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!cResult)('callRefs are non-empty', () => {
    expect(cResult!.callRefs.length).toBeGreaterThan(0);
  });

  test.skipIf(!cResult)('extracts macro symbols', () => {
    const macros = cResult!.symbols.filter(s => s.kind === 'macro');
    expect(macros.length).toBeGreaterThan(0);
    expect(macros.map(m => m.name)).toContain('SQUARE');
  });

  test.skipIf(!cResult)('tags macro call-refs with callKind macro', () => {
    const macroRefs = cResult!.callRefs.filter(r => r.callKind === 'macro');
    expect(macroRefs.length).toBeGreaterThan(0);
    expect(macroRefs.some(r => r.calleeRaw === 'SQUARE')).toBe(true);
  });

  test.skipIf(!cResult)('tags indirect call-refs via function pointer', () => {
    const indirectRefs = cResult!.callRefs.filter(r => r.isIndirect === true);
    expect(indirectRefs.length).toBeGreaterThan(0);
    expect(indirectRefs.every(r => r.callKind === 'indirect')).toBe(true);
  });
});

// ─── C++ ──────────────────────────────────────────────────────────────────────

describe('C++ extractor', () => {
  test.skipIf(!cppResult)('symbols', () => {
    expect(cppResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!cppResult)('imports', () => {
    expect(cppResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!cppResult)('callRefs', () => {
    expect(cppResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!cppResult)('callRefs are non-empty', () => {
    expect(cppResult!.callRefs.length).toBeGreaterThan(0);
  });

  test.skipIf(!cppResult)('extracts macro symbols', () => {
    const macros = cppResult!.symbols.filter(s => s.kind === 'macro');
    expect(macros.length).toBeGreaterThan(0);
    expect(macros.map(m => m.name)).toContain('MAX');
  });

  test.skipIf(!cppResult)('tags macro call-refs with callKind macro', () => {
    const macroRefs = cppResult!.callRefs.filter(r => r.callKind === 'macro');
    expect(macroRefs.length).toBeGreaterThan(0);
    expect(macroRefs.some(r => r.calleeRaw === 'MAX')).toBe(true);
  });

  test.skipIf(!cppResult)('tags indirect call-refs via function pointer', () => {
    const indirectRefs = cppResult!.callRefs.filter(r => r.isIndirect === true);
    expect(indirectRefs.length).toBeGreaterThan(0);
    expect(indirectRefs.every(r => r.callKind === 'indirect')).toBe(true);
  });
});

// ─── C# ───────────────────────────────────────────────────────────────────────

describe('C# extractor', () => {
  test.skipIf(!csharpResult)('symbols', () => {
    expect(csharpResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!csharpResult)('imports', () => {
    expect(csharpResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!csharpResult)('callRefs', () => {
    expect(csharpResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!csharpResult)('callRefs are non-empty', () => {
    expect(csharpResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Dart ─────────────────────────────────────────────────────────────────────

describe('Dart extractor', () => {
  test.skipIf(!dartResult)('symbols', () => {
    expect(dartResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!dartResult)('imports', () => {
    expect(dartResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!dartResult)('callRefs', () => {
    expect(dartResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!dartResult)('callRefs are non-empty', () => {
    expect(dartResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Elixir ───────────────────────────────────────────────────────────────────

describe('Elixir extractor', () => {
  test.skipIf(!elixirResult)('symbols', () => {
    expect(elixirResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!elixirResult)('imports', () => {
    expect(elixirResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!elixirResult)('callRefs', () => {
    expect(elixirResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!elixirResult)('callRefs are non-empty', () => {
    expect(elixirResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Elm ──────────────────────────────────────────────────────────────────────

describe('Elm extractor', () => {
  test.skipIf(!elmResult)('symbols', () => {
    expect(elmResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!elmResult)('imports', () => {
    expect(elmResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!elmResult)('callRefs', () => {
    expect(elmResult!.callRefs).toMatchSnapshot();
  });
});

// ─── Haskell ──────────────────────────────────────────────────────────────────

describe('Haskell extractor', () => {
  test.skipIf(!haskellResult)('symbols', () => {
    expect(haskellResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!haskellResult)('imports', () => {
    expect(haskellResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!haskellResult)('callRefs', () => {
    expect(haskellResult!.callRefs).toMatchSnapshot();
  });
});

// ─── Julia ────────────────────────────────────────────────────────────────────

describe('Julia extractor', () => {
  test.skipIf(!juliaResult)('symbols', () => {
    expect(juliaResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!juliaResult)('imports', () => {
    expect(juliaResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!juliaResult)('callRefs', () => {
    expect(juliaResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!juliaResult)('callRefs are non-empty', () => {
    expect(juliaResult!.callRefs.length).toBeGreaterThan(0);
  });
});
