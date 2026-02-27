import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the embedder module so we can observe SentenceTransformersProvider usage
// without spawning a Python subprocess.
vi.mock('../../src/indexer/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/indexer/embedder.js')>();
  const MockProvider = vi.fn().mockImplementation(function (this: Record<string, unknown>, modelName: string) {
    this.modelName = modelName;
    this.dims = 768;
    this.init = vi.fn().mockResolvedValue(undefined);
    this.embed = vi.fn().mockResolvedValue([]);
    this.dispose = vi.fn().mockResolvedValue(undefined);
  });
  return {
    ...actual,
    SentenceTransformersProvider: MockProvider,
  };
});

// Dynamically import after mocks are established.
const { IndexBuilder } = await import('../../src/indexer/index.js');
const { SentenceTransformersProvider, DEFAULT_EMBEDDING_MODEL } = await import('../../src/indexer/embedder.js');

describe('IndexBuilder constructor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a SentenceTransformersProvider with DEFAULT_EMBEDDING_MODEL when no embedder is given', () => {
    new IndexBuilder('/tmp/test.db', { rootDir: '/tmp' });
    expect(SentenceTransformersProvider).toHaveBeenCalledWith(DEFAULT_EMBEDDING_MODEL);
    expect(SentenceTransformersProvider).toHaveBeenCalledTimes(1);
  });

  it('should use the provided embeddingModel string instead of the default', () => {
    const customModel = 'my-org/my-custom-model';
    new IndexBuilder('/tmp/test.db', { rootDir: '/tmp' }, undefined, customModel);
    expect(SentenceTransformersProvider).toHaveBeenCalledWith(customModel);
    expect(SentenceTransformersProvider).toHaveBeenCalledTimes(1);
  });

  it('should use the explicit EmbeddingProvider and not construct SentenceTransformersProvider', () => {
    const mockProvider = {
      modelName: 'explicit-provider',
      dims: 512,
      init: vi.fn(),
      embed: vi.fn().mockResolvedValue([]),
      dispose: vi.fn(),
    };
    new IndexBuilder('/tmp/test.db', { rootDir: '/tmp' }, mockProvider);
    expect(SentenceTransformersProvider).not.toHaveBeenCalled();
  });
});
