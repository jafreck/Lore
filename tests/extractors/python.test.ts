import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { PythonExtractor } from '../../src/indexer/extractors/python.js';

const ext = new PythonExtractor();
const fixture = (name: string) => parseAndExtractStrict('python', path.join(import.meta.dirname, '../fixtures/python', name), ext);

describe('Python function extraction', () => {
  const r = fixture('function.py');
  test('extracts function', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'greet', kind: 'function' });
  });
});

describe('Python async function extraction', () => {
  const r = fixture('async-function.py');
  test('extracts async function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'fetch_data', kind: 'async_function' }));
  });
});

describe('Python class extraction', () => {
  const r = fixture('class.py');
  test('extracts class', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Animal', kind: 'class' }));
  });
  test('extracts method', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: '__init__', kind: 'function' }));
  });
});

describe('Python class inheritance', () => {
  const r = fixture('inheritance.py');
  test('extracts both classes', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Dog', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Animal', kind: 'class' }));
  });
});

describe('Python import extraction', () => {
  const r = fixture('imports.py');
  test('extracts imports', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'os' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'pathlib', importedNames: ['Path'] }));
  });
  test('extracts wildcard imports', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'os.path', importedNames: ['*'] }));
  });
});

describe('Python call-ref extraction', () => {
  const r = fixture('callref.py');
  test('extracts call ref with callerSymbol', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'greet', callerSymbol: 'main' }));
  });
});

describe('Python type refs', () => {
  const r = fixture('typerefs.py');
  test('extracts symbols from typed function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'load', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Config', kind: 'class' }));
  });
});

describe('Python env-ref extraction', () => {
  const r = fixture('envref.py');
  test('extracts function containing env access', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });
});
