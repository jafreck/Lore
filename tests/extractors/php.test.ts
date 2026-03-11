import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { PhpExtractor } from '../../src/indexer/extractors/php.js';

const ext = new PhpExtractor();
const fixture = (name: string) => parseAndExtractStrict('php', path.join(import.meta.dirname, '../fixtures/php', name), ext);

describe('PHP function extraction', () => {
  const r = fixture('function.php');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('PHP class extraction', () => {
  const r = fixture('class.php');
  test('extracts class and method', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
  });
});

describe('PHP interface extraction', () => {
  const r = fixture('interface.php');
  test('extracts interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });
});

describe('PHP trait extraction', () => {
  const r = fixture('trait.php');
  test('extracts trait', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Greetable', kind: 'trait' }));
  });
});

describe('PHP class inheritance', () => {
  const r = fixture('inheritance.php');
  test('extracts extends and implements relationships', () => {
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'Animal' }));
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'implements', fromSymbol: 'Circle', toSymbol: 'Shape' }));
  });
});

describe('PHP use declaration extraction', () => {
  const r = fixture('use-declaration.php');
  test('extracts use declarations', () => {
    expect(r.imports.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PHP call-ref extraction', () => {
  const r = fixture('callref.php');
  test('extracts call ref', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: 'greet' }));
  });
});

describe('PHP new expression call-ref', () => {
  const r = fixture('callref-new.php');
  test('extracts new as call ref', () => {
    expect(r.callRefs).toContainEqual(expect.objectContaining({ calleeRaw: expect.stringContaining('Foo') }));
  });
});

describe('PHP type refs', () => {
  const r = fixture('typerefs.php');
  test('extracts parameter and return type refs', () => {
    expect(r.typeRefs.filter(t => t.refKind === 'parameter')).toContainEqual(expect.objectContaining({ typeRaw: 'Config' }));
    expect(r.typeRefs.filter(t => t.refKind === 'return')).toContainEqual(expect.objectContaining({ typeRaw: 'Config' }));
  });
});
