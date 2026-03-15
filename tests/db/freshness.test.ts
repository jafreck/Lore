/**
 * Tests for getFreshness() in read-only.ts — freshness metadata for MCP tools.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openDb, setLoreMeta } from '../../src/db/schema.js';
import { getFreshness } from '../../src/db/read-only.js';
import Database from 'better-sqlite3';

describe('getFreshness', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should return baseline source when no dirty files', () => {
    db = openDb(':memory:');
    const freshness = getFreshness(db);
    expect(freshness.source).toBe('baseline');
    expect(freshness.dirty_file_count).toBe(0);
  });

  it('should return mixed source when dirty files exist', () => {
    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)',
    ).run('/src/test.ts', 1000, 0);

    const freshness = getFreshness(db);
    expect(freshness.source).toBe('mixed');
    expect(freshness.dirty_file_count).toBe(1);
  });

  it('should count multiple dirty files', () => {
    db = openDb(':memory:');
    db.prepare('INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)').run('/a.ts', 1000, 0);
    db.prepare('INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)').run('/b.ts', 1000, 0);
    db.prepare('INSERT INTO dirty_files (path, dirty_since, overlay_gen) VALUES (?, ?, ?)').run('/c.ts', 1000, 0);

    const freshness = getFreshness(db);
    expect(freshness.dirty_file_count).toBe(3);
    expect(freshness.source).toBe('mixed');
  });

  it('should compute baseline_age_s from baseline files', () => {
    db = openDb(':memory:');
    // Insert a baseline file indexed 100 seconds ago
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run('/src/a.ts', 'HEAD', 'typescript', 10, '', 'baseline', 1, now - 100);
    setLoreMeta(db, 'baseline_head_sha', 'abc123');

    const freshness = getFreshness(db);
    expect(freshness.baseline_age_s).toBeGreaterThanOrEqual(99);
    expect(freshness.baseline_age_s).toBeLessThan(110);
  });

  it('should return baseline_age_s=0 when no baseline_head_sha', () => {
    db = openDb(':memory:');
    const freshness = getFreshness(db);
    expect(freshness.baseline_age_s).toBe(0);
  });

  it('should handle databases without dirty_files table gracefully', () => {
    // Open a raw database without the incremental schema
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    const freshness = getFreshness(db);
    expect(freshness.source).toBe('baseline');
    expect(freshness.dirty_file_count).toBe(0);
    expect(freshness.baseline_age_s).toBe(0);
  });
});
