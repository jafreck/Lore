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
  it('allows null values for all fields', () => {
    // Compile-time interface check: all fields accept null.
    const metadata: ResolvedTypeMetadata = {
      resolvedTypeSignature: null,
      resolvedReturnType: null,
      definitionUri: null,
      definitionPath: null,
      definitionLine: null,
      definitionCharacter: null,
    };

    expect(metadata.resolvedTypeSignature).toBeNull();
    expect(metadata.resolvedReturnType).toBeNull();
    expect(metadata.definitionUri).toBeNull();
    expect(metadata.definitionPath).toBeNull();
    expect(metadata.definitionLine).toBeNull();
    expect(metadata.definitionCharacter).toBeNull();
  });
});
