import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { PythonExtractor } from '../../src/indexer/extractors/python.js';
import { ParserPool } from '../../src/indexer/parser.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('python', path.join(fixtureDir, 'python/sample.py'), new PythonExtractor());

describe('Python symbols', () => {
  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts async function', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'fetch_data', kind: 'async_function' }));
  });

  test('extracts classes', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Animal', kind: 'class' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Dog', kind: 'class' }));
  });
});

describe('Python imports', () => {
  test('extracts module imports', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'os' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'sys' }));
  });

  test('extracts from...import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'pathlib' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'typing' }));
  });
});

describe('Python call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Python relationships', () => {
  test('relationships array exists', () => {
    expect(Array.isArray(result.relationships)).toBe(true);
  });
});

describe('Python routes (inline)', () => {
  const pool = new ParserPool();
  const tree = pool.parse('python', '@app.get("/health")\ndef health():\n    return {}\n');
  const routeResult = new PythonExtractor().extract(tree!, '@app.get("/health")\ndef health():\n    return {}\n', 'routes.py');

  test('extracts FastAPI route', () => {
    expect(routeResult.routes.length).toBeGreaterThan(0);
    expect(routeResult.routes[0]).toEqual(
      expect.objectContaining({ method: 'GET', handler: 'health', framework: 'fastapi' }),
    );
  });
});
