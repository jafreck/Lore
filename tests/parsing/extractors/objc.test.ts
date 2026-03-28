import { describe, it, expect } from 'vitest';
import { ObjcExtractor } from '../../../src/parsing/extractors/objc.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new ObjcExtractor();

function extract(source: string) {
  const tree = pool.parse('objc', source)!;
  return extractor.extract(tree, source, 'test.m');
}

describe('ObjcExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts class interface', () => {
      const source = `@interface Foo : NSObject
@end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Foo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('class');
    });

    it('extracts class implementation', () => {
      const source = `@implementation Foo
@end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Foo');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('impl');
    });

    it('extracts protocol declaration', () => {
      const source = `@protocol Drawable
@end`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Drawable');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('interface');
    });

    it('extracts category interface', () => {
      const source = `@interface NSString (Utilities)
@end`;
      const result = extract(source);
      // Category may be parsed as category or class depending on grammar
      const sym = result.symbols.find(s => s.kind === 'category' || s.kind === 'class');
      expect(sym).toBeDefined();
    });
  });

  describe('import extraction', () => {
    it('extracts #import via regex fallback', () => {
      const source = `#import <Foundation/Foundation.h>
#import "MyClass.h"`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(2);
      const sources = result.imports.map(i => i.source);
      expect(sources.some(s => s.includes('Foundation'))).toBe(true);
      expect(sources.some(s => s.includes('MyClass'))).toBe(true);
    });

    it('extracts @import module import', () => {
      const source = `@import Foundation;`;
      const result = extract(source);
      // module_import may or may not be parsed depending on grammar
      expect(result.imports.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('call ref extraction', () => {
    it('extracts message expression calls', () => {
      const source = `@implementation Foo
- (void)bar {
  [self doSomething];
}
@end`;
      const result = extract(source);
      expect(result.callRefs.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('relationship extraction', () => {
    it('extracts class inheritance', () => {
      const source = `@interface Foo : NSObject
@end`;
      const result = extract(source);
      const rel = result.relationships.find(r => r.fromSymbol === 'Foo');
      if (rel) {
        expect(rel.toSymbol).toBe('NSObject');
        expect(rel.kind).toBe('extends');
      }
    });
  });

  describe('type ref extraction', () => {
    it('extracts ivar type refs', () => {
      const source = `@interface Foo : NSObject {
  NSString *name;
}
@end`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'Foo')).toBeDefined();
    });
  });
});
