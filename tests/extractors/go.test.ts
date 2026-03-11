import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { GoExtractor } from '../../src/indexer/extractors/go.js';
import { ParserPool } from '../../src/indexer/parser.js';
import type { ExtractionResult, SymbolExtractor } from '../../src/indexer/extractors/types.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const pool = new ParserPool();

function fixture(relativePath: string): string {
  return path.join(fixtureDir, relativePath);
}

function parseInline(source: string): ExtractionResult {
  const tree = pool.parse('go', source);
  if (!tree) throw new Error("Go grammar failed to load");
  return new GoExtractor().extract(tree, source, 'test.go');
}

const result = parseAndExtractStrict('go', fixture('go/sample.go'), new GoExtractor());

// ─── Symbols ──────────────────────────────────────────────────────────────────

describe('Go symbols', () => {
  test('extracts interface declaration', () => {
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Shape', kind: 'interface' }),
    );
  });

  test('extracts struct declaration', () => {
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Circle', kind: 'struct' }),
    );
  });

  test('extracts method receivers', () => {
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Circle.Area', kind: 'method' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Circle.Perimeter', kind: 'method' }),
    );
  });

  test('extracts standalone functions', () => {
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Greet', kind: 'function' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Add', kind: 'function' }),
    );
  });
});

// ─── Imports ──────────────────────────────────────────────────────────────────

describe('Go imports', () => {
  test('extracts grouped imports', () => {
    expect(result.imports).toContainEqual(
      expect.objectContaining({ source: 'fmt' }),
    );
    expect(result.imports).toContainEqual(
      expect.objectContaining({ source: 'math' }),
    );
  });
});

// ─── Call refs ────────────────────────────────────────────────────────────────

describe('Go call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });

  test('captures fmt.Sprintf call', () => {
    expect(result.callRefs).toContainEqual(
      expect.objectContaining({ calleeRaw: 'fmt.Sprintf', callerSymbol: 'Greet' }),
    );
  });
});

// ─── Type refs ────────────────────────────────────────────────────────────────

describe('Go type refs', () => {
  test('extracts parameter type refs from functions', () => {
    const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
    expect(paramRefs.length).toBeGreaterThanOrEqual(0);
  });

  test('extracts return type refs from functions', () => {
    const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
    expect(returnRefs.length).toBeGreaterThanOrEqual(0);
  });

  test('all type refs have line numbers', () => {
    for (const ref of result.typeRefs) {
      expect(typeof ref.line).toBe('number');
    }
  });
});

// ─── Routes (inline) ─────────────────────────────────────────────────────────

describe('Go gin routes', () => {
  const routeResult = parseInline(
    'package sample\nfunc handler() {}\nfunc register() { r.GET("/health", handler) }\n',
  );

  test('extracts gin route registration', () => {
    expect(routeResult.routes.length).toBeGreaterThan(0);
  });

  test('captures route method, path, handler, and framework', () => {
    expect(routeResult.routes).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/health',
        handler: 'handler',
        framework: 'gin',
      }),
    );
  });
});
