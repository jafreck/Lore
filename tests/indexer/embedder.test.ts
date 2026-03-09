import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  Qwen3EmbeddingProvider,
  SentenceTransformersProvider,
  buildStructuralEmbeddingText,
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

  it('should accept custom pythonBin argument', () => {
    const provider = new SentenceTransformersProvider('some-model', '/usr/bin/python3.11');
    expect(provider.modelName).toBe('some-model');
  });
});

// ─── SentenceTransformersProvider — subprocess lifecycle ──────────────────────

describe('SentenceTransformersProvider — subprocess lifecycle', () => {
  it('should reject init when the subprocess exits before handshake', async () => {
    const provider = new SentenceTransformersProvider('non-existent-model', 'false');
    await expect(provider.init()).rejects.toThrow();
  });

  it('should complete full init/embed/dispose cycle with mock subprocess', async () => {
    // Create a shell script that mimics the sentence-transformers protocol
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const mockBin = path.join(os.tmpdir(), `mock-python-${Date.now()}.sh`);
    fs.writeFileSync(mockBin, `#!/bin/bash
# Ignore all arguments (the -c BOOTSTRAP_SCRIPT model)
echo '{"dims": 3}'
while IFS= read -r line; do
  echo '{"embeddings": [[0.1, 0.2, 0.3]]}'
done
`, { mode: 0o755 });

    try {
      const provider = new SentenceTransformersProvider('mock-model', mockBin);
      await provider.init();

      expect(provider.dims).toBe(3);

      const embeddings = await provider.embed(['hello world']);
      expect(embeddings).toEqual([[0.1, 0.2, 0.3]]);

      const batchResult = await provider.embed(['a', 'b']);
      expect(batchResult).toEqual([[0.1, 0.2, 0.3]]);

      await provider.dispose();
    } finally {
      fs.unlinkSync(mockBin);
    }
  });

  it('should handle dispose after active subprocess', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const mockBin = path.join(os.tmpdir(), `mock-python-dispose-${Date.now()}.sh`);
    fs.writeFileSync(mockBin, `#!/bin/bash
echo '{"dims": 2}'
while IFS= read -r line; do
  echo '{"embeddings": [[0.5, 0.5]]}'
done
`, { mode: 0o755 });

    try {
      const provider = new SentenceTransformersProvider('mock-model', mockBin);
      await provider.init();
      expect(provider.dims).toBe(2);
      // Dispose with active subprocess
      await provider.dispose();
      // Double dispose is safe
      await provider.dispose();
    } finally {
      fs.unlinkSync(mockBin);
    }
  });

  it('should not re-init if already initialized (idempotent init)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const mockBin = path.join(os.tmpdir(), `mock-python-idem-${Date.now()}.sh`);
    fs.writeFileSync(mockBin, `#!/bin/bash
echo '{"dims": 4}'
while IFS= read -r line; do
  echo '{"embeddings": [[0.1, 0.2, 0.3, 0.4]]}'
done
`, { mode: 0o755 });

    try {
      const provider = new SentenceTransformersProvider('mock-model', mockBin);
      await provider.init();
      expect(provider.dims).toBe(4);
      // Second init should be a no-op
      await provider.init();
      expect(provider.dims).toBe(4);
      await provider.dispose();
    } finally {
      fs.unlinkSync(mockBin);
    }
  });

  it('should handle dispose after failed init gracefully', async () => {
    const provider = new SentenceTransformersProvider('test-model', 'false');
    try { await provider.init(); } catch { /* expected */ }
    await provider.dispose();
    await provider.dispose();
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
