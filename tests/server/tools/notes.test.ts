import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { openDb } from '../../../src/db/schema.js';
import {
  loreNotesWriteToolDef,
  loreNotesReadToolDef,
  loreNotesWriteHandler,
  loreNotesReadHandler,
  writeToolDef,
  readToolDef,
  writeHandler,
  readHandler,
} from '../../../src/server/tools/notes.js';

function removeDbFiles(dbPath: string): void {
  if (existsSync(dbPath)) unlinkSync(dbPath);
  const wal = `${dbPath}-wal`;
  const shm = `${dbPath}-shm`;
  if (existsSync(wal)) unlinkSync(wal);
  if (existsSync(shm)) unlinkSync(shm);
}

describe('notes tool exports', () => {
  it('should expose tool definitions and aliases', () => {
    expect(loreNotesWriteToolDef.name).toBe('lore_notes_write');
    expect(loreNotesReadToolDef.name).toBe('lore_notes_read');
    expect(writeToolDef).toBe(loreNotesWriteToolDef);
    expect(readToolDef).toBe(loreNotesReadToolDef);
  });

  it('should expose handler aliases', () => {
    expect(writeHandler).toBe(loreNotesWriteHandler);
    expect(readHandler).toBe(loreNotesReadHandler);
  });
});

describe('loreNotesWriteHandler', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `notes-test-${randomBytes(8).toString('hex')}.db`);
    const db = openDb(dbPath);
    db.close();
  });

  afterEach(() => {
    removeDbFiles(dbPath);
  });

  it('should insert a note and default blank scope to global', () => {
    const result = loreNotesWriteHandler(dbPath, { key: 'architecture/overview', scope: '  ', content: 'v1' });
    expect(result.ok).toBe(true);
    expect(result.scope).toBe('global');

    const db = new Database(dbPath);
    const row = db
      .prepare('SELECT scope, content, model, source_hash FROM notes WHERE key = ?')
      .get('architecture/overview') as
      | { scope: string; content: string; model: string; source_hash: string | null }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row?.scope).toBe('global');
    expect(row?.content).toBe('v1');
    expect(row?.model).toBe('');
    expect(row?.source_hash).toBe(null);
  });

  it('should upsert by key and scope and keep one row', () => {
    loreNotesWriteHandler(dbPath, { key: 'architecture/overview', scope: 'global', content: 'first' });
    loreNotesWriteHandler(dbPath, {
      key: 'architecture/overview',
      scope: 'global',
      content: 'second',
      model: 'gpt-5',
      source_hash: 'abc123',
    });

    const db = new Database(dbPath);
    const rows = db
      .prepare('SELECT content, model, source_hash FROM notes WHERE key = ? AND scope = ?')
      .all('architecture/overview', 'global') as Array<{
      content: string;
      model: string;
      source_hash: string | null;
    }>;
    db.close();

    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('second');
    expect(rows[0].model).toBe('gpt-5');
    expect(rows[0].source_hash).toBe('abc123');
  });

  it('should throw when notes table does not exist', () => {
    const invalidDbPath = join(tmpdir(), `notes-empty-${randomBytes(8).toString('hex')}.db`);
    const db = new Database(invalidDbPath);
    db.close();

    expect(() => loreNotesWriteHandler(invalidDbPath, { key: 'k', content: 'v' })).toThrow();
    removeDbFiles(invalidDbPath);
  });
});

describe('loreNotesReadHandler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should filter by key, key_prefix, and scope with trimmed inputs', () => {
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('architecture/overview', 'global', 'g', '', null, 1, 1);
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('architecture/api', 'module:lore-server', 'm', '', null, 2, 2);
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('search/index', 'global', 's', '', null, 3, 3);

    const byKey = loreNotesReadHandler(db, { key: '  architecture/overview  ' });
    expect(byKey.count).toBe(1);
    expect(byKey.notes[0].key).toBe('architecture/overview');

    const byPrefixAndScope = loreNotesReadHandler(db, {
      key_prefix: ' architecture/ ',
      scope: ' module:lore-server ',
    });
    expect(byPrefixAndScope.count).toBe(1);
    expect(byPrefixAndScope.notes[0].content).toBe('m');
  });

  it('should apply default limit of 20 and clamp max limit to 200', () => {
    const insert = db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 1; i <= 210; i += 1) {
      insert.run(`k/${i}`, 'global', `v${i}`, '', null, i, i);
    }

    const defaultLimited = loreNotesReadHandler(db, {});
    expect(defaultLimited.count).toBe(20);

    const clamped = loreNotesReadHandler(db, { limit: 500 });
    expect(clamped.count).toBe(200);
  });

  it('should mark file-scoped notes stale when file is missing', () => {
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('f/missing', 'file:src/missing.ts', 'c', '', 'h1', 1, 1);

    const result = loreNotesReadHandler(db, { key: 'f/missing' });
    expect(result.notes[0].stale).toBe(true);
    expect(result.notes[0].stale_reason).toBe('file_missing');
    expect(result.notes[0].file_last_hash).toBe(null);
  });

  it('should mark file-scoped notes stale for source hash mismatch', () => {
    db.prepare('INSERT INTO files (path, branch, language, last_hash, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
      'src/a.ts',
      '',
      'typescript',
      'newhash',
      10,
    );
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('f/hash', 'file:src/a.ts', 'c', '', 'oldhash', 5, 20);

    const result = loreNotesReadHandler(db, { key: 'f/hash' });
    expect(result.notes[0].stale).toBe(true);
    expect(result.notes[0].stale_reason).toBe('source_hash_mismatch');
    expect(result.notes[0].file_last_hash).toBe('newhash');
  });

  it('should mark file-scoped notes stale when file indexed after note', () => {
    db.prepare('INSERT INTO files (path, branch, language, last_hash, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
      'src/b.ts',
      '',
      'typescript',
      'samehash',
      50,
    );
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('f/indexed', 'file:src/b.ts', 'c', '', 'samehash', 1, 10);

    const result = loreNotesReadHandler(db, { key: 'f/indexed' });
    expect(result.notes[0].stale).toBe(true);
    expect(result.notes[0].stale_reason).toBe('indexed_after_note');
    expect(result.notes[0].file_indexed_at).toBe(50);
  });

  it('should mark doc-scoped notes stale for source hash mismatch', () => {
    db.prepare(
      'INSERT INTO docs (path, branch, kind, title, content, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('/repo/README.md', 'main', 'readme', 'README', '# README', 'new-doc-hash', 10);
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('docs/readme', 'doc:/repo/README.md@main', 'seeded', 'system:auto-doc-seed', 'old-doc-hash', 1, 5);

    const result = loreNotesReadHandler(db, { key: 'docs/readme' });
    expect(result.notes[0].stale).toBe(true);
    expect(result.notes[0].stale_reason).toBe('source_hash_mismatch');
  });

  it('should mark doc-scoped notes stale when the referenced doc is missing', () => {
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('docs/readme', 'doc:/repo/README.md@main', 'seeded', 'system:auto-doc-seed', 'hash', 1, 5);

    const result = loreNotesReadHandler(db, { key: 'docs/readme' });
    expect(result.notes[0].stale).toBe(true);
    expect(result.notes[0].stale_reason).toBe('doc_missing');
  });

  it('should keep doc-scoped notes fresh when source hash matches current doc', () => {
    db.prepare(
      'INSERT INTO docs (path, branch, kind, title, content, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('/repo/README.md', 'main', 'readme', 'README', '# README', 'doc-hash', 10);
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('docs/readme', 'doc:/repo/README.md@main', 'seeded', 'system:auto-doc-seed', 'doc-hash', 1, 5);

    const result = loreNotesReadHandler(db, { key: 'docs/readme' });
    expect(result.notes[0].stale).toBe(false);
    expect(result.notes[0].stale_reason).toBe(null);
  });

  it('should include global-note Lore recency metadata', () => {
    db.prepare('INSERT INTO files (path, branch, language, last_hash, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
      'src/c.ts',
      '',
      'typescript',
      'h',
      100,
    );
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('g/stale', 'global', 'c', '', null, 1, 10);

    const result = loreNotesReadHandler(db, { key: 'g/stale' });
    expect(result.notes[0].stale).toBe(true);
    expect(result.notes[0].stale_reason).toBe('lore_reindexed_since_note');
    expect(result.notes[0].lore_indexed_at).toBe(100);
    expect(result.notes[0].file_indexed_at).toBe(null);
  });

  it('should keep non-file custom scopes as non-stale without recency metadata', () => {
    db.prepare(
      'INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('mod/one', 'module:search', 'c', '', null, 1, 1);

    const result = loreNotesReadHandler(db, { key: 'mod/one' });
    expect(result.notes[0].stale).toBe(false);
    expect(result.notes[0].stale_reason).toBe(null);
    expect(result.notes[0].lore_indexed_at).toBe(null);
  });
});
