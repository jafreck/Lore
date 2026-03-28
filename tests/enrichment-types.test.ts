import { describe, it, expect } from 'vitest';
import { extractReturnType, type ResolvedTypeMetadata } from '../src/enrichment-types.js';

describe('extractReturnType', () => {
  it('returns null for null input', () => {
    expect(extractReturnType(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractReturnType('')).toBeNull();
  });

  it('extracts return type from function signature', () => {
    expect(extractReturnType('function foo(): string')).toBe('string');
  });

  it('extracts return type from method with params', () => {
    expect(extractReturnType('doStuff(a: number, b: string): boolean')).toBe('boolean');
  });

  it('extracts return type from arrow-style signature', () => {
    expect(extractReturnType('fn process(input: &str) -> Result<String, Error>')).toBe('Result<String, Error>');
  });

  it('extracts return type from Python-style colon annotation', () => {
    expect(extractReturnType('def greet(name: str): str')).toBe('str');
  });

  it('handles multi-line signature (uses first line)', () => {
    const sig = 'function complex(\n  a: number,\n  b: string\n): void';
    // First line is "function complex("
    expect(extractReturnType(sig)).toBeNull();
  });

  it('handles signature with no return type', () => {
    expect(extractReturnType('function noReturn()')).toBeNull();
  });

  it('handles complex generic return types', () => {
    expect(extractReturnType('async function fetch(): Promise<Response>')).toBe('Promise<Response>');
  });

  it('handles void return type', () => {
    expect(extractReturnType('function noop(): void')).toBe('void');
  });

  it('returns null for single word', () => {
    expect(extractReturnType('MyClass')).toBeNull();
  });
});

describe('ResolvedTypeMetadata', () => {
  it('has the expected shape', () => {
    const metadata: ResolvedTypeMetadata = {
      resolvedTypeSignature: 'function foo(): string',
      resolvedReturnType: 'string',
      definitionUri: 'file:///src/foo.ts',
      definitionPath: 'src/foo.ts',
      definitionLine: 10,
      definitionCharacter: 5,
    };

    expect(metadata.resolvedTypeSignature).toBe('function foo(): string');
    expect(metadata.resolvedReturnType).toBe('string');
    expect(metadata.definitionUri).toBe('file:///src/foo.ts');
    expect(metadata.definitionPath).toBe('src/foo.ts');
    expect(metadata.definitionLine).toBe(10);
    expect(metadata.definitionCharacter).toBe(5);
  });

  it('allows null values', () => {
    const metadata: ResolvedTypeMetadata = {
      resolvedTypeSignature: null,
      resolvedReturnType: null,
      definitionUri: null,
      definitionPath: null,
      definitionLine: null,
      definitionCharacter: null,
    };

    expect(metadata.resolvedTypeSignature).toBeNull();
    expect(metadata.definitionLine).toBeNull();
  });
});
