import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { JavaScriptExtractor } from '../../../src/parsing/extractors/javascript.js';

const ext = new JavaScriptExtractor();
const fixture = (name: string) => parseAndExtractStrict('javascript', path.join(import.meta.dirname, '../../fixtures/javascript', name), ext);

describe('JS function extraction', () => {
  const r = fixture('functions.js');
  test('extracts named functions', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('JS arrow function extraction', () => {
  const r = fixture('arrow-function.js');
  test('extracts arrow function from const', () => {
    expect(r.symbols).toHaveLength(1);
    expect(r.symbols[0]).toMatchObject({ name: 'multiply', kind: 'function' });
  });
});

describe('JS class extraction', () => {
  const r = fixture('class.js');
  test('extracts class', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Animal', kind: 'class' }));
  });
});

describe('JS named import', () => {
  const r = fixture('import-named.js');
  test('extracts named import', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]).toMatchObject({ source: 'fs' });
  });
});

describe('JS default import', () => {
  const r = fixture('import-default.js');
  test('extracts default import', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]).toMatchObject({ source: 'path' });
  });
});

describe('JS namespace import', () => {
  const r = fixture('import-namespace.js');
  test('extracts namespace import', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]!.source).toBe('os');
  });
});

describe('JS require import', () => {
  const r = fixture('import-require.js');
  test('extracts require() as import', () => {
    expect(r.imports).toHaveLength(1);
    expect(r.imports[0]).toMatchObject({ source: 'utils' });
  });
});

describe('JS call-ref extraction', () => {
  const r = fixture('callref.js');
  test('extracts call with callerSymbol', () => {
    expect(r.callRefs).toHaveLength(1);
    expect(r.callRefs[0]).toMatchObject({ calleeRaw: 'path.normalize', callerSymbol: 'fmt' });
  });
});
