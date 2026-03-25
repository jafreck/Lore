import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { handler, toolDef, clearQueryEmbeddingCache } from '../../../src/server/tools/lookup.js';
import { createRequire } from 'node:module';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const esmRequire = createRequire(import.meta.url);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT '',
      language    TEXT    NOT NULL DEFAULT 'typescript',
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      last_hash   TEXT,
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'function',
      start_line  INTEGER NOT NULL DEFAULT 1,
      end_line    INTEGER NOT NULL DEFAULT 10,
      signature   TEXT,
      doc_comment TEXT,
      resolved_type_signature TEXT,
      resolved_return_type    TEXT,
      definition_uri          TEXT,
      definition_path         TEXT,
      parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
    );
    CREATE TABLE symbol_metrics (
      symbol_id    INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
      line_count   INTEGER NOT NULL,
      param_count  INTEGER NOT NULL,
      cyclomatic   INTEGER NOT NULL,
      max_nesting  INTEGER NOT NULL
    );
    CREATE TABLE external_symbols (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      dependency_ecosystem TEXT    NOT NULL DEFAULT 'npm',
      source_type          TEXT    NOT NULL DEFAULT 'declaration',
      source_ref           TEXT    NOT NULL DEFAULT '',
      package_name         TEXT    NOT NULL,
      package_version      TEXT,
      symbol_name          TEXT    NOT NULL,
      symbol_kind          TEXT    NOT NULL,
      signature            TEXT    NOT NULL DEFAULT '',
      doc_comment          TEXT,
      resolved_type_signature TEXT,
      resolved_return_type    TEXT,
      definition_uri          TEXT,
      definition_path         TEXT,
      parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL
    );
  `);
  return db;
}

function insertFile(
  db: Database.Database,
  path: string,
  branch: string,
  language = 'typescript',
): number {
  const result = db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, branch, language);
  return result.lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, fileId: number, name: string, kind = 'function'): number {
  const result = db
    .prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, 1, 10)',
    )
    .run(fileId, name, kind);
  return result.lastInsertRowid as number;
}

function insertSymbolMetrics(db: Database.Database, symbolId: number): void {
  db.prepare(
    'INSERT INTO symbol_metrics (symbol_id, line_count, param_count, cyclomatic, max_nesting) VALUES (?, ?, ?, ?, ?)',
  ).run(symbolId, 20, 3, 8, 4);
}

function insertExternalSymbol(
  db: Database.Database,
  packageName: string,
  packageVersion: string | null,
  symbolName: string,
  symbolKind: string,
): number {
  const result = db.prepare(
    `INSERT INTO external_symbols
      (package_name, package_version, symbol_name, symbol_kind, signature)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(packageName, packageVersion, symbolName, symbolKind, `${symbolKind} ${symbolName}()`);
  return result.lastInsertRowid as number;
}

function loadSymbolVectorTable(db: Database.Database, dims: number): void {
  const sqliteVec = esmRequire('sqlite-vec') as { load(db: Database.Database): void };
  sqliteVec.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE symbol_embeddings USING vec0(
      embedding FLOAT[${dims}]
    );
  `);
}

function insertSymbolEmbedding(db: Database.Database, symbolId: number, embedding: number[]): void {
  db.prepare(
    'INSERT OR REPLACE INTO symbol_embeddings(rowid, embedding) VALUES (CAST(? AS INTEGER), json(?))',
  ).run(symbolId, JSON.stringify(embedding));
}

// ─── handler (kind=symbol) ────────────────────────────────────────────────────

describe('lookup handler – kind=symbol', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    const parseConfigId = insertSymbol(db, mainId, 'parseConfig');
    insertSymbol(db, featId, 'parseConfig');
    insertSymbol(db, mainId, 'renderPage');
    insertSymbolMetrics(db, parseConfigId);
  });

  it('should return matching symbols by name', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig' });
    expect(result.results.length).toBe(2);
    expect(result.results[0]).toHaveProperty('line_count');
    expect(result.results[0]).toHaveProperty('param_count');
    expect(result.results[0]).toHaveProperty('cyclomatic');
    expect(result.results[0]).toHaveProperty('max_nesting');
  });

  it('should keep internal-only symbol lookup results unchanged when no external matches exist', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig' });
    expect(result.results.length).toBe(2);
    expect(
      result.results.every((row) => !Object.prototype.hasOwnProperty.call(row, 'package_name')),
    ).toBe(true);
  });

  it('should return external-only symbol matches with package metadata', async () => {
    insertExternalSymbol(db, 'left-pad', '1.3.0', 'leftPad', 'function');
    const result = await handler(db, { kind: 'symbol', query: 'leftPad' });
    expect(result.results.length).toBe(1);
    expect(result.results[0]).toMatchObject({
      package_name: 'left-pad',
      package_version: '1.3.0',
      symbol_name: 'leftPad',
      symbol_kind: 'function',
    });
  });

  it('should return mixed internal and external symbol matches for the same query', async () => {
    insertExternalSymbol(db, 'dep-utils', '2.0.0', 'parseConfig', 'function');
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig' });
    expect(result.results.length).toBe(3);

    const internalRows = result.results.filter((row) =>
      Object.prototype.hasOwnProperty.call(row, 'name'),
    );
    const externalRows = result.results.filter((row) =>
      Object.prototype.hasOwnProperty.call(row, 'package_name'),
    );

    expect(internalRows.length).toBe(2);
    expect(externalRows.length).toBe(1);
    expect(externalRows[0]).toMatchObject({
      package_name: 'dep-utils',
      package_version: '2.0.0',
      symbol_name: 'parseConfig',
    });
  });

  it('should trim symbol query before matching internal and external symbols', async () => {
    insertExternalSymbol(db, 'dep-utils', '2.0.0', 'parseConfig', 'function');
    const result = await handler(db, { kind: 'symbol', query: '  parseConfig  ' });
    expect(result.results.length).toBe(3);
  });

  it('should default to exact matching when match_mode is omitted', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'parse' });
    expect(result.results).toEqual([]);
  });

  it('should support prefix and contains match modes for symbol lookup', async () => {
    const prefixResult = await handler(db, { kind: 'symbol', query: 'parse', match_mode: 'prefix' });
    const containsResult = await handler(db, { kind: 'symbol', query: 'config', match_mode: 'contains' });

    expect(prefixResult.results).toHaveLength(2);
    expect(containsResult.results).toHaveLength(2);
  });

  it('should include external symbols only for default/exact symbol matches without path or language filters', async () => {
    insertExternalSymbol(db, 'dep-utils', '2.0.0', 'parseConfig', 'function');

    const prefixResult = await handler(db, { kind: 'symbol', query: 'parseConfig', match_mode: 'prefix' });
    const containsResult = await handler(db, { kind: 'symbol', query: 'config', match_mode: 'contains' });
    const pathFilteredResult = await handler(db, { kind: 'symbol', query: 'parseConfig', path_prefix: 'src/' });
    const languageFilteredResult = await handler(db, { kind: 'symbol', query: 'parseConfig', language: 'typescript' });
    const exactResult = await handler(db, { kind: 'symbol', query: 'parseConfig', match_mode: 'exact' });

    expect(
      prefixResult.results.every((row) => !Object.prototype.hasOwnProperty.call(row, 'package_name')),
    ).toBe(true);
    expect(
      containsResult.results.every((row) => !Object.prototype.hasOwnProperty.call(row, 'package_name')),
    ).toBe(true);
    expect(
      pathFilteredResult.results.every((row) => !Object.prototype.hasOwnProperty.call(row, 'package_name')),
    ).toBe(true);
    expect(
      languageFilteredResult.results.every((row) => !Object.prototype.hasOwnProperty.call(row, 'package_name')),
    ).toBe(true);
    expect(
      exactResult.results.some((row) => Object.prototype.hasOwnProperty.call(row, 'package_name')),
    ).toBe(true);
  });

  it('should apply symbol kind, path prefix, and language filters', async () => {
    const tsFileId = insertFile(db, 'src/components/widget.ts', 'main', 'typescript');
    const pyFileId = insertFile(db, 'src/components/widget.py', 'main', 'python');
    insertSymbol(db, tsFileId, 'parseConfig', 'class');
    insertSymbol(db, pyFileId, 'parseConfig', 'class');

    const result = await handler(db, {
      kind: 'symbol',
      query: 'parseConfig',
      symbol_kind: 'class',
      path_prefix: 'src/components',
      language: 'typescript',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      name: 'parseConfig',
      kind: 'class',
      file_id: tsFileId,
    });
  });

  it('should keep external symbol matches when branch filter is provided', async () => {
    insertExternalSymbol(db, 'dep-utils', '2.0.0', 'parseConfig', 'function');
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig', branch: 'main' });

    const internalRows = result.results.filter((row) =>
      Object.prototype.hasOwnProperty.call(row, 'name'),
    );
    const externalRows = result.results.filter((row) =>
      Object.prototype.hasOwnProperty.call(row, 'package_name'),
    );

    expect(internalRows.length).toBe(1);
    expect(externalRows).toHaveLength(1);
    expect(externalRows[0]).toMatchObject({
      package_name: 'dep-utils',
      symbol_name: 'parseConfig',
    });
  });

  it('should filter symbols by branch when branch is provided', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig', branch: 'main' });
    expect(result.results.length).toBe(1);
  });

  it('should list symbols when query is empty and no branch filter', async () => {
    const result = await handler(db, { kind: 'symbol', query: '' });
    expect(result.results.length).toBe(3);
  });

  it('should apply limit and offset when query is empty', async () => {
    const paged = await handler(db, { kind: 'symbol', query: '', limit: 1, offset: 1 });
    const outOfRange = await handler(db, { kind: 'symbol', query: '', limit: 10, offset: 99 });

    expect(paged.results).toHaveLength(1);
    expect(outOfRange.results).toEqual([]);
  });

  it('should list symbols filtered by branch when query is empty', async () => {
    const result = await handler(db, { kind: 'symbol', query: '', branch: 'main' });
    expect(result.results.length).toBe(2);
  });

  it('should return empty array when no symbols match the query', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'nonexistent' });
    expect(result.results).toEqual([]);
  });

  it('should return empty array when branch has no matching symbol', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig', branch: 'nonexistent' });
    expect(result.results).toEqual([]);
  });

  it('should signal exact fallback when semantic mode cannot use query embeddings', async () => {
    const emptyEmbedder = {
      modelName: 'test-embedder',
      dims: 3,
      embed: vi.fn(async () => [[]]),
    };
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig', mode: 'semantic' }, emptyEmbedder);
    expect(result.mode_used).toBe('exact (fallback: no embeddings)');
    expect(result.results.length).toBe(2);
  });
});

describe('lookup handler – enrichment metadata projection', () => {
  it('should return persisted internal and external enrichment metadata when present', async () => {
    const db = createTestDb();
    const fileId = insertFile(db, 'src/main.ts', 'main');
    const symbolId = insertSymbol(db, fileId, 'parseConfig');
    db.prepare(
      `UPDATE symbols
       SET resolved_type_signature = ?, resolved_return_type = ?, definition_uri = ?, definition_path = ?
       WHERE id = ?`,
    ).run(
      'function parseConfig(input: string): ParseResult',
      'ParseResult',
      'file:///repo/src/parser.ts',
      '/repo/src/parser.ts',
      symbolId,
    );

    const externalSymbolId = insertExternalSymbol(db, 'dep-utils', '2.0.0', 'parseConfig', 'function');
    db.prepare(
      `UPDATE external_symbols
       SET resolved_type_signature = ?, resolved_return_type = ?, definition_uri = ?, definition_path = ?
       WHERE id = ?`,
    ).run(
      'function parseConfig(input: string): ParseResult',
      'ParseResult',
      'file:///deps/dep-utils/index.d.ts',
      '/deps/dep-utils/index.d.ts',
      externalSymbolId,
    );

    const result = await handler(db, { kind: 'symbol', query: 'parseConfig' });
    const internalRow = result.results.find((row) => Object.prototype.hasOwnProperty.call(row, 'name')) as
      | Record<string, unknown>
      | undefined;
    const externalRow = result.results.find((row) => Object.prototype.hasOwnProperty.call(row, 'package_name')) as
      | Record<string, unknown>
      | undefined;

    expect(internalRow).toMatchObject({
      resolved_type_signature: 'function parseConfig(input: string): ParseResult',
      resolved_return_type: 'ParseResult',
      definition_uri: 'file:///repo/src/parser.ts',
      definition_path: '/repo/src/parser.ts',
    });
    expect(externalRow).toMatchObject({
      resolved_type_signature: 'function parseConfig(input: string): ParseResult',
      resolved_return_type: 'ParseResult',
      definition_uri: 'file:///deps/dep-utils/index.d.ts',
      definition_path: '/deps/dep-utils/index.d.ts',
    });
  });
});

describe('lookup handler – semantic symbol modes', () => {
  let db: Database.Database;

  beforeEach(() => {
    clearQueryEmbeddingCache();
    db = createTestDb();
    loadSymbolVectorTable(db, 3);
    const mainId = insertFile(db, 'src/main.ts', 'main');
    const featId = insertFile(db, 'src/feat.ts', 'feat');
    const parseMainId = insertSymbol(db, mainId, 'parseConfig');
    const parseFeatId = insertSymbol(db, featId, 'parseConfig');
    const loadMainId = insertSymbol(db, mainId, 'loadSettings');
    insertExternalSymbol(db, 'dep-utils', '2.0.0', 'parseConfig', 'function');
    insertSymbolEmbedding(db, parseMainId, [0.97, 0.03, 0.0]);
    insertSymbolEmbedding(db, parseFeatId, [0.95, 0.05, 0.0]);
    insertSymbolEmbedding(db, loadMainId, [0.93, 0.07, 0.0]);
  });

  it('should return semantic results with branch filtering and keep external exact matches', async () => {
    const embedder = {
      modelName: 'test-embedder',
      dims: 3,
      embed: vi.fn(async () => [[0.96, 0.04, 0.0]]),
    };
    const result = await handler(
      db,
      { kind: 'symbol', query: 'parseConfig', mode: 'semantic', branch: 'main' },
      embedder,
    );

    if (result.mode_used === 'semantic') {
      const internalRows = result.results.filter((row) =>
        Object.prototype.hasOwnProperty.call(row, 'name'),
      ) as Array<{ name: string; file_branch?: string }>;
      const externalRows = result.results.filter((row) =>
        Object.prototype.hasOwnProperty.call(row, 'package_name'),
      );

      expect(internalRows.length).toBeGreaterThan(0);
      expect(internalRows.every((row) => row.file_branch === 'main')).toBe(true);
      expect(externalRows).toHaveLength(1);
      return;
    }

    expect(result.mode_used).toBe('exact (fallback: no embeddings)');
    expect(result.results).toHaveLength(2);
  });

  it('should combine exact, semantic-only, and external matches in fused mode', async () => {
    const embedder = {
      modelName: 'test-embedder',
      dims: 3,
      embed: vi.fn(async () => [[0.96, 0.04, 0.0]]),
    };
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig', mode: 'fused' }, embedder);

    if (result.mode_used === 'fused') {
      const internalNames = result.results
        .filter((row) => Object.prototype.hasOwnProperty.call(row, 'name'))
        .map((row) => (row as { name: string }).name);
      const externalRows = result.results.filter((row) =>
        Object.prototype.hasOwnProperty.call(row, 'package_name'),
      );

      expect(internalNames[0]).toBe('parseConfig');
      expect(internalNames).toContain('loadSettings');
      expect(externalRows).toHaveLength(1);
      return;
    }

    expect(result.mode_used).toBe('exact (fallback: no embeddings)');
    expect(result.results.length).toBe(3);
  });

  it('should explicitly signal no-query-time-embedder fallback when semantic mode is requested', async () => {
    const result = await handler(db, { kind: 'symbol', query: 'parseConfig', mode: 'semantic' });
    expect(result.mode_used).toBe('exact (fallback: no query-time embedder)');
    expect(result.results.length).toBe(3);
  });

  it('should signal exact fallback when semantic embedding generation throws', async () => {
    const throwingEmbedder = {
      modelName: 'test-embedder',
      dims: 3,
      embed: vi.fn(async () => {
        throw new Error('embedding failed');
      }),
    };
    const result = await handler(
      db,
      { kind: 'symbol', query: 'parseConfig', mode: 'semantic' },
      throwingEmbedder,
    );
    expect(throwingEmbedder.embed).toHaveBeenCalledWith(['parseConfig']);
    expect(result.mode_used).toBe('exact (fallback: no embeddings)');
    expect(result.results.length).toBe(3);
  });
});

// ─── handler (kind=file) ──────────────────────────────────────────────────────

describe('lookup handler – kind=file', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertFile(db, 'src/main.ts', 'main');
    insertFile(db, 'src/main.ts', 'feat');
    insertFile(db, 'src/other.ts', 'main');
  });

  it('should return a file row when path matches', async () => {
    const result = await handler(db, { kind: 'file', query: 'src/main.ts' });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).not.toHaveProperty('cyclomatic');
  });

  it('should filter file by branch when branch is provided', async () => {
    const result = await handler(db, { kind: 'file', query: 'src/main.ts', branch: 'feat' });
    expect(result.results.length).toBe(1);
    expect((result.results[0] as { branch: string }).branch).toBe('feat');
  });

  it('should return empty array when file path not found', async () => {
    const result = await handler(db, { kind: 'file', query: 'nonexistent.ts' });
    expect(result.results).toEqual([]);
  });

  it('should return empty array when branch does not match', async () => {
    const result = await handler(db, { kind: 'file', query: 'src/main.ts', branch: 'nonexistent' });
    expect(result.results).toEqual([]);
  });

  it('should list files when query is empty', async () => {
    const result = await handler(db, { kind: 'file', query: '' });
    expect(result.results.length).toBe(3);
  });

  it('should list files filtered by branch when query is empty', async () => {
    const result = await handler(db, { kind: 'file', query: '', branch: 'main' });
    expect(result.results.length).toBe(2);
  });
});

describe('lookup toolDef', () => {
  it('should expose lore_lookup with required fields and optional lookup controls', () => {
    expect(toolDef.name).toBe('lore_lookup');
    expect(toolDef.inputSchema.required).toEqual(['kind', 'query']);
    expect(toolDef.inputSchema.properties.kind.enum).toEqual(['symbol', 'file']);
    expect(toolDef.inputSchema.properties.query.type).toBe('string');
    expect(toolDef.inputSchema.properties.mode.enum).toEqual(['exact', 'semantic', 'fused']);
    expect(toolDef.inputSchema.properties.match_mode.enum).toEqual(['exact', 'prefix', 'contains']);
    expect(toolDef.inputSchema.properties.symbol_kind.type).toBe('string');
    expect(toolDef.inputSchema.properties.path_prefix.type).toBe('string');
    expect(toolDef.inputSchema.properties.language.type).toBe('string');
    expect(toolDef.inputSchema.properties.limit.type).toBe('integer');
    expect(toolDef.inputSchema.properties.offset.type).toBe('integer');
  });
});
