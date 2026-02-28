import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtract } from '../helpers/extractorHelper.js';
import { TypeScriptExtractor } from '../../src/indexer/extractors/typescript.js';
import { JavaScriptExtractor } from '../../src/indexer/extractors/javascript.js';
import { PythonExtractor } from '../../src/indexer/extractors/python.js';
import { GoExtractor } from '../../src/indexer/extractors/go.js';
import { RustExtractor } from '../../src/indexer/extractors/rust.js';
import { JavaExtractor } from '../../src/indexer/extractors/java.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');

// Pre-extract results at module load time so test.skipIf can use them.
const tsResult = parseAndExtract(
  'typescript',
  path.join(fixtureDir, 'typescript/sample.ts'),
  new TypeScriptExtractor(),
);

const jsResult = parseAndExtract(
  'javascript',
  path.join(fixtureDir, 'javascript/sample.js'),
  new JavaScriptExtractor(),
);

const pyResult = parseAndExtract(
  'python',
  path.join(fixtureDir, 'python/sample.py'),
  new PythonExtractor(),
);

const goResult = parseAndExtract(
  'go',
  path.join(fixtureDir, 'go/sample.go'),
  new GoExtractor(),
);

const rustResult = parseAndExtract(
  'rust',
  path.join(fixtureDir, 'rust/sample.rs'),
  new RustExtractor(),
);

const javaResult = parseAndExtract(
  'java',
  path.join(fixtureDir, 'java/sample.java'),
  new JavaExtractor(),
);

// ─── TypeScript ───────────────────────────────────────────────────────────────

describe('TypeScript extractor', () => {
  test.skipIf(!tsResult)('symbols', () => {
    expect(tsResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!tsResult)('imports', () => {
    expect(tsResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!tsResult)('callRefs', () => {
    expect(tsResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!tsResult)('relationships', () => {
    expect(tsResult!.relationships).toMatchSnapshot();
  });
});

// ─── JavaScript ───────────────────────────────────────────────────────────────

describe('JavaScript extractor', () => {
  test.skipIf(!jsResult)('symbols', () => {
    expect(jsResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!jsResult)('imports', () => {
    expect(jsResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!jsResult)('callRefs', () => {
    expect(jsResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!jsResult)('relationships', () => {
    expect(jsResult!.relationships).toMatchSnapshot();
  });
});

// ─── Python ───────────────────────────────────────────────────────────────────

describe('Python extractor', () => {
  test.skipIf(!pyResult)('symbols', () => {
    expect(pyResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!pyResult)('imports', () => {
    expect(pyResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!pyResult)('callRefs', () => {
    expect(pyResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!pyResult)('relationships', () => {
    expect(pyResult!.relationships).toMatchSnapshot();
  });
});

// ─── Go ───────────────────────────────────────────────────────────────────────

describe('Go extractor', () => {
  test.skipIf(!goResult)('symbols', () => {
    expect(goResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!goResult)('imports', () => {
    expect(goResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!goResult)('callRefs', () => {
    expect(goResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!goResult)('relationships', () => {
    expect(goResult!.relationships).toMatchSnapshot();
  });
});

// ─── Rust ─────────────────────────────────────────────────────────────────────

describe('Rust extractor', () => {
  test.skipIf(!rustResult)('symbols', () => {
    expect(rustResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!rustResult)('imports', () => {
    expect(rustResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!rustResult)('callRefs', () => {
    expect(rustResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!rustResult)('relationships', () => {
    expect(rustResult!.relationships).toMatchSnapshot();
  });
});

// ─── Java ─────────────────────────────────────────────────────────────────────

describe('Java extractor', () => {
  test.skipIf(!javaResult)('symbols', () => {
    expect(javaResult!.symbols).toMatchSnapshot();
  });

  test.skipIf(!javaResult)('imports', () => {
    expect(javaResult!.imports).toMatchSnapshot();
  });

  test.skipIf(!javaResult)('callRefs', () => {
    expect(javaResult!.callRefs).toMatchSnapshot();
  });

  test.skipIf(!javaResult)('relationships', () => {
    expect(javaResult!.relationships).toMatchSnapshot();
  });
});
