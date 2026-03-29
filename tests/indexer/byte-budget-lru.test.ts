import { describe, it, expect, beforeEach } from 'vitest';
import { ByteBudgetLRU } from '../../src/indexer/byte-budget-lru.js';

describe('ByteBudgetLRU', () => {
  let cache: ByteBudgetLRU;

  beforeEach(() => {
    cache = new ByteBudgetLRU(100); // 100-byte budget
  });

  describe('basic operations', () => {
    it('stores and retrieves values', () => {
      cache.set('a', 'hello');
      expect(cache.get('a')).toBe('hello');
    });

    it('returns undefined for missing keys', () => {
      expect(cache.get('missing')).toBeUndefined();
    });

    it('reports correct size', () => {
      cache.set('a', 'x');
      cache.set('b', 'y');
      expect(cache.size).toBe(2);
    });

    it('tracks byte usage', () => {
      cache.set('a', 'hello'); // 5 bytes
      expect(cache.currentBytesUsed).toBe(5);
    });

    it('updates byte usage on overwrite', () => {
      cache.set('a', 'hello'); // 5 bytes
      cache.set('a', 'hi');    // 2 bytes
      expect(cache.currentBytesUsed).toBe(2);
      expect(cache.get('a')).toBe('hi');
    });

    it('works with default budget', () => {
      const defaultCache = new ByteBudgetLRU();
      defaultCache.set('k', 'v');
      expect(defaultCache.get('k')).toBe('v');
    });
  });

  describe('delete', () => {
    it('removes entries and adjusts byte count', () => {
      cache.set('a', 'hello'); // 5 bytes
      expect(cache.delete('a')).toBe(true);
      expect(cache.size).toBe(0);
      expect(cache.currentBytesUsed).toBe(0);
    });

    it('returns false for missing key', () => {
      expect(cache.delete('missing')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all entries and resets bytes to 0', () => {
      cache.set('a', 'hello');
      cache.set('b', 'world');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.currentBytesUsed).toBe(0);
    });
  });

  describe('eviction', () => {
    it('evicts oldest entries when budget exceeded', () => {
      // Fill cache: each value is ~50 bytes
      const v50 = 'x'.repeat(50);
      cache.set('first', v50);
      cache.set('second', v50); // total = 100, fits exactly

      // Push over budget — should evict 'first'
      cache.set('third', 'y');
      expect(cache.has('first')).toBe(false);
      expect(cache.has('second')).toBe(true);
      expect(cache.has('third')).toBe(true);
    });

    it('evicts multiple entries to make room', () => {
      cache.set('a', 'x'.repeat(30));
      cache.set('b', 'x'.repeat(30));
      cache.set('c', 'x'.repeat(30));
      // total = 90 bytes, fits

      // Insert 50 bytes — must evict 'a' and 'b'
      cache.set('d', 'x'.repeat(50));
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('admits a single entry larger than budget', () => {
      const huge = 'x'.repeat(200);
      cache.set('huge', huge);
      expect(cache.get('huge')).toBe(huge);
      expect(cache.size).toBe(1);
    });
  });

  describe('LRU promotion', () => {
    it('get() promotes entry to most-recently-used', () => {
      const v40 = 'x'.repeat(40);
      cache.set('a', v40);
      cache.set('b', v40);
      // total = 80 bytes

      // Access 'a' to promote it
      cache.get('a');

      // Push over budget — should evict 'b' (now oldest), not 'a'
      cache.set('c', v40);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
    });
  });

  describe('multi-byte characters', () => {
    it('tracks byte length, not character count', () => {
      // '€' is 3 bytes in UTF-8
      cache.set('euro', '€');
      expect(cache.currentBytesUsed).toBe(3);
    });
  });

  describe('Map compatibility', () => {
    it('is iterable', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      const entries = [...cache];
      expect(entries).toHaveLength(2);
      expect(entries.map(([k]) => k).sort()).toEqual(['a', 'b']);
    });

    it('works with for...of', () => {
      cache.set('x', 'val');
      const results: string[] = [];
      for (const [key, value] of cache) {
        results.push(`${key}=${value}`);
      }
      expect(results).toEqual(['x=val']);
    });
  });
});
