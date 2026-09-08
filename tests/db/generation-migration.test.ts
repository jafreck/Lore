import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from '../../src/db/schema.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function legacyDatabase(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-generation-migration-'));
  tempDirs.push(tempDir);
  const dbPath = path.join(tempDir, 'legacy.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      last_hash TEXT,
      source TEXT NOT NULL DEFAULT '',
      indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      layer TEXT NOT NULL DEFAULT 'baseline',
      generation INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch, layer)
    );
    CREATE TABLE lore_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.close();
  return dbPath;
}

describe('generation-aware schema migration', () => {
  it('preserves legacy IDs and permits baseline generations to coexist', () => {
    const dbPath = legacyDatabase();
    const legacy = new Database(dbPath);
    legacy.prepare(
      "INSERT INTO files (id, path, branch, language, layer, generation) VALUES (7, '/repo/a.ts', 'main', 'typescript', 'baseline', 1)",
    ).run();
    legacy.prepare("INSERT INTO lore_meta (key, value) VALUES ('generation', '1')").run();
    legacy.close();

    const db = openDb(dbPath);
    try {
      expect(db.prepare("SELECT id FROM files WHERE path = '/repo/a.ts'").get()).toEqual({ id: 7 });
      expect(() => db.prepare(
        "INSERT INTO files (path, branch, language, layer, generation) VALUES ('/repo/a.ts', 'main', 'typescript', 'baseline', 2)",
      ).run()).not.toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps the prior generation promoted when legacy metadata records an interrupted build', () => {
    const dbPath = legacyDatabase();
    const legacy = new Database(dbPath);
    legacy.prepare(
      "INSERT INTO files (path, branch, language, source, layer, generation) VALUES ('/repo/old.ts', 'main', 'typescript', 'old', 'baseline', 1)",
    ).run();
    legacy.prepare(
      "INSERT INTO files (path, branch, language, source, layer, generation) VALUES ('/repo/partial.ts', 'main', 'typescript', 'partial', 'baseline', 2)",
    ).run();
    legacy.prepare("INSERT INTO lore_meta (key, value) VALUES ('generation', '2')").run();
    legacy.prepare("INSERT INTO lore_meta (key, value) VALUES ('generation_pending', '2')").run();
    legacy.close();

    const db = openDb(dbPath);
    try {
      expect(db.prepare(
        "SELECT generation FROM baseline_generations WHERE branch = 'main'",
      ).get()).toEqual({ generation: 1 });
      expect(db.prepare(
        'SELECT path FROM effective_files ORDER BY path',
      ).all()).toEqual([{ path: '/repo/old.ts' }]);
    } finally {
      db.close();
    }
  });
});
