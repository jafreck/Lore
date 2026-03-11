import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { SwiftExtractor } from '../../src/indexer/extractors/swift.js';

const ext = new SwiftExtractor();
const fixture = (name: string) => parseAndExtractStrict('swift', path.join(import.meta.dirname, '../fixtures/swift', name), ext);

describe('Swift function extraction', () => {
  const r = fixture('function.swift');
  test('extracts function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
});

describe('Swift class extraction', () => {
  const r = fixture('class.swift');
  test('extracts class and method', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Rectangle', kind: 'class' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'area', kind: 'function' }));
  });
});

describe('Swift struct extraction', () => {
  const r = fixture('struct.swift');
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Point' }));
  });
});

describe('Swift protocol extraction', () => {
  const r = fixture('protocol.swift');
  test('extracts protocol as interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }));
  });
});

describe('Swift enum extraction', () => {
  const r = fixture('enum.swift');
  test('extracts enum', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Direction' }));
  });
});

describe('Swift struct conformance', () => {
  const r = fixture('conformance.swift');
  test('extracts relationship', () => {
    expect(r.relationships.length).toBeGreaterThan(0);
    expect(r.relationships[0]).toMatchObject({ fromSymbol: 'Circle', toSymbol: 'Shape' });
  });
});

describe('Swift extension extraction', () => {
  const r = fixture('extension.swift');
  test('extracts symbols from extension', () => {
    expect(r.symbols.length).toBeGreaterThan(0);
  });
});

describe('Swift import extraction', () => {
  const r = fixture('imports.swift');
  test('extracts imports', () => {
    expect(r.imports).toHaveLength(2);
    expect(r.imports).toContainEqual(expect.objectContaining({ source: 'Foundation' }));
  });
});

describe('Swift call-ref extraction', () => {
  const r = fixture('callref.swift');
  test('extracts call ref', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});

describe('Swift type refs', () => {
  const r = fixture('typeref-function.swift');
  test('extracts function with typed parameters', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'load', kind: 'function' }));
  });
});

describe('Swift field type refs', () => {
  const r = fixture('typeref-field.swift');
  test('extracts field type ref', () => {
    const fields = r.typeRefs.filter(t => t.refKind === 'field');
    expect(fields).toContainEqual(expect.objectContaining({ typeRaw: 'Config' }));
  });
});

describe('Swift as-cast type ref', () => {
  const r = fixture('typeref-cast.swift');
  test('extracts cast type ref', () => {
    const casts = r.typeRefs.filter(t => t.refKind === 'cast');
    expect(casts).toHaveLength(1);
  });
});
