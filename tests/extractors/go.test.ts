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

  test('extracts interface with embedding', () => {
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Reader', kind: 'interface' }),
    );
  });

  test('extracts struct declarations', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'struct' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Config', kind: 'struct' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Item', kind: 'struct' }));
  });

  test('extracts type alias', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'ID', kind: 'type' }));
  });

  test('extracts value receiver methods', () => {
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Circle.Area', kind: 'method' }),
    );
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Circle.Perimeter', kind: 'method' }),
    );
  });

  test('extracts pointer receiver method', () => {
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ name: 'Config.Reset', kind: 'method' }),
    );
  });

  test('extracts standalone functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Setup', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'Convert', kind: 'function' }));
  });
});

// ─── Imports ──────────────────────────────────────────────────────────────────

describe('Go imports', () => {
  test('extracts grouped imports', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'fmt' }));
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'math' }));
  });

  test('extracts aliased import', () => {
    expect(result.imports).toContainEqual(expect.objectContaining({ source: 'os' }));
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
  test('extracts field type refs from structs', () => {
    const fieldRefs = result.typeRefs.filter(r => r.refKind === 'field');
    expect(fieldRefs.length).toBeGreaterThan(0);
  });

  test('extracts variable type refs', () => {
    const varRefs = result.typeRefs.filter(r => r.refKind === 'variable');
    expect(varRefs.length).toBeGreaterThan(0);
  });

  test('extracts cast type refs from type assertion', () => {
    const castRefs = result.typeRefs.filter(r => r.refKind === 'cast');
    expect(castRefs.length).toBeGreaterThan(0);
  });

  test('extracts parameter type refs', () => {
    const paramRefs = result.typeRefs.filter(r => r.refKind === 'parameter');
    expect(paramRefs.length).toBeGreaterThan(0);
  });

  test('extracts return type refs', () => {
    const returnRefs = result.typeRefs.filter(r => r.refKind === 'return');
    expect(returnRefs.length).toBeGreaterThan(0);
  });

  test('has at least 15 type refs total', () => {
    expect(result.typeRefs.length).toBeGreaterThanOrEqual(15);
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
