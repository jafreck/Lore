import { describe, it, expect } from 'vitest';
import { ByteBudgetLRU } from '../../src/indexer/byte-budget-lru.js';

describe('ByteBudgetLRU', () => {
  it('should behave like a Map for basic get/set/has/size', () => {
    const cache = new ByteBudgetLRU();
    expect(cache.size).toBe(0);

    cache.set('a', 'hello');
    expect(cache.has('a')).toBe(true);
    expect(cache.get('a')).toBe('hello');
    expect(cache.size).toBe(1);

    cache.set('b', 'world');
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBe('world');
  });

  it('should clear all entries and reset byte counter', () => {
    const cache = new ByteBudgetLRU();
    cache.set('x', 'some content');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.currentBytesUsed).toBe(0);
  });

  it('should track currentBytesUsed accurately', () => {
    const cache = new ByteBudgetLRU();
    const value = 'hello'; // 5 bytes (ASCII)
    cache.set('k', value);
    expect(cache.currentBytesUsed).toBe(Buffer.byteLength(value, 'utf8'));
  });

  it('should update byte count when overwriting an existing key', () => {
    const cache = new ByteBudgetLRU();
    cache.set('k', 'abc'); // 3 bytes
    cache.set('k', 'hello world'); // 11 bytes — replaces previous
    expect(cache.size).toBe(1);
    expect(cache.currentBytesUsed).toBe(Buffer.byteLength('hello world', 'utf8'));
  });

  it('should evict oldest entry when budget is exceeded', () => {
    // Budget of 10 bytes
    const cache = new ByteBudgetLRU(10);

    cache.set('a', '12345'); // 5 bytes → total 5
    cache.set('b', '67890'); // 5 bytes → total 10

    // Adding 'c' (5 bytes) would exceed budget — should evict 'a' first
    cache.set('c', 'abcde');

    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.currentBytesUsed).toBeLessThanOrEqual(10);
  });

  it('should promote accessed entry to most-recently-used on get', () => {
    // Budget of 10 bytes, two 5-byte entries fill it up
    const cache = new ByteBudgetLRU(10);

    cache.set('a', '12345'); // inserted first → oldest
    cache.set('b', '67890');

    // Access 'a' — it should now be MRU, so 'b' becomes the eviction candidate
    cache.get('a');

    // Adding 'c' (5 bytes) should evict 'b', not 'a'
    cache.set('c', 'abcde');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('should admit a single entry that exceeds the total budget', () => {
    // Budget of 3 bytes, value is 5 bytes — should still be stored
    const cache = new ByteBudgetLRU(3);
    cache.set('big', 'hello');
    expect(cache.has('big')).toBe(true);
    expect(cache.get('big')).toBe('hello');
  });

  it('should delete an entry and reduce currentBytesUsed', () => {
    const cache = new ByteBudgetLRU();
    cache.set('x', 'data');
    const before = cache.currentBytesUsed;
    cache.delete('x');
    expect(cache.has('x')).toBe(false);
    expect(cache.currentBytesUsed).toBe(before - Buffer.byteLength('data', 'utf8'));
    expect(cache.currentBytesUsed).toBe(0);
  });

  it('should delete a missing key without changing byte count', () => {
    const cache = new ByteBudgetLRU();
    cache.set('x', 'data');
    const before = cache.currentBytesUsed;
    const result = cache.delete('nonexistent');
    expect(result).toBe(false);
    expect(cache.currentBytesUsed).toBe(before);
  });

  it('should be assignable to Map<string, string> (type compatibility)', () => {
    // Compile-time check: ByteBudgetLRU extends Map so it is structurally
    // compatible wherever Map<string, string> is expected.
    const cache: Map<string, string> = new ByteBudgetLRU();
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
  });
});
