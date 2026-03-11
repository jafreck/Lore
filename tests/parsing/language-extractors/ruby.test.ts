import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { RubyExtractor } from '../../../src/parsing/extractors/ruby.js';

const ext = new RubyExtractor();
const fixture = (name: string) => parseAndExtractStrict('ruby', path.join(import.meta.dirname, '../../fixtures/ruby', name), ext);

describe('Ruby function extraction', () => {
  const r = fixture('function.rb');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Ruby class extraction', () => {
  const r = fixture('class.rb');
  test('extracts class and methods', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'self.unit_circle', kind: 'function' }));
  });
});

describe('Ruby module extraction', () => {
  const r = fixture('module.rb');
  test('extracts module', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Geometry', kind: 'module' }));
  });
});

describe('Ruby import extraction', () => {
  const r = fixture('imports.rb');
  test('extracts require and require_relative', () => {
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'json' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'shape' }));
  });
});

describe('Ruby call-ref extraction', () => {
  const r = fixture('callref.rb');
  test('extracts call refs', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});
