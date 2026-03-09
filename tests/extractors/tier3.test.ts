import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict as parseAndExtract } from '../helpers/extractorHelper.js';
import { KotlinExtractor } from '../../src/indexer/extractors/kotlin.js';
import { LuaExtractor } from '../../src/indexer/extractors/lua.js';
import { ObjcExtractor } from '../../src/indexer/extractors/objc.js';
import { OcamlExtractor } from '../../src/indexer/extractors/ocaml.js';
import { PhpExtractor } from '../../src/indexer/extractors/php.js';
import { RubyExtractor } from '../../src/indexer/extractors/ruby.js';
import { ScalaExtractor } from '../../src/indexer/extractors/scala.js';
import { SwiftExtractor } from '../../src/indexer/extractors/swift.js';
import { BashExtractor } from '../../src/indexer/extractors/bash.js';
import { ZigExtractor } from '../../src/indexer/extractors/zig.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');

// Pre-extract results at module load time so test.skipIf can use them.
const kotlinResult = parseAndExtract(
  'kotlin',
  path.join(fixtureDir, 'kotlin/sample.kt'),
  new KotlinExtractor(),
);

const luaResult = parseAndExtract(
  'lua',
  path.join(fixtureDir, 'lua/sample.lua'),
  new LuaExtractor(),
);

const objcResult = parseAndExtract(
  'objc',
  path.join(fixtureDir, 'objc/sample.m'),
  new ObjcExtractor(),
);

const ocamlResult = parseAndExtract(
  'ocaml',
  path.join(fixtureDir, 'ocaml/sample.ml'),
  new OcamlExtractor(),
);

const phpResult = parseAndExtract(
  'php',
  path.join(fixtureDir, 'php/sample.php'),
  new PhpExtractor(),
);

const rubyResult = parseAndExtract(
  'ruby',
  path.join(fixtureDir, 'ruby/sample.rb'),
  new RubyExtractor(),
);

const scalaResult = parseAndExtract(
  'scala',
  path.join(fixtureDir, 'scala/sample.scala'),
  new ScalaExtractor(),
);

const swiftResult = parseAndExtract(
  'swift',
  path.join(fixtureDir, 'swift/sample.swift'),
  new SwiftExtractor(),
);

const bashResult = parseAndExtract(
  'bash',
  path.join(fixtureDir, 'bash/sample.sh'),
  new BashExtractor(),
);

const zigResult = parseAndExtract(
  'zig',
  path.join(fixtureDir, 'zig/sample.zig'),
  new ZigExtractor(),
);

// ─── Kotlin ───────────────────────────────────────────────────────────────────

describe('Kotlin extractor', () => {
  test('symbols', () => {
    expect(kotlinResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(kotlinResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(kotlinResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(kotlinResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Lua ──────────────────────────────────────────────────────────────────────

describe('Lua extractor', () => {
  test('symbols', () => {
    expect(luaResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(luaResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(luaResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(luaResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Objective-C ──────────────────────────────────────────────────────────────

describe('Objective-C extractor', () => {
  test('symbols', () => {
    expect(objcResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(objcResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(objcResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(objcResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── OCaml ────────────────────────────────────────────────────────────────────

describe('OCaml extractor', () => {
  test('symbols', () => {
    expect(ocamlResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(ocamlResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(ocamlResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(ocamlResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── PHP ──────────────────────────────────────────────────────────────────────

describe('PHP extractor', () => {
  test('symbols', () => {
    expect(phpResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(phpResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(phpResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(phpResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Ruby ─────────────────────────────────────────────────────────────────────

describe('Ruby extractor', () => {
  test('symbols', () => {
    expect(rubyResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(rubyResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(rubyResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(rubyResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Scala ────────────────────────────────────────────────────────────────────

describe('Scala extractor', () => {
  test('symbols', () => {
    expect(scalaResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(scalaResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(scalaResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(scalaResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Swift ────────────────────────────────────────────────────────────────────

describe('Swift extractor', () => {
  test('symbols', () => {
    expect(swiftResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(swiftResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(swiftResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(swiftResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Bash ─────────────────────────────────────────────────────────────────────

describe('Bash extractor', () => {
  test('symbols', () => {
    expect(bashResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(bashResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(bashResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(bashResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Zig ──────────────────────────────────────────────────────────────────────

describe('Zig extractor', () => {
  test('symbols', () => {
    expect(zigResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(zigResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(zigResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(zigResult!.callRefs.length).toBeGreaterThan(0);
  });
});
