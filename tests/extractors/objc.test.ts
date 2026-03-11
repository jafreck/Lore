import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ObjcExtractor } from '../../src/indexer/extractors/objc.js';

const ext = new ObjcExtractor();
const fixture = (name: string) => parseAndExtractStrict('objc', path.join(import.meta.dirname, '../fixtures/objc', name), ext);

describe('ObjC class interface extraction', () => {
  const r = fixture('class-interface.m');
  test('extracts class', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }));
  });
  test('extracts extends relationship', () => {
    expect(r.relationships).toContainEqual(expect.objectContaining({ kind: 'extends', fromSymbol: 'Circle', toSymbol: 'NSObject' }));
  });
});

describe('ObjC class implementation extraction', () => {
  const r = fixture('class-implementation.m');
  test('extracts implementation', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'impl' }));
  });
});

describe('ObjC method extraction', () => {
  const r = fixture('methods.m');
  test('extracts symbols from implementation', () => {
    expect(r.symbols.length).toBeGreaterThan(0);
  });
});

describe('ObjC protocol extraction', () => {
  const r = fixture('protocol.m');
  test('extracts protocol as interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Drawable', kind: 'interface' }));
  });
});

describe('ObjC protocol conformance', () => {
  const r = fixture('conformance.m');
  test('extracts relationship', () => {
    expect(r.relationships.length).toBeGreaterThan(0);
  });
});

describe('ObjC category extraction', () => {
  const r = fixture('category.m');
  test('extracts symbols from category', () => {
    expect(r.symbols.length).toBeGreaterThan(0);
  });
});

describe('ObjC import extraction', () => {
  const r = fixture('imports.m');
  test('extracts preprocessor imports', () => {
    expect(r.imports.some(i => i.source.includes('Foundation'))).toBe(true);
  });
  test('extracts module imports', () => {
    expect(r.imports.some(i => i.source === 'UIKit')).toBe(true);
  });
});

describe('ObjC message expression call-ref', () => {
  const r = fixture('message-callref.m');
  test('extracts message send as call ref', () => {
    expect(r.callRefs.length).toBeGreaterThan(0);
  });
});

describe('ObjC method type refs', () => {
  const r = fixture('typeref-method.m');
  test('extracts symbols from implementation with typed params', () => {
    expect(r.symbols.length).toBeGreaterThan(0);
  });
});

describe('ObjC ivar type refs', () => {
  const r = fixture('typeref-ivar.m');
  test('extracts class interface with ivars', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Foo', kind: 'class' }));
  });
});

describe('ObjC cast type ref', () => {
  const r = fixture('typeref-cast.m');
  test('extracts cast type ref', () => {
    const casts = r.typeRefs.filter(t => t.refKind === 'cast');
    expect(casts).toContainEqual(expect.objectContaining({ typeRaw: 'Circle' }));
  });
});

describe('ObjC category implementation extraction', () => {
  const r = fixture('category-implementation.m');
  test('extracts symbols from category implementation', () => {
    expect(r.symbols.length).toBeGreaterThan(0);
  });
});
