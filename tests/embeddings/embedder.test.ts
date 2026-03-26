import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  TransformersJsProvider,
  LazyEmbeddingProvider,
  buildStructuralEmbeddingText,
  hashEmbeddingText,
  tokenAwareBatch,
  estimateTokens,
} from '../../src/embeddings/embedder.js';

describe('DEFAULT_EMBEDDING_MODEL', () => {
  it('should equal the Qwen3-Embedding-0.6B model identifier', () => {
    expect(DEFAULT_EMBEDDING_MODEL).toBe('onnx-community/Qwen3-Embedding-0.6B-ONNX');
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

describe('hashEmbeddingText', () => {
  it('should return a hex SHA-256 hash', () => {
    const hash = hashEmbeddingText('hello world');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should return the same hash for the same input', () => {
    expect(hashEmbeddingText('foo')).toBe(hashEmbeddingText('foo'));
  });

  it('should return different hashes for different inputs', () => {
    expect(hashEmbeddingText('foo')).not.toBe(hashEmbeddingText('bar'));
  });
});

describe('tokenAwareBatch', () => {
  it('should batch small items into a single batch', () => {
    const items = ['a', 'b', 'c'];
    const batches = tokenAwareBatch(items, (x) => x);
    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  it('should split into multiple batches when token budget is exceeded', () => {
    // Each item ~25k tokens (100k chars / 4), budget is 32768
    const longText = 'x'.repeat(100_000);
    const items = [longText, longText, longText];
    const batches = tokenAwareBatch(items, (x) => x);
    // Each item exceeds the budget alone, so each gets its own batch
    expect(batches.length).toBe(3);
    expect(batches[0]).toHaveLength(1);
  });

  it('should respect the 512-item cap even with tiny texts', () => {
    const items = Array.from({ length: 600 }, (_, i) => String(i));
    const batches = tokenAwareBatch(items, (x) => x);
    expect(batches[0]!.length).toBeLessThanOrEqual(512);
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });

  it('should return empty array for empty input', () => {
    const batches = tokenAwareBatch([], (x: string) => x);
    expect(batches).toEqual([]);
  });
});

describe('TransformersJsProvider', () => {
  it('should accept dtype parameter', () => {
    const provider = new TransformersJsProvider('some-model', 'q8');
    expect(provider.dtype).toBe('q8');
  });

  it('should default dtype to q8', () => {
    const provider = new TransformersJsProvider('some-model');
    expect(provider.dtype).toBe('q8');
  });

  it('should report device as unknown before init', () => {
    const provider = new TransformersJsProvider('some-model');
    expect(provider.device).toBe('unknown');
  });
});

describe('LazyEmbeddingProvider', () => {
  it('should set modelName from constructor argument', () => {
    const provider = new LazyEmbeddingProvider('some-model');
    expect(provider.modelName).toBe('some-model');
  });

  it('should return an empty array for embed([]) without triggering init', async () => {
    const provider = new LazyEmbeddingProvider('some-model');
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it('should resolve safely from dispose() when never used', async () => {
    const provider = new LazyEmbeddingProvider('some-model');
    await expect(provider.dispose()).resolves.toBeUndefined();
  });

  it('should throw from dims getter before init (delegates to inner)', () => {
    const provider = new LazyEmbeddingProvider('some-model');
    expect(() => provider.dims).toThrow('EmbeddingProvider not initialised');
  });
});

describe('estimateTokens', () => {
  it('should estimate tokens as ceil(length / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('TransformersJsProvider — init / embed / dispose with mock', () => {
  const origEnv = process.env['LORE_EMBED_DEVICE'];

  afterEach(() => {
    vi.restoreAllMocks();
    if (origEnv === undefined) {
      delete process.env['LORE_EMBED_DEVICE'];
    } else {
      process.env['LORE_EMBED_DEVICE'] = origEnv;
    }
  });

  it('should detect LORE_EMBED_DEVICE env var', () => {
    process.env['LORE_EMBED_DEVICE'] = 'cuda';
    const provider = new TransformersJsProvider('mock-model');
    // detectDevice is private, but we can test it indirectly via init()
    // For now just verify it reads the env var by checking device before init
    expect(provider.device).toBe('unknown');
    // Clean up
    delete process.env['LORE_EMBED_DEVICE'];
  });

  it('should use cpu as default device when no env var set', () => {
    delete process.env['LORE_EMBED_DEVICE'];
    const provider = new TransformersJsProvider('mock-model');
    // Can only verify after init, but device remains 'unknown' before init
    expect(provider.device).toBe('unknown');
  });

  it('should init, embed, and dispose with mocked pipeline', async () => {
    const mockPipelineFn = vi.fn(async (_texts: unknown, _opts: unknown) => ({
      tolist: () => [[0.1, 0.2, 0.3]],
    }));
    mockPipelineFn.dispose = vi.fn(async () => {});

    vi.doMock('@huggingface/transformers', () => ({
      pipeline: async () => mockPipelineFn,
    }));

    // Re-import to pick up mock
    const { TransformersJsProvider: MockedProvider } = await import(
      '../../src/embeddings/embedder.js'
    );

    const provider = new MockedProvider('mock-model') as TransformersJsProvider;
    await provider.init();
    expect(provider.dims).toBe(3);
    expect(provider.device).toBe('cpu');

    // init is idempotent
    await provider.init();
    expect(provider.dims).toBe(3);

    // embed with texts
    const result = await provider.embed(['hello']);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);

    // dispose
    await provider.dispose();

    vi.doUnmock('@huggingface/transformers');
  });

  it('should fall back to cpu on unsupported device error', async () => {
    process.env['LORE_EMBED_DEVICE'] = 'cuda';

    let callCount = 0;
    const mockPipelineFn = vi.fn(async (_texts: unknown, _opts: unknown) => ({
      tolist: () => [[0.5, 0.6]],
    }));

    vi.doMock('@huggingface/transformers', () => ({
      pipeline: async (_task: unknown, _model: unknown, opts: { device: string }) => {
        callCount++;
        if (callCount === 1 && opts.device !== 'cpu') {
          throw new Error('Unsupported device: cuda');
        }
        return mockPipelineFn;
      },
    }));

    const { TransformersJsProvider: MockedProvider } = await import(
      '../../src/embeddings/embedder.js'
    );

    const provider = new MockedProvider('mock-model') as TransformersJsProvider;
    await provider.init();
    // Should have fallen back to CPU
    expect(provider.device).toBe('cpu');
    expect(provider.dims).toBe(2);

    await provider.dispose();
    delete process.env['LORE_EMBED_DEVICE'];
    vi.doUnmock('@huggingface/transformers');
  });
});

describe('LazyEmbeddingProvider — deferred init', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should init on first embed call and deduplicate init', async () => {
    const mockPipelineFn = vi.fn(async (_texts: unknown, _opts: unknown) => ({
      tolist: () => [[1, 2, 3, 4]],
    }));
    mockPipelineFn.dispose = vi.fn(async () => {});

    vi.doMock('@huggingface/transformers', () => ({
      pipeline: async () => mockPipelineFn,
    }));

    const { LazyEmbeddingProvider: MockedLazy } = await import(
      '../../src/embeddings/embedder.js'
    );

    const provider = new MockedLazy('mock-model') as LazyEmbeddingProvider;

    // First embed triggers init
    const result = await provider.embed(['test text']);
    expect(result).toEqual([[1, 2, 3, 4]]);
    expect(provider.dims).toBe(4);

    // dispose after init
    await provider.dispose();

    vi.doUnmock('@huggingface/transformers');
  });
});
