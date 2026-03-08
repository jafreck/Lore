import { describe, it, expect } from 'vitest';
import { normalizeTypeName } from '../../src/indexer/call-graph.js';

describe('normalizeTypeName', () => {
  it('should strip pointer suffix', () => {
    expect(normalizeTypeName('ZSTD_CCtx*')).toBe('ZSTD_CCtx');
  });

  it('should strip const qualifier and pointer', () => {
    expect(normalizeTypeName('const ZSTD_CCtx*')).toBe('ZSTD_CCtx');
  });

  it('should strip struct keyword', () => {
    expect(normalizeTypeName('struct Foo')).toBe('Foo');
  });

  it('should strip enum keyword', () => {
    expect(normalizeTypeName('enum Bar')).toBe('Bar');
  });

  it('should strip Rust &mut reference', () => {
    expect(normalizeTypeName('&mut Foo')).toBe('Foo');
  });

  it('should strip Rust lifetime annotation', () => {
    expect(normalizeTypeName("&'a Foo")).toBe('Foo');
  });

  it('should strip Rust static mut lifetime', () => {
    expect(normalizeTypeName("&'static mut Bar")).toBe('Bar');
  });

  it('should truncate at generic args', () => {
    expect(normalizeTypeName('Vec<MyStruct>')).toBe('Vec');
  });

  it('should take last segment after :: for std::vector<int>', () => {
    expect(normalizeTypeName('std::vector<int>')).toBe('vector');
  });

  it('should take last segment after :: for crate::types::Foo', () => {
    expect(normalizeTypeName('crate::types::Foo')).toBe('Foo');
  });

  it('should take last segment after . for MyModule.MyType', () => {
    expect(normalizeTypeName('MyModule.MyType')).toBe('MyType');
  });

  it('should truncate nested generics', () => {
    expect(normalizeTypeName('Option<Box<MyStruct>>')).toBe('Option');
  });

  it('should preserve unsigned int (compound C type)', () => {
    expect(normalizeTypeName('unsigned int')).toBe('unsigned int');
  });

  it('should preserve int32_t', () => {
    expect(normalizeTypeName('int32_t')).toBe('int32_t');
  });

  it('should return empty for empty string', () => {
    expect(normalizeTypeName('')).toBe('');
  });

  it('should return bare name unchanged', () => {
    expect(normalizeTypeName('MyType')).toBe('MyType');
  });

  it('should handle nested generics A<B<C>>', () => {
    expect(normalizeTypeName('A<B<C>>')).toBe('A');
  });

  it('should handle Rust &', () => {
    expect(normalizeTypeName('&Foo')).toBe('Foo');
  });

  it('should preserve long long (C compound type)', () => {
    expect(normalizeTypeName('long long')).toBe('long long');
  });

  it('should handle C function pointer void (*)(int) → empty', () => {
    expect(normalizeTypeName('void (*)(int)')).toBe('');
  });

  it('should strip array suffix', () => {
    expect(normalizeTypeName('int[]')).toBe('int');
  });

  it('should strip volatile qualifier', () => {
    expect(normalizeTypeName('volatile int*')).toBe('int');
  });
});
