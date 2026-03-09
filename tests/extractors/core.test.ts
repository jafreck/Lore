import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict as parseAndExtract } from '../helpers/extractorHelper.js';
import { ParserPool } from '../../src/indexer/parser.js';
import type { SymbolExtractor } from '../../src/indexer/extractors/types.js';
import { TypeScriptExtractor } from '../../src/indexer/extractors/typescript.js';
import { JavaScriptExtractor } from '../../src/indexer/extractors/javascript.js';
import { PythonExtractor } from '../../src/indexer/extractors/python.js';
import { GoExtractor } from '../../src/indexer/extractors/go.js';
import { RustExtractor } from '../../src/indexer/extractors/rust.js';
import { JavaExtractor } from '../../src/indexer/extractors/java.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const inlinePool = new ParserPool();

function parseInline(
  language: string,
  source: string,
  extractor: SymbolExtractor,
  filePath: string,
) {
  const tree = inlinePool.parse(language, source);
  if (!tree) return null;
  return extractor.extract(tree, source, filePath);
}

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

const jsRouteResult = parseInline(
  'javascript',
  "const app = { get() {}, post() {} }; app.get('/health', handler); app.post('/items', middleware, handler);",
  new JavaScriptExtractor(),
  path.join(fixtureDir, 'javascript/routes.js'),
);

const pyRouteResult = parseInline(
  'python',
  '@app.get("/health")\ndef health():\n    return {}\n',
  new PythonExtractor(),
  path.join(fixtureDir, 'python/routes.py'),
);

const goRouteResult = parseInline(
  'go',
  'package sample\nfunc handler() {}\nfunc register() { r.GET("/health", handler) }\n',
  new GoExtractor(),
  path.join(fixtureDir, 'go/routes.go'),
);

// ─── TypeScript ───────────────────────────────────────────────────────────────

describe('TypeScript extractor', () => {
  test('symbols', () => {
    const symbols = tsResult!.symbols.map(({ astNode: _astNode, ...symbol }) => symbol);
    expect(symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(tsResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(tsResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(tsResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('relationships', () => {
    expect(tsResult!.relationships).toMatchSnapshot();
  });
});

// ─── JavaScript ───────────────────────────────────────────────────────────────

describe('JavaScript extractor', () => {
  test('symbols', () => {
    expect(jsResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(jsResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(jsResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(jsResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('relationships', () => {
    expect(jsResult!.relationships).toMatchSnapshot();
  });

  test('routes', () => {
    expect(jsRouteResult!.routes.length).toBeGreaterThan(0);
  });

  test('should extract route method, path, handler, and middleware', () => {
    const getRoute = jsRouteResult!.routes.find((route) => route.method === 'GET');
    const postRoute = jsRouteResult!.routes.find((route) => route.method === 'POST');

    expect(getRoute).toEqual(
      expect.objectContaining({
        path: '/health',
        handler: 'handler',
        framework: 'express',
      }),
    );
    expect(postRoute).toEqual(
      expect.objectContaining({
        path: '/items',
        middleware: ['middleware'],
      }),
    );
    expect(postRoute?.handler.length).toBeGreaterThan(0);
  });

  test('should infer framework names from route receivers', () => {
    const frameworks = new Set(jsResult!.routes.map((route) => route.framework));
    expect(frameworks).toEqual(new Set(['express', 'koa', 'hono']));
  });
});

// ─── Python ───────────────────────────────────────────────────────────────────

describe('Python extractor', () => {
  test('symbols', () => {
    expect(pyResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(pyResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(pyResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(pyResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('relationships', () => {
    expect(pyResult!.relationships).toMatchSnapshot();
  });

  test('routes', () => {
    expect(pyRouteResult!.routes.length).toBeGreaterThan(0);
  });

  test('should extract FastAPI route metadata', () => {
    expect(pyRouteResult!.routes[0]).toEqual(
      expect.objectContaining({
        method: 'GET',
        handler: 'health',
        framework: 'fastapi',
      }),
    );
    expect(typeof pyRouteResult!.routes[0]!.path).toBe('string');
  });
});

// ─── Go ───────────────────────────────────────────────────────────────────────

describe('Go extractor', () => {
  test('symbols', () => {
    expect(goResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(goResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(goResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(goResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('relationships', () => {
    expect(goResult!.relationships).toMatchSnapshot();
  });

  test('routes', () => {
    expect(goRouteResult!.routes.length).toBeGreaterThan(0);
  });

  test('should extract Gin route metadata', () => {
    expect(goRouteResult!.routes).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/health',
        handler: 'handler',
        framework: 'gin',
      }),
    ]);
  });
});

// ─── Rust ─────────────────────────────────────────────────────────────────────

describe('Rust extractor', () => {
  test('symbols', () => {
    expect(rustResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(rustResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(rustResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(rustResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('relationships', () => {
    expect(rustResult!.relationships).toMatchSnapshot();
  });
});

// ─── Java ─────────────────────────────────────────────────────────────────────

describe('Java extractor', () => {
  test('symbols', () => {
    expect(javaResult!.symbols).toMatchSnapshot();
  });

  test('imports', () => {
    expect(javaResult!.imports).toMatchSnapshot();
  });

  test('callRefs', () => {
    expect(javaResult!.callRefs).toMatchSnapshot();
  });

  test('callRefs are non-empty', () => {
    expect(javaResult!.callRefs.length).toBeGreaterThan(0);
  });

  test('relationships', () => {
    expect(javaResult!.relationships).toMatchSnapshot();
  });
});
