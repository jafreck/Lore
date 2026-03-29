import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import {
  setLoreMeta,
  getLoreMeta,
  deleteLoreMeta,
  getGeneration,
  incrementGeneration,
  LORE_META_INDEX_CHECKPOINT,
  LORE_META_LAST_HEAD_SHA,
  LORE_META_GENERATION,
  LORE_META_GENERATION_PENDING,
  LORE_META_OVERLAY_DIRTY_FILES,
  LORE_META_BASELINE_HEAD_SHA,
  LORE_META_OVERLAY_HEAD_SHA,
} from '../../src/db/meta.js';

describe('meta', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  describe('constants', () => {
    it('exports expected meta key constants', () => {
      expect(LORE_META_INDEX_CHECKPOINT).toBe('index_checkpoint');
      expect(LORE_META_LAST_HEAD_SHA).toBe('last_known_head_sha');
      expect(LORE_META_GENERATION).toBe('generation');
      expect(LORE_META_GENERATION_PENDING).toBe('generation_pending');
      expect(LORE_META_OVERLAY_DIRTY_FILES).toBe('overlay_dirty_files');
      expect(LORE_META_BASELINE_HEAD_SHA).toBe('baseline_head_sha');
      expect(LORE_META_OVERLAY_HEAD_SHA).toBe('overlay_head_sha');
    });
  });

  describe('setLoreMeta / getLoreMeta', () => {
    it('stores and retrieves a value', () => {
      setLoreMeta(db, 'foo', 'bar');
      expect(getLoreMeta(db, 'foo')).toBe('bar');
    });

    it('returns undefined for missing keys', () => {
      expect(getLoreMeta(db, 'nonexistent')).toBeUndefined();
    });

    it('overwrites existing values (INSERT OR REPLACE)', () => {
      setLoreMeta(db, 'key', 'v1');
      setLoreMeta(db, 'key', 'v2');
      expect(getLoreMeta(db, 'key')).toBe('v2');
    });

    it('handles empty string values', () => {
      setLoreMeta(db, 'empty', '');
      expect(getLoreMeta(db, 'empty')).toBe('');
    });

    it('handles special characters in keys and values', () => {
      setLoreMeta(db, "key'with\"quotes", "val'ue");
      expect(getLoreMeta(db, "key'with\"quotes")).toBe("val'ue");
    });

    it('handles long values', () => {
      const longVal = 'x'.repeat(10000);
      setLoreMeta(db, 'long', longVal);
      expect(getLoreMeta(db, 'long')).toBe(longVal);
    });
  });

  describe('deleteLoreMeta', () => {
    it('deletes an existing key', () => {
      setLoreMeta(db, 'todelete', 'value');
      deleteLoreMeta(db, 'todelete');
      expect(getLoreMeta(db, 'todelete')).toBeUndefined();
    });

    it('does not throw when deleting a non-existent key', () => {
      expect(() => deleteLoreMeta(db, 'nope')).not.toThrow();
    });

    it('does not affect other keys', () => {
      setLoreMeta(db, 'a', '1');
      setLoreMeta(db, 'b', '2');
      deleteLoreMeta(db, 'a');
      expect(getLoreMeta(db, 'a')).toBeUndefined();
      expect(getLoreMeta(db, 'b')).toBe('2');
    });
  });

  describe('getGeneration', () => {
    it('returns 0 when no generation is set', () => {
      expect(getGeneration(db)).toBe(0);
    });

    it('returns the stored generation value', () => {
      setLoreMeta(db, LORE_META_GENERATION, '42');
      expect(getGeneration(db)).toBe(42);
    });
  });

  describe('incrementGeneration', () => {
    it('increments from 0 to 1 on first call', () => {
      const next = incrementGeneration(db);
      expect(next).toBe(1);
      expect(getGeneration(db)).toBe(1);
    });

    it('increments sequentially', () => {
      expect(incrementGeneration(db)).toBe(1);
      expect(incrementGeneration(db)).toBe(2);
      expect(incrementGeneration(db)).toBe(3);
      expect(getGeneration(db)).toBe(3);
    });

    it('increments from a manually set value', () => {
      setLoreMeta(db, LORE_META_GENERATION, '10');
      const next = incrementGeneration(db);
      expect(next).toBe(11);
    });

    it('persists the incremented value', () => {
      incrementGeneration(db);
      incrementGeneration(db);
      expect(getLoreMeta(db, LORE_META_GENERATION)).toBe('2');
    });
  });
});
