import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../../helpers/extractorHelper.js';
import { ZigExtractor } from '../../../src/parsing/extractors/zig.js';

const ext = new ZigExtractor();
const fixture = (name: string) => parseAndExtractStrict('zig', path.join(import.meta.dirname, '../../fixtures/zig', name), ext);

describe('Zig function extraction', () => {
  const r = fixture('function.zig');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Zig const struct type', () => {
  const r = fixture('const-struct.zig');
  test('extracts struct const', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point' }));
  });
});

describe('Zig const enum type', () => {
  const r = fixture('const-enum.zig');
  test('extracts enum const', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Color' }));
  });
});

describe('Zig plain const', () => {
  const r = fixture('const-plain.zig');
  test('extracts plain const', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'MAX_SIZE', kind: 'const' }));
  });
});

describe('Zig test extraction', () => {
  const r = fixture('test.zig');
  test('extracts test declaration', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ kind: 'test' }));
  });
});

describe('Zig call-ref extraction', () => {
  const r = fixture('callref.zig');
  test('extracts call ref', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});
