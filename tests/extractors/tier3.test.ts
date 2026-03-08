import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtract } from '../helpers/extractorHelper.js';
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
  test.skipIf(!kotlinResult)('symbols', () => {
    expect(kotlinResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!kotlinResult)('imports', () => {
    expect(kotlinResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!kotlinResult)('callRefs', () => {
    expect(kotlinResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!kotlinResult)('callRefs are non-empty', () => {
    expect(kotlinResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Lua ──────────────────────────────────────────────────────────────────────

describe('Lua extractor', () => {
  test.skipIf(!luaResult)('symbols', () => {
    expect(luaResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!luaResult)('imports', () => {
    expect(luaResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!luaResult)('callRefs', () => {
    expect(luaResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!luaResult)('callRefs are non-empty', () => {
    expect(luaResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Objective-C ──────────────────────────────────────────────────────────────

describe('Objective-C extractor', () => {
  test.skipIf(!objcResult)('symbols', () => {
    expect(objcResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!objcResult)('imports', () => {
    expect(objcResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!objcResult)('callRefs', () => {
    expect(objcResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!objcResult)('callRefs are non-empty', () => {
    expect(objcResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── OCaml ────────────────────────────────────────────────────────────────────

describe('OCaml extractor', () => {
  test.skipIf(!ocamlResult)('symbols', () => {
    expect(ocamlResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!ocamlResult)('imports', () => {
    expect(ocamlResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!ocamlResult)('callRefs', () => {
    expect(ocamlResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!ocamlResult)('callRefs are non-empty', () => {
    expect(ocamlResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── PHP ──────────────────────────────────────────────────────────────────────

describe('PHP extractor', () => {
  test.skipIf(!phpResult)('symbols', () => {
    expect(phpResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!phpResult)('imports', () => {
    expect(phpResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!phpResult)('callRefs', () => {
    expect(phpResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!phpResult)('callRefs are non-empty', () => {
    expect(phpResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Ruby ─────────────────────────────────────────────────────────────────────

describe('Ruby extractor', () => {
  test.skipIf(!rubyResult)('symbols', () => {
    expect(rubyResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!rubyResult)('imports', () => {
    expect(rubyResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!rubyResult)('callRefs', () => {
    expect(rubyResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!rubyResult)('callRefs are non-empty', () => {
    expect(rubyResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Scala ────────────────────────────────────────────────────────────────────

describe('Scala extractor', () => {
  test.skipIf(!scalaResult)('symbols', () => {
    expect(scalaResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!scalaResult)('imports', () => {
    expect(scalaResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!scalaResult)('callRefs', () => {
    expect(scalaResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!scalaResult)('callRefs are non-empty', () => {
    expect(scalaResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Swift ────────────────────────────────────────────────────────────────────

describe('Swift extractor', () => {
  test.skipIf(!swiftResult)('symbols', () => {
    expect(swiftResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!swiftResult)('imports', () => {
    expect(swiftResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!swiftResult)('callRefs', () => {
    expect(swiftResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!swiftResult)('callRefs are non-empty', () => {
    expect(swiftResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Bash ─────────────────────────────────────────────────────────────────────

describe('Bash extractor', () => {
  test.skipIf(!bashResult)('symbols', () => {
    expect(bashResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!bashResult)('imports', () => {
    expect(bashResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!bashResult)('callRefs', () => {
    expect(bashResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!bashResult)('callRefs are non-empty', () => {
    expect(bashResult!.callRefs.length).toBeGreaterThan(0);
  });
});

// ─── Zig ──────────────────────────────────────────────────────────────────────

describe('Zig extractor', () => {
  test.skipIf(!zigResult)('symbols', () => {
    expect(zigResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!zigResult)('imports', () => {
    expect(zigResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!zigResult)('callRefs', () => {
    expect(zigResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!zigResult)('callRefs are non-empty', () => {
    expect(zigResult!.callRefs.length).toBeGreaterThan(0);
  });
});
