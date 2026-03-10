import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersJsProvider,
  buildStructuralEmbeddingText,
} from '../../src/indexer/embedder.js';

describe('DEFAULT_EMBEDDING_MODEL', () => {
  it('should equal the nomic-embed-text-v1.5 model identifier', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('nomic-ai/nomic-embed-text-v1.5');
  });
});

describe('buildStructuralEmbeddingText', () => {
  it('should build newline-separated structural text from signature, resolved metadata, and name', () => {
    expect(
      buildStructuralEmbeddingText({
        name: '  greet ',
        signature: ' function greet(name: string): string ',
        resolvedTypeSignature: ' (name: string) => string ',
        resolvedReturnType: ' string ',
      }),
    ).toBe(
      'function greet(name: string): string\n(name: string) => string\nstring\ngreet',
    );
  });

  it('should remove duplicate parts while preserving the first occurrence order', () => {
    expect(
      buildStructuralEmbeddingText({
        name: 'Result',
        signature: 'Result',
        resolvedTypeSignature: '  Result  ',
        resolvedReturnType: 'Result',
      }),
    ).toBe('Result');
  });

  it('should return an empty string when all candidate parts are blank', () => {
    expect(
      buildStructuralEmbeddingText({
        name: '   ',
        signature: ' ',
        resolvedTypeSignature: '',
        resolvedReturnType: null,
      }),
    ).toBe('');
  });
});

describe('TransformersJsProvider', () => {
  it('should set modelName from constructor argument', () => {
    const provider = new TransformersJsProvider('some-model');
    expect(provider.modelName).toBe('some-model');
  });

  it('should throw from dims getter before init() is called', () => {
    const provider = new TransformersJsProvider('some-model');
    expect(() => provider.dims).toThrow('EmbeddingProvider not initialised');
  });

  it('should return an empty array for embed([]) without requiring init', async () => {
    const provider = new TransformersJsProvider('some-model');
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('should throw from embed() when not yet initialised', async () => {
    const provider = new TransformersJsProvider('some-model');
    await expect(provider.embed(['hello'])).rejects.toThrow('EmbeddingProvider not initialised');
  });

  it('should resolve safely from dispose() when never initialised', async () => {
    const provider = new TransformersJsProvider('some-model');
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});

describe('buildStructuralEmbeddingText — edge cases', () => {
  it('should handle null signature gracefully', () => {
    expect(
      buildStructuralEmbeddingText({
        name: 'myFunc',
        signature: null,
      }),
    ).toBe('myFunc');
  });

  it('should handle undefined optional fields', () => {
    expect(
      buildStructuralEmbeddingText({
        name: 'myFunc',
        signature: 'function myFunc()',
      }),
    ).toBe('function myFunc()\nmyFunc');
  });

  it('should deduplicate when name appears in signature', () => {
    expect(
      buildStructuralEmbeddingText({
        name: 'myFunc',
        signature: 'myFunc',
        resolvedTypeSignature: 'myFunc',
        resolvedReturnType: 'myFunc',
      }),
    ).toBe('myFunc');
  });
});
