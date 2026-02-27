import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  Qwen3EmbeddingProvider,
  SentenceTransformersProvider,
} from '../../src/indexer/embedder.js';

describe('DEFAULT_EMBEDDING_MODEL', () => {
  it('should equal the Qwen3-Embedding-4B model identifier', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('Qwen/Qwen3-Embedding-4B');
  });
});

describe('Qwen3EmbeddingProvider', () => {
  it('should return a SentenceTransformersProvider for the 0.6B variant', () => {
    const provider = Qwen3EmbeddingProvider('0.6B');
    expect(provider).toBeInstanceOf(SentenceTransformersProvider);
    expect(provider.modelName).toBe('Qwen/Qwen3-Embedding-0.6B');
  });

  it('should return a SentenceTransformersProvider for the 4B variant', () => {
    const provider = Qwen3EmbeddingProvider('4B');
    expect(provider).toBeInstanceOf(SentenceTransformersProvider);
    expect(provider.modelName).toBe('Qwen/Qwen3-Embedding-4B');
  });

  it('should return a SentenceTransformersProvider for the 8B variant', () => {
    const provider = Qwen3EmbeddingProvider('8B');
    expect(provider).toBeInstanceOf(SentenceTransformersProvider);
    expect(provider.modelName).toBe('Qwen/Qwen3-Embedding-8B');
  });
});

describe('SentenceTransformersProvider', () => {
  it('should set modelName from constructor argument', () => {
    const provider = new SentenceTransformersProvider('some-model');
    expect(provider.modelName).toBe('some-model');
  });

  it('should throw from dims getter before init() is called', () => {
    const provider = new SentenceTransformersProvider('some-model');
    expect(() => provider.dims).toThrow('EmbeddingProvider not initialised');
  });

  it('should return an empty array for embed([]) without requiring init', async () => {
    const provider = new SentenceTransformersProvider('some-model');
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('should throw from embed() when not yet initialised', async () => {
    const provider = new SentenceTransformersProvider('some-model');
    await expect(provider.embed(['hello'])).rejects.toThrow('EmbeddingProvider not initialised');
  });

  it('should resolve safely from dispose() when never initialised', async () => {
    const provider = new SentenceTransformersProvider('some-model');
    await expect(provider.dispose()).resolves.toBeUndefined();
  });
});
