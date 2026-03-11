import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { JavaScriptExtractor } from '../../src/indexer/extractors/javascript.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('javascript', path.join(fixtureDir, 'javascript/sample.js'), new JavaScriptExtractor());

describe('JavaScript symbols', () => {
  test('extracts exported functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });

  test('extracts class', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Animal', kind: 'class' }));
  });

  test('extracts arrow function exports', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'multiply' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'formatPath' }));
  });
});

describe('JavaScript imports', () => {
  test('extracts named import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'fs' }));
  });

  test('extracts default import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'path' }));
  });

  test('extracts namespace import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'os' }));
  });

  test('extracts require() as import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'utils' }));
  });
});

describe('JavaScript call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});

describe('JavaScript routes', () => {
  test('extracts route registrations', () => {
    expect(result.routes.length).toBeGreaterThan(0);
  });

  test('infers framework names from route receivers', () => {
    const frameworks = new Set(result.routes.map(r => r.framework));
    expect(frameworks).toEqual(new Set(['express', 'koa', 'hono']));
  });

  test('captures route method and path', () => {
    expect(result.routes).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/health', handler: 'greet', framework: 'express' }),
    );
  });
});
