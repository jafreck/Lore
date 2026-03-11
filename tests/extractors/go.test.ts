import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { GoExtractor } from '../../src/indexer/extractors/go.js';

const ext = new GoExtractor();
const fixture = (name: string) => parseAndExtractStrict('go', path.join(import.meta.dirname, '../fixtures/go', name), ext);

describe('Go function extraction', () => {
  const r = fixture('functions.go');
  test('extracts function names and kind', () => {
    expect(r.symbols).toHaveLength(2);
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Greet', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Add', kind: 'function' }));
  });
});

describe('Go method extraction', () => {
  const r = fixture('methods.go');
  test('qualifies value-receiver method', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle.Area', kind: 'method' }));
  });
  test('qualifies pointer-receiver method', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: expect.stringContaining('SetRadius'), kind: 'method' }));
  });
});

describe('Go type declarations', () => {
  const r = fixture('types.go');
  test('extracts interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct' }));
  });
  test('extracts type alias', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'ID', kind: 'type' }));
  });
});

describe('Go grouped imports', () => {
  const r = fixture('imports-grouped.go');
  test('extracts each import spec', () => {
    expect(r.imports).toHaveLength(2);
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'fmt' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'math' }));
  });
});

describe('Go aliased import', () => {
  const r = fixture('imports-aliased.go');
  test('captures alias in importedNames', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]).toMatchObject({ source: 'os', importedNames: ['alias'] });
  });
});

describe('Go call-ref', () => {
  const r = fixture('callref.go');
  test('resolves callerSymbol to enclosing function', () => {
    expect(r.callRefs).toHaveLength(1);
    expect(r.callRefs[0]).toMatchObject({ calleeRaw: 'fmt.Sprintf', callerSymbol: 'Greet' });
  });
});

describe('Go function return type ref', () => {
  const r = fixture('typeref-return.go');
  test('extracts return type ref with enclosingSymbol', () => {
    const returns = r.typeRefs.filter(t => t.refKind === 'return');
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ typeRaw: 'Config', enclosingSymbol: 'Load' });
  });
});

describe('Go named return types', () => {
  const r = fixture('typeref-named-returns.go');
  test('extracts each named return as a separate type ref', () => {
    const returns = r.typeRefs.filter(t => t.refKind === 'return');
    expect(returns.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Go struct field type ref', () => {
  const r = fixture('typeref-field.go');
  test('extracts field type ref for user-defined types', () => {
    const fields = r.typeRefs.filter(t => t.refKind === 'field');
    expect(fields).toContainEqual(expect.objectContaining({ typeRaw: 'Item', enclosingSymbol: 'Config' }));
  });
});

describe('Go variable type ref', () => {
  const r = fixture('typeref-variable.go');
  test('extracts variable type ref', () => {
    const vars = r.typeRefs.filter(t => t.refKind === 'variable');
    expect(vars).toContainEqual(expect.objectContaining({ typeRaw: 'Foo' }));
  });
});

describe('Go type assertion', () => {
  const r = fixture('typeref-assertion.go');
  test('extracts cast type ref', () => {
    const casts = r.typeRefs.filter(t => t.refKind === 'cast');
    expect(casts).toHaveLength(1);
  });
});

describe('Go gin route extraction', () => {
  const r = fixture('routes-gin.go');
  test('extracts routes with method, path, and framework', () => {
    expect(r.routes).toHaveLength(2);
    expect(r.routes).toContainEqual(expect.objectContaining({ method: 'GET', path: '/health', framework: 'gin' }));
    expect(r.routes).toContainEqual(expect.objectContaining({ method: 'POST', path: '/users', framework: 'gin' }));
  });
});

describe('Go gin raw string literal path', () => {
  const r = fixture('routes-gin-raw.go');
  test('handles backtick-quoted paths', () => {
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ method: 'PUT', path: '/items/:id' });
  });
});

describe('Go gin Any method', () => {
  const r = fixture('routes-gin-any.go');
  test('maps Any to ALL', () => {
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0]).toMatchObject({ method: 'ALL', path: '/all' });
  });
});
