import { describe, it, expect } from 'vitest';
import {
  buildStructuralEmbeddingText,
  hashEmbeddingText,
  estimateTokens,
  tokenAwareBatch,
  MAX_BATCH_TOKENS,
  MAX_BATCH_ITEMS,
  DEFAULT_EMBEDDING_MODEL,
  TransformersJsProvider,
  LazyEmbeddingProvider,
  type StructuralEmbeddingInput,
} from '../../src/embeddings/embedder.js';

// ─── buildStructuralEmbeddingText ─────────────────────────────────────────────

describe('buildStructuralEmbeddingText', () => {
  it('combines signature, resolved types, and name', () => {
    const input: StructuralEmbeddingInput = {
      name: 'myFunction',
      signature: 'function myFunction(x: number): string',
      resolvedTypeSignature: '(x: number) => string',
      resolvedReturnType: 'string',
    };
    const result = buildStructuralEmbeddingText(input);
    expect(result).toContain('myFunction');
    expect(result).toContain('function myFunction(x: number): string');
    expect(result).toContain('(x: number) => string');
    expect(result).toContain('string');
  });

  it('handles null signature', () => {
    const input: StructuralEmbeddingInput = {
      name: 'helper',
      signature: null,
    };
    const result = buildStructuralEmbeddingText(input);
    expect(result).toBe('helper');
  });

  it('deduplicates repeated parts', () => {
    const input: StructuralEmbeddingInput = {
      name: 'foo',
      signature: 'foo',
      resolvedTypeSignature: 'foo',
    };
    const result = buildStructuralEmbeddingText(input);
    expect(result).toBe('foo');
  });

  it('filters empty strings', () => {
    const input: StructuralEmbeddingInput = {
      name: 'test',
      signature: '  ',
      resolvedReturnType: '',
    };
    const result = buildStructuralEmbeddingText(input);
    expect(result).toBe('test');
  });

  it('trims whitespace from parts', () => {
    const input: StructuralEmbeddingInput = {
      name: '  myFunc  ',
      signature: '  function myFunc(): void  ',
    };
    const result = buildStructuralEmbeddingText(input);
    expect(result).toContain('function myFunc(): void');
    expect(result).toContain('myFunc');
  });
});

// ─── hashEmbeddingText ────────────────────────────────────────────────────────

describe('hashEmbeddingText', () => {
  it('returns a SHA-256 hex string', () => {
    const hash = hashEmbeddingText('hello world');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same input', () => {
    expect(hashEmbeddingText('test')).toBe(hashEmbeddingText('test'));
  });

  it('returns different hashes for different inputs', () => {
    expect(hashEmbeddingText('a')).not.toBe(hashEmbeddingText('b'));
  });

  it('handles empty string', () => {
    const hash = hashEmbeddingText('');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── estimateTokens ──────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('uses ~4 chars/token heuristic', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('rounds up', () => {
    expect(estimateTokens('abc')).toBe(1); // 3/4 = 0.75 -> ceil = 1
    expect(estimateTokens('abcde')).toBe(2); // 5/4 = 1.25 -> ceil = 2
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

// ─── tokenAwareBatch ──────────────────────────────────────────────────────────

describe('tokenAwareBatch', () => {
  const getText = (item: string) => item;

  it('groups small items into one batch', () => {
    const items = ['a', 'b', 'c', 'd'];
    const batches = tokenAwareBatch(items, getText);
    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual(items);
  });

  it('splits when exceeding MAX_BATCH_TOKENS', () => {
    // Create items that together exceed the token budget
    const bigText = 'x'.repeat(MAX_BATCH_TOKENS * 4); // Way over budget
    const items = [bigText, 'small'];
    const batches = tokenAwareBatch(items, getText);
    // The big text gets its own batch, then small goes in the next
    expect(batches.length).toBe(2);
  });

  it('handles empty array', () => {
    const batches = tokenAwareBatch([], getText);
    expect(batches).toEqual([]);
  });

  it('puts oversized single item in its own batch', () => {
    const huge = 'y'.repeat(MAX_BATCH_TOKENS * 8);
    const items = ['small1', huge, 'small2'];
    const batches = tokenAwareBatch(items, getText);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    // The huge item should have its own batch
    const hugeBatch = batches.find((b) => b.includes(huge));
    expect(hugeBatch).toBeDefined();
  });

  it('respects MAX_BATCH_ITEMS', () => {
    // Create more items than MAX_BATCH_ITEMS, each tiny
    const items = Array.from({ length: MAX_BATCH_ITEMS + 10 }, (_, i) => `${i}`);
    const batches = tokenAwareBatch(items, getText);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0]!.length).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
  });

  it('works with custom getText function', () => {
    const items = [{ text: 'hello' }, { text: 'world' }];
    const batches = tokenAwareBatch(items, (item) => item.text);
    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual(items);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_BATCH_TOKENS is a positive number', () => {
    expect(MAX_BATCH_TOKENS).toBeGreaterThan(0);
    expect(typeof MAX_BATCH_TOKENS).toBe('number');
  });

  it('MAX_BATCH_ITEMS is a positive number', () => {
    expect(MAX_BATCH_ITEMS).toBeGreaterThan(0);
    expect(typeof MAX_BATCH_ITEMS).toBe('number');
  });

  it('DEFAULT_EMBEDDING_MODEL is a non-empty string', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBeDefined();
    expect(typeof DEFAULT_EMBEDDING_MODEL).toBe('string');
    expect(DEFAULT_EMBEDDING_MODEL.length).toBeGreaterThan(0);
  });

  it('MAX_BATCH_TOKENS is 32768', () => {
    expect(MAX_BATCH_TOKENS).toBe(32_768);
  });

  it('MAX_BATCH_ITEMS is 512', () => {
    expect(MAX_BATCH_ITEMS).toBe(512);
  });
});

// ─── TransformersJsProvider ──────────────────────────────────────────────────

describe('TransformersJsProvider', () => {
  it('constructor sets modelName', () => {
    const provider = new TransformersJsProvider('test-model');
    expect(provider.modelName).toBe('test-model');
  });

  it('constructor defaults dtype to q8', () => {
    const provider = new TransformersJsProvider('test-model');
    expect(provider.dtype).toBe('q8');
  });

  it('constructor accepts explicit dtype', () => {
    const provider = new TransformersJsProvider('test-model', 'fp16');
    expect(provider.dtype).toBe('fp16');
  });

  it('dims throws before init', () => {
    const provider = new TransformersJsProvider('test-model');
    expect(() => provider.dims).toThrow('not initialised');
  });

  it('device returns unknown before init', () => {
    const provider = new TransformersJsProvider('test-model');
    expect(provider.device).toBe('unknown');
  });

  it('embed throws before init', async () => {
    const provider = new TransformersJsProvider('test-model');
    await expect(provider.embed(['test'])).rejects.toThrow('not initialised');
  });

  it('embed returns empty array for empty input after (conceptual) init', async () => {
    const provider = new TransformersJsProvider('test-model');
    // embed([]) should short-circuit without needing init
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('dispose is safe without init', async () => {
    const provider = new TransformersJsProvider('test-model');
    await expect(provider.dispose()).resolves.not.toThrow();
  });
});

// ─── LazyEmbeddingProvider ──────────────────────────────────────────────────

describe('LazyEmbeddingProvider', () => {
  it('constructor sets modelName', () => {
    const provider = new LazyEmbeddingProvider('test-model');
    expect(provider.modelName).toBe('test-model');
  });

  it('dims throws before init (delegates to inner)', () => {
    const provider = new LazyEmbeddingProvider('test-model');
    expect(() => provider.dims).toThrow('not initialised');
  });

  it('embed returns empty array for empty input', async () => {
    const provider = new LazyEmbeddingProvider('test-model');
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('dispose is safe without init', async () => {
    const provider = new LazyEmbeddingProvider('test-model');
    await expect(provider.dispose()).resolves.not.toThrow();
  });

  it('dispose is safe after failed init', async () => {
    const provider = new LazyEmbeddingProvider('nonexistent-model-xxx');
    // init will fail since model doesn't exist
    try { await provider.init(); } catch { /* expected */ }
    await expect(provider.dispose()).resolves.not.toThrow();
  });
});
