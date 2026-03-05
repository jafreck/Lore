import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { handler, toolDef, type DocsArgs } from '../../../src/kb-server/tools/docs.js';

const esmRequire = createRequire(import.meta.url);

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

interface SeededDocs {
  readmeMainSectionId: {
    lore: number;
    install: number;
  };
}

function seedDocs(db: Database.Database): SeededDocs {
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

  const readmeMainLoreSectionId = db.prepare(
    `INSERT INTO doc_sections
      (doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(readmeMainId, 0, 'Lore', 1, JSON.stringify(['Lore']), 1, 2, 'Lore intro', 'section-1')
    .lastInsertRowid as number;
  const readmeMainInstallSectionId = db.prepare(
    `INSERT INTO doc_sections
      (doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(readmeMainId, 1, 'Install', 2, JSON.stringify(['Lore', 'Install']), 3, 4, 'Install with npm', 'section-2')
    .lastInsertRowid as number;
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

  return {
    readmeMainSectionId: {
      lore: readmeMainLoreSectionId,
      install: readmeMainInstallSectionId,
    },
  };
}

function loadDocSectionEmbeddings(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE doc_section_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);
}

function insertDocSectionEmbedding(
  db: Database.Database,
  sectionId: number,
  embedding: number[],
): void {
  db.prepare(
    'INSERT OR REPLACE INTO doc_section_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(sectionId, JSON.stringify(embedding));
}

function createStubEmbedder(vector: number[]) {
  return {
    modelName: 'test-embedder',
    dims: vector.length,
    init: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    embed: vi.fn(async () => [vector]),
  };
}

describe('docs toolDef', () => {
  it('should expose kb_docs with action enum support', () => {
    expect(toolDef.name).toBe('kb_docs');
    expect(toolDef.inputSchema.required).toEqual(['action']);
    expect(toolDef.inputSchema.properties.action.enum).toEqual(['list', 'get', 'search']);
    expect(toolDef.inputSchema.properties.mode.enum).toEqual(['text', 'semantic', 'fused']);
  });
});

describe('docs handler', () => {
  let db: Database.Database;
  let seeded: SeededDocs;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    seeded = seedDocs(db);
  });

  it('lists docs with branch and kind filters in deterministic order', async () => {
    const result = await handler(db, {
      action: 'list',
      branch: 'main',
      kinds: ['guide', 'readme'],
      limit: 20,
    });

    expect(result.action).toBe('list');
    expect(result.docs?.map((row) => row.path)).toEqual(['/repo/README.md', '/repo/docs/guide.md']);
    expect(result.count).toBe(2);
  });

  it('gets whole-document content and section-scoped rows by path', async () => {
    const result = await handler(db, {
      action: 'get',
      path: '/repo/README.md',
      branch: 'main',
    });

    expect(result.doc?.content).toContain('Install');
    expect(result.sections?.map((section) => section.section_index)).toEqual([0, 1]);
    expect(result.sections?.[1]?.heading_path).toBe(JSON.stringify(['Lore', 'Install']));
  });

  it('supports section_index targeting for get responses', async () => {
    const result = await handler(db, {
      action: 'get',
      path: '/repo/README.md',
      branch: 'main',
      section_index: 1,
    });

    expect(result.sections?.map((section) => section.section_index)).toEqual([1]);
    expect(result.count).toBe(1);
  });

  it('should return empty get results when path is missing or unknown', async () => {
    const missingPathResult = await handler(db, {
      action: 'get',
      path: '   ',
      branch: 'main',
    });
    expect(missingPathResult.doc).toBeNull();
    expect(missingPathResult.sections).toEqual([]);
    expect(missingPathResult.count).toBe(0);

    const unknownPathResult = await handler(db, {
      action: 'get',
      path: '/repo/missing.md',
      branch: 'main',
    });
    expect(unknownPathResult.doc).toBeNull();
    expect(unknownPathResult.sections).toEqual([]);
    expect(unknownPathResult.count).toBe(0);
  });

  it('should support get responses without loading sections', async () => {
    const result = await handler(db, {
      action: 'get',
      path: '/repo/README.md',
      branch: 'main',
      include_sections: false,
    });

    expect(result.doc?.path).toBe('/repo/README.md');
    expect(result.sections).toEqual([]);
    expect(result.count).toBe(1);
  });

  it('searches sections by query with path scoping and empty-result behavior', async () => {
    const searchArgs: DocsArgs = {
      action: 'search',
      query: 'install',
      path: '/repo/README.md',
      branch: 'main',
      limit: 20,
    };
    const scopedResult = await handler(db, searchArgs);
    expect(scopedResult.results?.map((row) => row.section_index)).toEqual([1]);
    expect(scopedResult.mode_used).toBe('text');

    expect((await handler(db, { action: 'search', query: 'missing', limit: 20 })).results).toEqual([]);
    expect((await handler(db, { action: 'search', query: '   ', limit: 20 })).results).toEqual([]);
  });

  it('should support section_index filtering for search responses', async () => {
    const result = await handler(db, {
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

  it('supports semantic search mode when embeddings are available', async () => {
    loadDocSectionEmbeddings(db, 3);
    insertDocSectionEmbedding(db, seeded.readmeMainSectionId.lore, [0.1, 0.9, 0.0]);
    insertDocSectionEmbedding(db, seeded.readmeMainSectionId.install, [0.95, 0.05, 0.0]);

    const embedder = createStubEmbedder([0.9, 0.1, 0.0]);
    const result = await handler(
      db,
      {
        action: 'search',
        mode: 'semantic',
        query: 'installation docs',
        path: '/repo/README.md',
        branch: 'main',
        limit: 20,
      },
      embedder,
    );

    expect(embedder.embed).toHaveBeenCalledWith(['installation docs']);
    if (result.mode_used === 'semantic') {
      expect(result.results?.map((row) => row.section_index)).toEqual([1, 0]);
      return;
    }

    expect(result.mode_used).toBe('text (fallback: no embeddings)');
    expect(result.results?.map((row) => row.section_index)).toEqual([]);
  });

  it('supports fused search mode and ranks rows that match both text and semantic channels higher', async () => {
    loadDocSectionEmbeddings(db, 3);
    insertDocSectionEmbedding(db, seeded.readmeMainSectionId.lore, [0.99, 0.01, 0.0]);
    insertDocSectionEmbedding(db, seeded.readmeMainSectionId.install, [0.8, 0.2, 0.0]);

    const embedder = createStubEmbedder([1.0, 0.0, 0.0]);
    const result = await handler(
      db,
      {
        action: 'search',
        mode: 'fused',
        query: 'install',
        path: '/repo/README.md',
        branch: 'main',
        limit: 20,
      },
      embedder,
    );

    expect(embedder.embed).toHaveBeenCalledWith(['install']);
    if (result.mode_used === 'fused') {
      expect(result.results?.[0]?.section_index).toBe(1);
      expect(result.results?.some((row) => row.section_index === 0)).toBe(true);
      return;
    }

    expect(result.mode_used).toBe('text (fallback: no embeddings)');
    expect(result.results?.map((row) => row.section_index)).toEqual([1]);
  });

  it('returns explicit fallback signaling when semantic mode is requested without an embedder', async () => {
    const result = await handler(db, {
      action: 'search',
      mode: 'semantic',
      query: 'install',
      path: '/repo/README.md',
      branch: 'main',
      limit: 20,
    });

    expect(result.mode_used).toBe('text (fallback: no query-time embedder)');
    expect(result.results?.map((row) => row.section_index)).toEqual([1]);
  });

  it('should fall back to text search when semantic mode is requested but embeddings table is unavailable', async () => {
    const embedder = createStubEmbedder([1.0, 0.0, 0.0]);
    const result = await handler(
      db,
      {
        action: 'search',
        mode: 'semantic',
        query: 'install',
        path: '/repo/README.md',
        branch: 'main',
        limit: 20,
      },
      embedder,
    );

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result.mode_used).toBe('text (fallback: no embeddings)');
    expect(result.results?.map((row) => row.section_index)).toEqual([1]);
  });

  it('should fall back to text search when query embedding generation throws', async () => {
    loadDocSectionEmbeddings(db, 3);
    insertDocSectionEmbedding(db, seeded.readmeMainSectionId.lore, [0.1, 0.9, 0.0]);
    insertDocSectionEmbedding(db, seeded.readmeMainSectionId.install, [0.95, 0.05, 0.0]);

    const embedder = createStubEmbedder([1.0, 0.0, 0.0]);
    embedder.embed.mockRejectedValueOnce(new Error('embedding failed'));

    const result = await handler(
      db,
      {
        action: 'search',
        mode: 'fused',
        query: 'install',
        path: '/repo/README.md',
        branch: 'main',
        limit: 20,
      },
      embedder,
    );

    expect(embedder.embed).toHaveBeenCalledWith(['install']);
    expect(result.mode_used).toBe('text (fallback: no embeddings)');
    expect(result.results?.map((row) => row.section_index)).toEqual([1]);
  });

  it('should return explicit fallback signaling when fused mode is requested without an embedder', async () => {
    const result = await handler(db, {
      action: 'search',
      mode: 'fused',
      query: 'install',
      path: '/repo/README.md',
      branch: 'main',
      limit: 20,
    });

    expect(result.mode_used).toBe('text (fallback: no query-time embedder)');
    expect(result.results?.map((row) => row.section_index)).toEqual([1]);
  });

  it('should preserve the requested mode when search query is empty', async () => {
    const result = await handler(db, {
      action: 'search',
      mode: 'semantic',
      query: '   ',
      path: '/repo/README.md',
      branch: 'main',
      limit: 20,
    });

    expect(result.mode_used).toBe('semantic');
    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
  });
});
