/**
 * Simple LRU cache for query embedding vectors.
 *
 * Backed by a `Map` (insertion-ordered); the oldest entry is evicted once the
 * cache reaches `EMBEDDING_CACHE_MAX` entries.  Reads move the accessed key to
 * the end so it is treated as most-recently used.
 */

const EMBEDDING_CACHE_MAX = 256;
const embeddingCache = new Map<string, number[]>();

export function getCachedEmbedding(key: string): number[] | undefined {
  const vec = embeddingCache.get(key);
  if (vec !== undefined) {
    // Move to end (most recently used)
    embeddingCache.delete(key);
    embeddingCache.set(key, vec);
  }
  return vec;
}

export function setCachedEmbedding(key: string, vec: number[]): void {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    // Delete oldest entry
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, vec);
}
