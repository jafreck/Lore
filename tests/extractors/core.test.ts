import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtract } from '../helpers/extractorHelper.js';
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
  test.skipIf(!tsResult)('symbols', () => {
    const symbols = tsResult!.symbols.map(({ astNode: _astNode, ...symbol }) => symbol);
    expect(symbols).toMatchSnapshot();
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

  test.skipIf(!jsRouteResult)('routes', () => {
    expect(jsRouteResult!.routes.length).toBeGreaterThan(0);
  });

  test.skipIf(!jsRouteResult)('should extract route method, path, handler, and middleware', () => {
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

  test.skipIf(!jsResult)('should infer framework names from route receivers', () => {
    const frameworks = new Set(jsResult!.routes.map((route) => route.framework));
    expect(frameworks).toEqual(new Set(['express', 'koa', 'hono']));
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

  test.skipIf(!pyRouteResult)('routes', () => {
    expect(pyRouteResult!.routes.length).toBeGreaterThan(0);
  });

  test.skipIf(!pyRouteResult)('should extract FastAPI route metadata', () => {
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

  test.skipIf(!goRouteResult)('routes', () => {
    expect(goRouteResult!.routes.length).toBeGreaterThan(0);
  });

  test.skipIf(!goRouteResult)('should extract Gin route metadata', () => {
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
