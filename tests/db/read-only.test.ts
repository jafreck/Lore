import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/schema.js';
import type { Database as DbType } from '../../src/db/schema.js';
import { getFreshness, openReadOnly } from '../../src/db/read-only.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

describe('read-only', () => {
  let db: DbType.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  describe('getFreshness', () => {
    it('returns baseline source with 0 dirty files when no dirty_files exist', () => {
      const info = getFreshness(db);
      expect(info.source).toBe('baseline');
      expect(info.dirty_file_count).toBe(0);
    });

    it('returns mixed source when dirty_files has entries', () => {
      db.prepare(
        "INSERT INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES ('a.ts', '', 1000, 1)",
      ).run();
      const info = getFreshness(db);
      expect(info.source).toBe('mixed');
      expect(info.dirty_file_count).toBe(1);
    });

    it('counts multiple dirty files', () => {
      db.prepare(
        "INSERT INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES ('a.ts', '', 1000, 1)",
      ).run();
      db.prepare(
        "INSERT INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES ('b.ts', '', 1000, 1)",
      ).run();
      db.prepare(
        "INSERT INTO dirty_files (path, branch, dirty_since, overlay_gen) VALUES ('c.ts', '', 1000, 1)",
      ).run();
      const info = getFreshness(db);
      expect(info.dirty_file_count).toBe(3);
      expect(info.source).toBe('mixed');
    });

    it('computes baseline_age_s from baseline file indexed_at', () => {
      const now = Math.floor(Date.now() / 1000);
      const insertedAt = now - 60;
      db.prepare(
        "INSERT INTO files (path, branch, language, size_bytes, indexed_at, layer) VALUES ('x.ts', '', 'typescript', 10, ?, 'baseline')",
      ).run(insertedAt);
      const info = getFreshness(db);
      // baseline_age_s = currentTime - insertedAt; allow small execution-time tolerance
      expect(info.baseline_age_s).toBeGreaterThanOrEqual(59);
      expect(info.baseline_age_s).toBeLessThan(120);
    });

    it('returns 0 baseline_age_s when no baseline files exist', () => {
      const info = getFreshness(db);
      expect(info.baseline_age_s).toBe(0);
    });

    it('uses MAX(indexed_at) across multiple baseline files', () => {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        "INSERT INTO files (path, branch, language, size_bytes, indexed_at, layer) VALUES ('old.ts', '', 'typescript', 10, ?, 'baseline')",
      ).run(now - 3600);
      db.prepare(
        "INSERT INTO files (path, branch, language, size_bytes, indexed_at, layer) VALUES ('new.ts', '', 'typescript', 10, ?, 'baseline')",
      ).run(now - 30);
      const info = getFreshness(db);
      // Should use the more recent file (30 seconds ago)
      expect(info.baseline_age_s).toBeGreaterThanOrEqual(29);
      expect(info.baseline_age_s).toBeLessThan(120);
    });

    it('ignores overlay files when computing baseline_age_s', () => {
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        "INSERT INTO files (path, branch, language, size_bytes, indexed_at, layer) VALUES ('base.ts', '', 'typescript', 10, ?, 'baseline')",
      ).run(now - 120);
      db.prepare(
        "INSERT INTO files (path, branch, language, size_bytes, indexed_at, layer) VALUES ('over.ts', '', 'typescript', 10, ?, 'overlay')",
      ).run(now - 5);
      const info = getFreshness(db);
      // Should be ~120 seconds, not ~5 seconds
      expect(info.baseline_age_s).toBeGreaterThanOrEqual(119);
    });

    it('returns baseline_age_s >= 0 (never negative)', () => {
      const now = Math.floor(Date.now() / 1000);
      // Insert a file with indexed_at slightly in the future
      db.prepare(
        "INSERT INTO files (path, branch, language, size_bytes, indexed_at, layer) VALUES ('future.ts', '', 'typescript', 10, ?, 'baseline')",
      ).run(now + 100);
      const info = getFreshness(db);
      expect(info.baseline_age_s).toBe(0);
    });

    it('handles database without dirty_files table gracefully', () => {
      // Create a bare-bones database without the dirty_files table
      const bareDb = new Database(':memory:');
      bareDb.exec(`
        CREATE TABLE files (
          id INTEGER PRIMARY KEY, path TEXT, branch TEXT DEFAULT '', language TEXT,
          size_bytes INTEGER DEFAULT 0, last_hash TEXT, source TEXT DEFAULT '',
          indexed_at INTEGER DEFAULT 0, layer TEXT DEFAULT 'baseline', generation INTEGER DEFAULT 0
        );
        CREATE TABLE lore_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      const info = getFreshness(bareDb);
      expect(info.dirty_file_count).toBe(0);
      expect(info.source).toBe('baseline');
      bareDb.close();
    });

    it('handles database without layer column gracefully', () => {
      const bareDb = new Database(':memory:');
      bareDb.exec(`
        CREATE TABLE files (
          id INTEGER PRIMARY KEY, path TEXT, branch TEXT DEFAULT '', language TEXT,
          size_bytes INTEGER DEFAULT 0, last_hash TEXT, source TEXT DEFAULT '',
          indexed_at INTEGER DEFAULT 0
        );
        CREATE TABLE dirty_files (path TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', dirty_since INTEGER DEFAULT 0, overlay_gen INTEGER DEFAULT 0, PRIMARY KEY (path, branch));
        CREATE TABLE lore_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      const info = getFreshness(bareDb);
      // Should not throw, baseline_age_s should be 0 due to missing 'layer' column
      expect(info.baseline_age_s).toBe(0);
      bareDb.close();
    });
  });

  describe('openReadOnly', () => {
    it('opens a database file in read-only mode', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'lore-test-'));
      const dbPath = join(tmpDir, 'test.db');
      // Create the database first
      const writeDb = openDb(dbPath);
      writeDb.prepare(
        "INSERT INTO files (path, branch, language, size_bytes) VALUES ('test.ts', '', 'typescript', 100)",
      ).run();
      writeDb.close();

      // Open read-only
      const roDb = openReadOnly(dbPath);
      const row = roDb.prepare('SELECT * FROM files WHERE path = ?').get('test.ts') as { path: string };
      expect(row.path).toBe('test.ts');

      // Verify it's read-only
      expect(() => {
        roDb.prepare("INSERT INTO files (path, branch, language) VALUES ('x.ts', '', 'typescript')").run();
      }).toThrow();

      roDb.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });
  });
});
