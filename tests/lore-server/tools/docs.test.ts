import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef, type DocsArgs } from '../../../src/lore-server/tools/docs.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE docs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT    NOT NULL,
      branch       TEXT    NOT NULL DEFAULT '',
      kind         TEXT    NOT NULL,
      title        TEXT    NOT NULL,
      content      TEXT    NOT NULL,
      content_hash TEXT    NOT NULL,
      indexed_at   INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE doc_sections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id        INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      section_index INTEGER NOT NULL,
      title         TEXT    NOT NULL,
      depth         INTEGER NOT NULL,
      heading_path  TEXT    NOT NULL,
      line_start    INTEGER NOT NULL,
      line_end      INTEGER NOT NULL,
      content       TEXT    NOT NULL,
      content_hash  TEXT    NOT NULL,
      UNIQUE(doc_id, section_index)
    );
  `);
  return db;
}

function seedDocs(db: Database.Database): void {
  const readmeMainId = db
    .prepare(
      `INSERT INTO docs (path, branch, kind, title, content, content_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('/repo/README.md', 'main', 'readme', 'Lore', '# Lore\n\n## Install\nUse npm\n', 'hash-main', 1700)
    .lastInsertRowid as number;
  const readmeFeatId = db
    .prepare(
      `INSERT INTO docs (path, branch, kind, title, content, content_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('/repo/README.md', 'feat', 'readme', 'Lore feat', '# Lore\n\n## Branch\n', 'hash-feat', 1701)
    .lastInsertRowid as number;
  const guideId = db
    .prepare(
      `INSERT INTO docs (path, branch, kind, title, content, content_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('/repo/docs/guide.md', 'main', 'guide', 'Guide', '# Guide\n\n## Setup\n', 'hash-guide', 1702)
    .lastInsertRowid as number;

  db.prepare(
    `INSERT INTO doc_sections
      (doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(readmeMainId, 0, 'Lore', 1, JSON.stringify(['Lore']), 1, 2, 'Lore intro', 'section-1');
  db.prepare(
    `INSERT INTO doc_sections
      (doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(readmeMainId, 1, 'Install', 2, JSON.stringify(['Lore', 'Install']), 3, 4, 'Install with npm', 'section-2');
  db.prepare(
    `INSERT INTO doc_sections
      (doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(readmeFeatId, 0, 'Lore', 1, JSON.stringify(['Lore']), 1, 2, 'Feature readme', 'section-3');
  db.prepare(
    `INSERT INTO doc_sections
      (doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(guideId, 0, 'Guide', 1, JSON.stringify(['Guide']), 1, 2, 'Setup walkthrough', 'section-4');
}

describe('docs toolDef', () => {
  it('should expose lore_docs with action enum support', () => {
    expect(toolDef.name).toBe('lore_docs');
    expect(toolDef.inputSchema.required).toEqual(['action']);
    expect(toolDef.inputSchema.properties.action.enum).toEqual(['list', 'get', 'search']);
  });
});

describe('docs handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    seedDocs(db);
  });

  it('lists docs with branch and kind filters in deterministic order', () => {
    const result = handler(db, {
      action: 'list',
      branch: 'main',
      kinds: ['guide', 'readme'],
      limit: 20,
    });

    expect(result.action).toBe('list');
    expect(result.docs?.map((row) => row.path)).toEqual(['/repo/README.md', '/repo/docs/guide.md']);
    expect(result.count).toBe(2);
  });

  it('gets whole-document content and section-scoped rows by path', () => {
    const result = handler(db, {
      action: 'get',
      path: '/repo/README.md',
      branch: 'main',
    });

    expect(result.doc?.content).toContain('Install');
    expect(result.sections?.map((section) => section.section_index)).toEqual([0, 1]);
    expect(result.sections?.[1]?.heading_path).toBe(JSON.stringify(['Lore', 'Install']));
  });

  it('supports section_index targeting for get responses', () => {
    const result = handler(db, {
      action: 'get',
      path: '/repo/README.md',
      branch: 'main',
      section_index: 1,
    });

    expect(result.sections?.map((section) => section.section_index)).toEqual([1]);
    expect(result.count).toBe(1);
  });

  it('should return empty get results when path is missing or unknown', () => {
    const missingPathResult = handler(db, {
      action: 'get',
      path: '   ',
      branch: 'main',
    });
    expect(missingPathResult.doc).toBeNull();
    expect(missingPathResult.sections).toEqual([]);
    expect(missingPathResult.count).toBe(0);

    const unknownPathResult = handler(db, {
      action: 'get',
      path: '/repo/missing.md',
      branch: 'main',
    });
    expect(unknownPathResult.doc).toBeNull();
    expect(unknownPathResult.sections).toEqual([]);
    expect(unknownPathResult.count).toBe(0);
  });

  it('should support get responses without loading sections', () => {
    const result = handler(db, {
      action: 'get',
      path: '/repo/README.md',
      branch: 'main',
      include_sections: false,
    });

    expect(result.doc?.path).toBe('/repo/README.md');
    expect(result.sections).toEqual([]);
    expect(result.count).toBe(1);
  });

  it('searches sections by query with path scoping and empty-result behavior', () => {
    const searchArgs: DocsArgs = {
      action: 'search',
      query: 'install',
      path: '/repo/README.md',
      branch: 'main',
      limit: 20,
    };
    const scopedResult = handler(db, searchArgs);
    expect(scopedResult.results?.map((row) => row.section_index)).toEqual([1]);

    expect(handler(db, { action: 'search', query: 'missing', limit: 20 }).results).toEqual([]);
    expect(handler(db, { action: 'search', query: '   ', limit: 20 }).results).toEqual([]);
  });

  it('should support section_index filtering for search responses', () => {
    const result = handler(db, {
      action: 'search',
      query: 'lore',
      path: '/repo/README.md',
      branch: 'main',
      section_index: 0,
      limit: 20,
    });

    expect(result.results?.map((row) => row.section_index)).toEqual([0]);
    expect(result.count).toBe(1);
  });
});
